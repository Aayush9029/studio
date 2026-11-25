import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronRight, Link2, LoaderCircle } from "lucide-react";
import type { AutoUnloadMinutes, FamilyId, ModelFamilyStatus, ModelScan, ScannedModelFile, Telemetry } from "../../shared/contract";
import { AUTO_UNLOAD_OPTIONS, FAMILIES, FAMILY_ORDER, ROLE_LABEL, offlineFamilyStatus, staticFamily } from "../../shared/families";
import { enginePhase, useEngineStore } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { useUiStore } from "../../stores/ui";
import { engineHttp, toStudioError } from "../../lib/engine/http";
import { whisperError } from "../../lib/errors";
import { clamp01 } from "../../lib/math";
import { basename, formatBytes, formatCount, formatExactBytes, formatMemPair, formatParams, formatRelative, hasVram, mbToGb, middleEllipsis } from "../../lib/format";
import { studio } from "../../lib/studio";
import { useConfirm } from "../../lib/useConfirm";
import { Drawer } from "../ui/Drawer";
import { Pill } from "../ui/Pill";
import { Segmented } from "../ui/Segmented";
import { StateBadge } from "../ui/misc";
import { Tooltip } from "../ui/Tooltip";

/* Session cache of `studio-core scan-models` facts. */
let scanCache: Promise<ModelScan | null> | null = null;
function scanModels(): Promise<ModelScan | null> {
  if (!scanCache) scanCache = studio.core.scanModels().catch(() => null);
  return scanCache;
}

export function ModelsDrawer() {
  const open = useUiStore((s) => s.modelsDrawerOpen);
  const close = useUiStore((s) => s.closeModels);
  return (
    <Drawer open={open} onClose={close} width="var(--drawer-w)" ariaLabel="Models & Memory" title={<h2 className="t-title m-0 text-ink">Models &amp; Memory</h2>} footer={open ? <DrawerFooter /> : null}>
      {open && <DrawerBody />}
    </Drawer>
  );
}

function DrawerBody() {
  const models = useEngineStore((s) => s.models);
  const phase = useEngineStore((s) => enginePhase(s));
  const expandFamily = useUiStore((s) => s.expandFamily);
  const [scan, setScan] = useState<ModelScan | null>(null);
  const [coreTelemetry, setCoreTelemetry] = useState<Telemetry | null>(null);
  const online = phase === "ready";

  useEffect(() => {
    let alive = true;
    void scanModels().then((s) => alive && setScan(s));
    if (online) {
      engineHttp
        .models()
        .then((m) => useEngineStore.getState().setModels(m))
        .catch(() => {});
    } else {
      studio.core
        .telemetry()
        .then((t) => alive && setCoreTelemetry(t))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [online]);

  const scanned = useMemo(() => {
    if (!scan) return null;
    const m = new Map<string, ScannedModelFile>();
    for (const f of scan.files) m.set(f.relPath, f);
    return m;
  }, [scan]);

  const families: ModelFamilyStatus[] = useMemo(() => {
    if (online && models?.length) return FAMILY_ORDER.map((id) => models.find((m) => m.id === id) ?? offlineFamilyStatus(id, scanned ?? undefined));
    return FAMILY_ORDER.map((id) => offlineFamilyStatus(id, scanned ?? undefined));
  }, [online, models, scanned]);

  const warmFamilies = useMemo(() => (online ? families.filter((f) => f.state === "warm") : NO_FAMILIES), [online, families]);

  return (
    <div className="flex flex-col gap-6 pt-2">
      <TelemetryBars online={online} coreTelemetry={coreTelemetry} warm={warmFamilies} />
      <div className="flex flex-col">
        {families.map((f, i) => (
          <FamilyCard key={f.id} family={f} scanned={scanned} online={online} first={i === 0} defaultOpen={expandFamily === f.id} />
        ))}
      </div>
    </div>
  );
}

const NO_FAMILIES: ModelFamilyStatus[] = [];

/** The only part of the drawer that subscribes to telemetry, so family cards don't re-render on every tick. */
function TelemetryBars({ online, coreTelemetry, warm }: { online: boolean; coreTelemetry: Telemetry | null; warm: ModelFamilyStatus[] }) {
  const engineTelemetry = useEngineStore((s) => s.telemetry);
  const telemetry = online ? engineTelemetry : (coreTelemetry ?? engineTelemetry);
  return <MemoryBars telemetry={telemetry} warm={warm} />;
}

/** A memory-bar segment spanning [start, start + len) of the track (fractions), positioned and
    sized with a compositor-only transform so telemetry updates never re-layout the drawer. */
function barStyle(start: number, len: number): CSSProperties {
  return {
    transform: `translateX(${clamp01(start) * 100}%) scaleX(${clamp01(len)})`,
    transformOrigin: "left center",
    transition: "transform 400ms linear",
  };
}

function MemoryBars({ telemetry, warm }: { telemetry: Telemetry | null; warm: ModelFamilyStatus[] }) {
  const t = telemetry;
  // Nullish/zero VRAM counters at runtime mean "unavailable", not "0 GB".
  const vramOk = hasVram(t);
  const vTotal = vramOk ? t!.vramTotalMb : 0;
  const vUsed = vramOk ? Math.max(0, t!.vramUsedMb) : 0;
  const rTotal = t?.ramTotalMb ?? 0;
  const rUsed = t?.ramUsedMb ?? 0;
  let acc = 0;
  const segs = warm.map((f, i) => {
    const mb = Math.min(f.vramEstimateMb, Math.max(0, vUsed - acc));
    const start = acc;
    acc += mb;
    return { id: f.id, label: f.label, mb, start, alt: i % 2 === 1 };
  });
  const other = Math.max(0, vUsed - acc);
  const hotV = vTotal > 0 && vUsed / vTotal > 0.9;
  const hotR = rTotal > 0 && rUsed / rTotal > 0.9;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="t-ui w-[104px] shrink-0 text-ink-2">GPU memory</span>
        <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
          {vTotal > 0 &&
            (segs.length ? (
              <>
                {segs.map((s) => (
                  <Tooltip key={s.id} label={`${s.label} · ${mbToGb(s.mb)} GB (estimate)`} className="pointer-events-none absolute inset-0">
                    <span
                      className="pointer-events-auto absolute inset-0"
                      style={{
                        ...barStyle(s.start / vTotal, s.mb / vTotal),
                        background: hotV ? "var(--warn)" : "var(--accent)",
                        opacity: s.alt ? 0.7 : 1,
                      }}
                    />
                  </Tooltip>
                ))}
                <span className="absolute inset-0 bg-ink-4" style={barStyle(acc / vTotal, other / vTotal)} />
              </>
            ) : (
              <span className="absolute inset-0" style={{ ...barStyle(0, vUsed / vTotal), background: hotV ? "var(--warn)" : "var(--accent)" }} />
            ))}
        </div>
        <span className="mono-lg w-[120px] shrink-0 text-right text-ink">{vramOk ? formatMemPair(vUsed, vTotal) : "—"}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="t-ui w-[104px] shrink-0 text-ink-2">System memory</span>
        <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
          {rTotal > 0 && (
            <span className="absolute inset-0" style={{ ...barStyle(0, rUsed / rTotal), background: hotR ? "var(--warn)" : "var(--text-secondary)" }} />
          )}
        </div>
        <span className="mono-lg w-[120px] shrink-0 text-right text-ink">{t ? formatMemPair(rUsed, rTotal) : "—"}</span>
      </div>
    </div>
  );
}

/** Drawer card titles use the static family label (keeps the "3D ·" prefix). */
const STATIC_LABEL = new Map<FamilyId, string>(FAMILIES.map((f) => [f.id, f.label]));

function FamilyCard({
  family,
  scanned,
  online,
  first,
  defaultOpen,
}: {
  family: ModelFamilyStatus;
  scanned: Map<string, ScannedModelFile> | null;
  online: boolean;
  first: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [pending, setPending] = useState(false);
  const busy = useJobStore((s) => !!s.active);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const missing = family.files.some((f) => !f.exists);
  const st = family.state;
  const transitional = st === "warming" || st === "unloading" || pending;
  const used = formatRelative(family.lastUsedAt);

  const act = async () => {
    setPending(true);
    try {
      if (st === "warm") await engineHttp.unload({ family: family.id });
      else await engineHttp.warmup({ family: family.id });
    } catch (e) {
      whisperError(toStudioError(e), family.id);
    } finally {
      setPending(false);
    }
  };

  const disabledReason = !online ? "Engine is not running" : busy ? "Busy generating" : missing && st !== "warm" ? "A model file is missing" : null;
  const actionLabel = st === "warm" ? "Unload" : "Warm up";

  return (
    <section className={`flex flex-col gap-1.5 py-4 ${first ? "" : "border-t border-hairline"}`}>
      <div className="flex items-center gap-3">
        <h3 className="t-heading m-0 min-w-0 flex-1 truncate text-ink">{STATIC_LABEL.get(family.id) ?? family.label}</h3>
        <StateBadge state={st} />
        {transitional ? (
          <Pill disabled aria-label={st === "unloading" ? "Unloading" : "Warming"}>
            <LoaderCircle size={14} strokeWidth={1.75} absoluteStrokeWidth className="anim-spin" />
          </Pill>
        ) : disabledReason ? (
          <Tooltip label={disabledReason} side="left">
            <Pill disabled>{actionLabel}</Pill>
          </Tooltip>
        ) : (
          <Pill onClick={act}>{actionLabel}</Pill>
        )}
      </div>
      <Tooltip label={formatExactBytes(family.diskBytes)} side="bottom" className="self-start">
        <span className="mono-sm text-ink-3">
          {formatBytes(family.diskBytes)} on disk · {family.files.length} {family.files.length === 1 ? "file" : "files"}
          {used ? ` · used ${used}` : ""}
        </span>
      </Tooltip>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="t-caption -ml-1 flex w-fit items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <ChevronRight size={12} strokeWidth={1.75} absoluteStrokeWidth style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out)" }} />
        files
      </button>
      {open && (
        <ul className="anim-enter m-0 mt-1 flex list-none flex-col gap-2.5 p-0">
          {family.files.map((f) => {
            const facts = scanned?.get(f.relPath);
            const h = facts?.header;
            const meta = h?.metadata ?? {};
            const extra = [meta["modelspec.architecture"], meta["modelspec.title"]].filter(Boolean).join(" · ");
            return (
              <li key={f.relPath} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="t-caption w-[104px] shrink-0 text-ink-2">{ROLE_LABEL[f.role]}</span>
                  <Tooltip label={f.relPath} className="min-w-0 flex-1">
                    <span className="mono-sm block truncate text-ink">{middleEllipsis(basename(f.relPath), 36)}</span>
                  </Tooltip>
                  {f.sharedWith.length > 0 && (
                    <Tooltip label={`Shared with ${f.sharedWith.map((id) => staticFamily(id).label).join(", ")}`}>
                      <Link2 size={12} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0 text-ink-3" aria-label="Shared file" />
                    </Tooltip>
                  )}
                  {f.exists ? (
                    <Tooltip label={formatExactBytes(f.bytes)} side="left">
                      <span className="mono-sm shrink-0 text-ink-3">{formatBytes(f.bytes)}</span>
                    </Tooltip>
                  ) : (
                    <span className="t-caption shrink-0 text-danger">Missing</span>
                  )}
                </div>
                {h && (
                  <span className="mono-sm pl-[112px] text-ink-3">
                    {h.primaryDtype} · {formatCount(h.tensorCount)} tensors · {formatParams(h.parameterCount)}
                    {extra ? ` · ${extra}` : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DrawerFooter() {
  const phase = useEngineStore((s) => enginePhase(s));
  const busy = useJobStore((s) => !!s.active);
  const online = phase === "ready";
  const [minutes, setMinutes] = useState<AutoUnloadMinutes>(10);
  const { armed, press } = useConfirm(3000);

  useEffect(() => {
    if (!online) return;
    engineHttp
      .getSettings()
      .then((s) => setMinutes(s.autoUnloadMinutes))
      .catch(() => {});
  }, [online]);

  const change = (m: AutoUnloadMinutes) => {
    const prev = minutes;
    setMinutes(m);
    engineHttp.setSettings({ autoUnloadMinutes: m }).catch((e) => {
      setMinutes(prev);
      whisperError(toStudioError(e));
    });
  };

  const unloadAll = () =>
    press(() => {
      engineHttp.unload({ family: "all" }).catch((e) => whisperError(toStudioError(e)));
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="t-ui text-ink-2">Auto-unload idle</span>
        <Segmented<AutoUnloadMinutes>
          ariaLabel="Auto-unload idle models"
          mono
          disabled={!online}
          value={minutes}
          onChange={change}
          options={AUTO_UNLOAD_OPTIONS.map((m) => ({ value: m, label: m === 0 ? "Off" : `${m}m` }))}
        />
      </div>
      <div className="flex justify-end">
        <Pill tone={armed ? "danger-solid" : "danger"} disabled={!online || busy} onClick={unloadAll}>
          {armed ? "Unload all — confirm" : "Unload all models"}
        </Pill>
      </div>
    </div>
  );
}
