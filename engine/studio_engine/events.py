"""WebSocket broadcast hub (API_CONTRACT.md section 4).

* Text events get a strictly increasing ``seq`` assigned under one lock, and are
  appended to every client's queue inside that same lock, so all clients see
  the global order.
* Binary ``PREV`` frames are queued after their ``job.progress`` text event. When a
  client falls behind, older *pending* preview frames are dropped and only the
  newest is kept; priority frames (step 1 and the final step) are never dropped,
  and text events are never dropped.
* Thread-safe: ``emit`` / ``emit_with_preview`` may be called from any thread.
* Wake-ups are coalesced: a client's ``wake`` event is scheduled on the loop only on
  its ``wake_pending`` False -> True transition, so a burst of emissions costs one
  ``call_soon_threadsafe`` per client, not one per event.
* With no client connected, emissions only advance ``seq`` (no stamping / JSON).
* Reconnect snapshot: ``on_connect(register, context)`` is called with a ``register``
  callback and the result of the awaited ``connect_context()`` (if set). The owner builds the snapshot and calls ``register(events)`` while
  holding the same lock that serialises job start / terminal transitions, so a
  client can never receive a stale ``job.started`` replay after the job ended,
  nor miss the terminal event of a job it was told about.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import struct
import threading
import time

from aiohttp import web, WSMsgType

from .util import now_ms

log = logging.getLogger("studio.ws")

PING_INTERVAL_S = 20.0
PING_MISS_LIMIT_S = 2 * PING_INTERVAL_S + 5.0

# queue item kinds: "t" text, "b" droppable preview frame, "p" priority preview frame


class _Client:
    __slots__ = ("ws", "queue", "wake", "wake_pending", "closed", "last_pong", "pending_preview", "sending")

    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.queue: collections.deque = collections.deque()
        self.wake = asyncio.Event()
        self.wake_pending = False  # a wake.set is scheduled and the sender has not taken it yet (hub lock)
        self.closed = False
        self.last_pong = time.monotonic()
        self.pending_preview = 0  # droppable ("b") frames still queued
        self.sending = False      # an item has been popped and its send is in flight


class Hub:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self._lock = threading.Lock()
        self._seq = 0
        self._clients: list[_Client] = []
        self.closing = False
        # callable(register, context) -> None; must call ``register(list_of_events)`` exactly once
        self.on_connect = None
        # optional ``async () -> object`` awaited before ``on_connect`` (blocking queries off the loop)
        self.connect_context = None

    # ------------------------------------------------------------- emission
    @property
    def client_count(self) -> int:
        return len(self._clients)

    def _stamp(self, event: dict) -> str:
        self._seq += 1
        ev = dict(event)
        ev.setdefault("ts", now_ms())
        ev["seq"] = self._seq
        # keep type/ts/seq first for readability
        ordered = {"type": ev.pop("type"), "ts": ev.pop("ts"), "seq": ev.pop("seq")}
        ordered.update(ev)
        return json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))

    def emit(self, event: dict) -> None:
        with self._lock:
            if not self._clients:  # nobody listening: keep seq monotonic, skip stamping / JSON
                self._seq += 1
                return
            text = self._stamp(event)
            for c in self._clients:
                c.queue.append(("t", text))
            wake = self._mark_wake(self._clients)
        self._schedule_wake(wake)

    def emit_with_preview(self, event: dict, frame: bytes | None, priority: bool = False) -> None:
        """Emit a ``job.progress`` text event immediately followed by its binary frame.

        Ordinary frames replace any older ordinary frame still queued for a client
        (at most one droppable frame is pending per client); ``priority`` frames are
        always delivered.
        """
        with self._lock:
            if not self._clients:
                self._seq += 1
                return
            text = self._stamp(event)
            for c in self._clients:
                if frame is not None and not priority and c.pending_preview:
                    # back-pressure: drop this client's older pending droppable previews
                    c.queue = collections.deque(item for item in c.queue if item[0] != "b")
                    c.pending_preview = 0
                c.queue.append(("t", text))
                if frame is not None:
                    if priority:
                        c.queue.append(("p", frame))
                    else:
                        c.queue.append(("b", frame))
                        c.pending_preview += 1
            wake = self._mark_wake(self._clients)
        self._schedule_wake(wake)

    @staticmethod
    def _mark_wake(clients) -> list:
        """Under ``_lock``: clients whose wake-up is not already scheduled (False -> True)."""
        out = []
        for c in clients:
            if not c.wake_pending:
                c.wake_pending = True
                out.append(c)
        return out

    def _schedule_wake(self, clients: list) -> None:
        """Outside ``_lock``: hand the wake-ups to the event loop (thread-safe)."""
        for c in clients:
            try:
                self.loop.call_soon_threadsafe(c.wake.set)
            except RuntimeError:  # loop closed
                pass

    @staticmethod
    def preview_frame(step: int, total_steps: int, stage_index: int, jpeg: bytes) -> bytes:
        return struct.pack("<4sIII", b"PREV", step, total_steps, stage_index) + jpeg

    # ------------------------------------------------------------- connection
    async def handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(autoping=False, max_msg_size=1 << 20, compress=False)
        await ws.prepare(request)
        if self.closing:
            await ws.close(code=1001, message=b"shutting down")
            return ws
        client = _Client(ws)

        def register(initial: list[dict]) -> None:
            # snapshot + subscription in one step: everything emitted after this point is
            # queued after the snapshot, and nothing emitted before it is replayed stale
            with self._lock:
                for ev in initial:
                    client.queue.append(("t", self._stamp(ev)))
                self._clients.append(client)

        context = None
        if self.connect_context is not None:
            try:
                context = await self.connect_context()
            except Exception as e:  # the snapshot falls back to a direct query
                log.debug("ws connect context: %s", e)
            if self.closing:  # close_all ran while we awaited: it cannot know this client
                await ws.close(code=1001, message=b"shutting down")
                return ws
        if self.on_connect is not None:
            self.on_connect(register, context)
        else:
            register([])
        client.wake.set()
        sender = asyncio.ensure_future(self._sender(client))
        pinger = asyncio.ensure_future(self._pinger(client))
        try:
            async for msg in ws:
                if msg.type == WSMsgType.PING:
                    await ws.pong(msg.data)
                elif msg.type == WSMsgType.PONG:
                    client.last_pong = time.monotonic()
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR):
                    break
                # text/binary frames from clients are ignored
        except Exception as e:  # pragma: no cover
            log.debug("ws receive error: %s", e)
        finally:
            client.closed = True
            client.wake.set()
            with self._lock:
                if client in self._clients:
                    self._clients.remove(client)
                client.queue.clear()
            pinger.cancel()
            try:
                await asyncio.wait_for(sender, timeout=1.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                sender.cancel()
            if not ws.closed:
                await ws.close()
        return ws

    async def _sender(self, client: _Client) -> None:
        ws = client.ws
        while not client.closed:
            await client.wake.wait()
            client.wake.clear()
            with self._lock:
                # items queued from now on schedule a new wake-up; everything queued before is
                # drained by the loop below
                client.wake_pending = False
            while True:
                with self._lock:
                    if not client.queue:
                        client.sending = False
                        break
                    kind, payload = client.queue.popleft()
                    if kind == "b":
                        client.pending_preview = max(0, client.pending_preview - 1)
                    client.sending = True
                try:
                    if ws.closed:
                        return
                    if kind == "t":
                        await ws.send_str(payload)
                    else:
                        await ws.send_bytes(payload)
                except Exception as e:
                    log.debug("ws send failed: %s", e)
                    client.closed = True
                    return
                finally:
                    client.sending = False
                    payload = None

    async def _pinger(self, client: _Client) -> None:
        try:
            while not client.closed:
                await asyncio.sleep(PING_INTERVAL_S)
                if time.monotonic() - client.last_pong > PING_MISS_LIMIT_S:
                    log.info("ws client missed two pings; dropping")
                    await client.ws.close(code=1001, message=b"ping timeout")
                    return
                try:
                    await client.ws.ping()
                except Exception:
                    return
        except asyncio.CancelledError:
            pass

    async def close_all(self, code: int = 1001, drain_timeout: float = 2.0) -> None:
        """Stop accepting clients, deliver every queued text event (e.g. ``job.cancelled``)
        to each client, then close the sockets. Queued preview frames are discarded first
        so they cannot delay the terminal events behind them. Idempotent."""
        self.closing = True
        with self._lock:
            clients = list(self._clients)
            for c in clients:
                if any(item[0] != "t" for item in c.queue):
                    c.queue = collections.deque(item for item in c.queue if item[0] == "t")
                c.pending_preview = 0
                c.wake_pending = False
        for c in clients:  # already on the loop thread
            c.wake.set()
        deadline = time.monotonic() + drain_timeout
        for c in clients:
            while not c.closed and not c.ws.closed and time.monotonic() < deadline:
                with self._lock:
                    busy = bool(c.queue) or c.sending
                if not busy:
                    break
                c.wake.set()
                await asyncio.sleep(0.01)
            with self._lock:
                left = len(c.queue)
            if left and not c.closed:
                log.warning("closing ws client with %d undelivered events", left)
            c.closed = True
            c.wake.set()
            try:
                await c.ws.close(code=code, message=b"shutting down")
            except Exception:
                pass
