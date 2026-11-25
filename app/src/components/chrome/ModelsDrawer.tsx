import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Copy, FolderOpen, Link2, LoaderCircle } from "lucide-react";
import type { AutoUnloadMinutes, FamilyId, ModelFamilyStatus, ModelScan, ScannedModelFile, Telemetry } from "../../shared/contract";
import { AUTO_UNLOAD_OPTIONS, FAMILIES, FAMILY_ORDER, ROLE_LABEL, offlineFamilyStatus, staticFamily } from "../../shared/families";
import { enginePhase, useEngineStore, type TelemetrySample } from "../../stores/engine";
import { useJobStore, type ActiveJob } from "../../stores/job";
import { useUiStore } from "../../stores/ui";
import { engineHttp, toStudioError } from "../../lib/engine/http";
import { copyText } from "../../lib/actions";
import { whisperError } from "../../lib/errors";
import { basename, formatBytes, formatCount, formatExactBytes, formatMemPair, formatParams, formatRelative, hasVram, middleEllipsis } from "../../lib/format";
import { studio } from "../../lib/studio";
import { useConfirm } from "../../lib/useConfirm";
import { Drawer } from "../ui/Drawer";
import { Menu } from "../ui/Menu";
import { Pill } from "../ui/Pill";
import { Segmented } from "../ui/Segmented";
import { SquareMeterGraph } from "../ui/SquareMeterGraph";
import { StateBadge } from "../ui/misc";
import { Tooltip } from "../ui/Tooltip";

let scanCache: Promise<ModelScan | null> | null = null;
function scanModels(): Promise<ModelScan | null> {
  if (!scanCache) scanCache = studio.core.scanModels().catch(() => null);
  return scanCache;
}

function isFamilyRunning(id: FamilyId, active: ActiveJob | null): boolean {
  if (!active) return false;
  if (active.model === id) return true;
  const stageId = active.stages[active.stageIndex]?.id;
  if (id === "birefnet" && (active.mode === "remove_bg" || (active.kind === "3d" && stageId === "cutout"))) return true;
  if (id === "z_image" && active.mode === "t23d" && stageId === "source") return true;
  return false;
}

export function ModelsDrawer() {
  const open = useUiStore((s) => s.modelsDrawerOpen);
  const close = useUiStore((s) => s.closeModels);
  const active = useJobStore((s) => s.active);

  return (
    <Drawer
      open={open}
      onClose={close}
      width="var(--drawer-w)"
      ariaLabel="Models & Memory"
      title={<h2 className="t-title m-0 text-ink">Models &amp; Memory</h2>}
      headerExtra={
        active ? (
          <span className="t-caption inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-accent">
            <LoaderCircle size={12} strokeWidth={2} className="anim-spin" />
            <span>{active.phase === "sampling" && active.totalSteps > 0 ? `${active.step}/${active.totalSteps}` : "Running"}</span>
          </span>
        ) : undefined
      }
      footer={open ? <DrawerFooter /> : null}
    >
      {open && <DrawerBody />}
    </Drawer>
  );
}

function DrawerBody() {
  const models = useEngineStore((s) => s.models);
  const modelsDir = useEngineStore((s) => s.health?.modelsDir);
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
    <div className="flex flex-col gap-5 pt-2">
      <TelemetryBars online={online} coreTelemetry={coreTelemetry} warm={warmFamilies} modelsDir={modelsDir} />
      <div className="flex flex-col">
        {families.map((f, i) => (
          <FamilyCard key={f.id} family={f} scanned={scanned} modelsDir={modelsDir} online={online} first={i === 0} defaultOpen={expandFamily === f.id} />
        ))}
      </div>
    </div>
  );
}

const NO_FAMILIES: ModelFamilyStatus[] = [];

function TelemetryBars({
  online,
  coreTelemetry,
  warm,
  modelsDir,
}: {
  online: boolean;
  coreTelemetry: Telemetry | null;
  warm: ModelFamilyStatus[];
  modelsDir?: string;
}) {
  const engineTelemetry = useEngineStore((s) => s.telemetry);
  const history = useEngineStore((s) => s.history);
  const healthModelsDir = useEngineStore((s) => s.health?.modelsDir);
  const telemetry = online ? engineTelemetry : (coreTelemetry ?? engineTelemetry);
  return <MemoryGraphs telemetry={telemetry} history={history} warm={warm} modelsDir={modelsDir ?? healthModelsDir} />;
}

function MemoryGraphs({
  telemetry,
  history,
  warm,
  modelsDir,
}: {
  telemetry: Telemetry | null;
  history: TelemetrySample[];
  warm: ModelFamilyStatus[];
  modelsDir?: string;
}) {
  const t = telemetry;
  const vramOk = hasVram(t);
  const vTotal = vramOk ? t!.vramTotalMb : 0;
  const vUsed = vramOk ? Math.max(0, t!.vramUsedMb) : 0;
  const rTotal = t?.ramTotalMb ?? 0;
  const rUsed = t?.ramUsedMb ?? 0;
  const cpuRaw = t?.cpuUtilPct;
  const cpuPct = cpuRaw != null && Number.isFinite(cpuRaw) ? Math.round(cpuRaw) : null;

  const vramSamples = history.length ? history.map((h) => h.vramPct) : vTotal > 0 ? [(vUsed / vTotal) * 100] : [];
  const ramSamples = history.length ? history.map((h) => h.ramPct) : rTotal > 0 ? [(rUsed / rTotal) * 100] : [];
  const cpuSamples = history.length ? history.map((h) => h.cpuPct) : cpuPct != null ? [cpuPct] : [];

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className="flex flex-col gap-3 rounded-[var(--r-md)] bg-sunken p-3"
      onContextMenu={(e) => {
        if (!modelsDir) return;
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="t-ui text-ink-2">GPU memory</span>
          <span className="mono-sm text-ink">{vramOk ? formatMemPair(vUsed, vTotal) : "—"}</span>
        </div>
        <SquareMeterGraph samples={vramSamples} cols={36} rows={5} cellSize={6} gap={3} color="var(--accent)" ariaLabel="GPU memory history" className="w-full" />
        {warm.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            {warm.map((f) => (
              <span key={f.id} className="t-caption text-ink-3">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
                {staticFamily(f.id).label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-hairline pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="t-ui text-ink-2">System RAM</span>
          <span className="mono-sm text-ink">{t ? formatMemPair(rUsed, rTotal) : "—"}</span>
        </div>
        <SquareMeterGraph samples={ramSamples} cols={36} rows={5} cellSize={6} gap={3} color="var(--text-secondary)" ariaLabel="System RAM history" className="w-full" />
      </div>

      <div className="flex flex-col gap-1.5 border-t border-hairline pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="t-ui text-ink-2">CPU usage</span>
          <span className="mono-sm text-ink">{cpuPct != null ? `${cpuPct}%` : "—"}</span>
        </div>
        <SquareMeterGraph samples={cpuSamples} cols={36} rows={5} cellSize={6} gap={3} color="var(--sage)" ariaLabel="CPU usage history" className="w-full" />
      </div>

      <Menu
        open={!!ctxMenu}
        onClose={() => setCtxMenu(null)}
        anchor={ctxMenu ?? { x: 0, y: 0 }}
        ariaLabel="Telemetry options"
        items={
          modelsDir
            ? [{ id: "models-dir", icon: FolderOpen, label: "Open models folder", onSelect: () => void studio.files.reveal(modelsDir).catch(() => {}) }]
            : []
        }
      />
    </div>
  );
}

const STATIC_LABEL = new Map<FamilyId, string>(FAMILIES.map((f) => [f.id, f.label]));

function FamilyCard({
  family,
  scanned,
  modelsDir,
  online,
  first,
  defaultOpen,
}: {
  family: ModelFamilyStatus;
  scanned: Map<string, ScannedModelFile> | null;
  modelsDir?: string;
  online: boolean;
  first: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [pending, setPending] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; file?: ModelFamilyStatus["files"][number] } | null>(null);
  const active = useJobStore((s) => s.active);
  const busy = !!active;
  const running = isFamilyRunning(family.id, active);

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

  const firstExisting = family.files.find((f) => f.exists)?.path ?? modelsDir ?? null;
  const disabledReason = !online ? "Engine is not running" : busy ? "Busy generating" : missing && st !== "warm" ? "A model file is missing" : null;
  const actionLabel = st === "warm" ? "Unload" : "Warm up";

  return (
    <section
      className={`flex flex-col gap-1.5 py-4 ${first ? "" : "border-t border-hairline"}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex items-center gap-3">
        <h3 className="t-heading m-0 min-w-0 flex-1 truncate text-ink">{STATIC_LABEL.get(family.id) ?? family.label}</h3>
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-accent">
            <LoaderCircle size={12} strokeWidth={2} className="anim-spin" />
            <span className="t-caption">
              Running{active?.phase === "sampling" && active.totalSteps > 0 ? ` · ${active.step}/${active.totalSteps}` : ""}
            </span>
          </span>
        ) : (
          <StateBadge state={st} />
        )}
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
              <li
                key={f.relPath}
                className="flex flex-col gap-0.5 rounded-[var(--r-sm)] px-1 py-0.5 hover:bg-hover"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, file: f });
                }}
              >
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
      <Menu
        open={!!ctx}
        onClose={() => setCtx(null)}
        anchor={ctx ? { x: ctx.x, y: ctx.y } : { x: 0, y: 0 }}
        ariaLabel="Model options"
        items={
          ctx?.file
            ? [
                {
                  id: "reveal-file",
                  icon: FolderOpen,
                  label: "Open folder in Explorer",
                  disabled: !ctx.file.exists,
                  onSelect: () => void studio.files.reveal(ctx.file!.path).catch(() => {}),
                },
                { id: "copy-file", icon: Copy, label: "Copy path", onSelect: () => void copyText(ctx.file!.path, "Path copied") },
              ]
            : [
                ...(online && !busy && !(missing && st !== "warm")
                  ? [{ id: "toggle", label: actionLabel, onSelect: () => void act() }]
                  : []),
                ...(firstExisting
                  ? [{ id: "reveal-folder", icon: FolderOpen, label: "Open folder in Explorer", onSelect: () => void studio.files.reveal(firstExisting).catch(() => {}) }]
                  : []),
              ]
        }
      />
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
