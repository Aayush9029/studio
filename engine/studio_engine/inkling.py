"""Inkling (OpenAI-compatible local LLM) - prompt enhancement and availability probe."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.request

log = logging.getLogger("studio.inkling")

SYSTEM_PROMPTS = {
    "photo": (
        "You write prompts for a photorealistic text-to-image model. "
        "Expand the user's idea into one detailed prompt: subject, appearance, pose, clothing, setting, "
        "lighting, camera and lens. Reply with the prompt only, in one paragraph, with no preamble."
    ),
    "3d": (
        "You write prompts for a text-to-image model whose output becomes a 3D model. "
        "Expand the user's idea into one detailed prompt for a single subject, shown whole and centered, "
        "full body if it is a character, in a neutral three-quarter view, on a plain white background, "
        "with soft even studio lighting, no cropping, no other objects and no ground shadow. "
        "Describe shape, materials, colors and surface details. "
        "Reply with the prompt only, in one paragraph, with no preamble."
    ),
    "edit": (
        "You rewrite image-editing instructions for an instruction-following image editor. "
        "Restate the user's requested change as one clear, specific instruction. Keep exactly the changes the "
        "user asked for; do not invent new changes, subjects or styles. Mention what must stay the same when it "
        "matters. Reply with the instruction only, in one or two sentences, with no preamble."
    ),
}

ENHANCE_TIMEOUT_S = 20.0
MAX_PROMPT_CHARS = 1200

_THINK = re.compile(r"<\s*(think|thinking|reasoning)\s*>.*?<\s*/\s*\1\s*>", re.S | re.I)
_OPEN_THINK = re.compile(r"^.*?<\s*/\s*(think|thinking|reasoning)\s*>", re.S | re.I)
_LABEL = re.compile(r"^\s*(?:\*\*)?(?:enhanced\s+)?(?:prompt|instruction|edit instruction|answer|output)(?:\*\*)?\s*[:\-–]\s*", re.I)


def clean_llm_text(text: str) -> str:
    text = _THINK.sub("", text or "")
    text = _OPEN_THINK.sub("", text)
    text = text.strip()
    text = _LABEL.sub("", text).strip()
    # drop wrapping quotes / backticks
    for _ in range(2):
        if len(text) >= 2 and text[0] in "\"'“”‘’`" and text[-1] in "\"'“”‘’`":
            text = text[1:-1].strip()
    text = text.strip("`").strip()
    text = re.sub(r"\s*\n\s*\n\s*", "\n", text)
    if len(text) > MAX_PROMPT_CHARS:
        cut = text[:MAX_PROMPT_CHARS]
        sp = cut.rfind(" ")
        text = cut[:sp] if sp > MAX_PROMPT_CHARS * 0.8 else cut
    return text.strip()


def _body(model: str, style: str, idea: str) -> bytes:
    return json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPTS[style]}, {"role": "user", "content": idea}],
        "temperature": 0.7,
        "max_tokens": 320,
        "stream": False,
    }).encode("utf-8")


def _extract(payload: dict) -> str:
    try:
        msg = payload["choices"][0]["message"]
        return msg.get("content") or ""
    except (KeyError, IndexError, TypeError):
        return ""


class Inkling:
    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._available = False
        self._checked = 0.0
        self._checking: asyncio.Task | None = None

    # ------------------------------------------------------------ availability
    async def _probe(self, session) -> bool:
        import aiohttp
        try:
            async with session.get(self.base_url + "/models", timeout=aiohttp.ClientTimeout(total=0.4)) as r:
                ok = r.status == 200
                if ok:
                    await r.read()
                return ok
        except Exception:
            return False

    async def refresh(self, session) -> bool:
        self._available = await self._probe(session)
        self._checked = time.monotonic()
        return self._available

    async def available(self, session) -> bool:
        if time.monotonic() - self._checked < 10.0:
            return self._available
        if self._checking is None or self._checking.done():
            self._checking = asyncio.ensure_future(self.refresh(session))
        try:
            return await asyncio.wait_for(asyncio.shield(self._checking), timeout=0.4)
        except asyncio.TimeoutError:
            return self._available

    # ------------------------------------------------------------ enhancement
    async def enhance_async(self, session, idea: str, style: str) -> tuple[str, bool]:
        import aiohttp
        try:
            async with session.post(self.base_url + "/chat/completions", data=_body(self.model, style, idea),
                                    headers={"Content-Type": "application/json"},
                                    timeout=aiohttp.ClientTimeout(total=ENHANCE_TIMEOUT_S)) as r:
                if r.status != 200:
                    return idea, False
                text = clean_llm_text(_extract(await r.json(content_type=None)))
        except Exception as e:
            log.info("enhance failed: %s", e)
            return idea, False
        return (text, True) if text else (idea, False)

    def enhance_sync(self, idea: str, style: str) -> tuple[str, bool]:
        req = urllib.request.Request(self.base_url + "/chat/completions", data=_body(self.model, style, idea),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=ENHANCE_TIMEOUT_S) as r:
                text = clean_llm_text(_extract(json.load(r)))
        except Exception as e:
            log.info("enhance failed: %s", e)
            return idea, False
        return (text, True) if text else (idea, False)
