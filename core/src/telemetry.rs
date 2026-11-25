//! `telemetry` (API_CONTRACT.md §6.5).
//!
//! Sources: `GlobalMemoryStatusEx` (RAM), `GetSystemTimes` (CPU), DXGI adapter
//! descriptors (GPU name and dedicated/shared totals), PDH `GPU Adapter Memory`,
//! `GPU Process Memory` and `GPU Engine` counters (usage, per-process GPU memory,
//! utilisation) and `GetProcessMemoryInfo` (per-process RSS / private bytes).
//! Anything the OS cannot provide is `null`, never `0`.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::args::{multi, opt, FlagSpec, Parsed};
use crate::envelope::{CoreError, Outcome};

pub const SPEC: &[FlagSpec] = &[multi("--pid"), opt("--watch")];

/// Delay between the two samples a one-shot call needs for CPU and GPU utilisation.
const ONE_SHOT_SAMPLE_MS: u64 = 250;
pub const MIN_WATCH_MS: u64 = 250;

const MB: u64 = 1024 * 1024;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub dedicated_total_mb: Option<u64>,
    pub dedicated_used_mb: Option<u64>,
    pub shared_total_mb: Option<u64>,
    pub shared_used_mb: Option<u64>,
    pub util_pct: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub alive: bool,
    pub name: Option<String>,
    pub rss_mb: Option<u64>,
    pub private_mb: Option<u64>,
    pub gpu_dedicated_mb: Option<u64>,
    pub gpu_shared_mb: Option<u64>,
}

impl ProcessInfo {
    pub fn dead(pid: u32) -> Self {
        Self { pid, alive: false, name: None, rss_mb: None, private_mb: None, gpu_dedicated_mb: None, gpu_shared_mb: None }
    }
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreTelemetry {
    pub ts: i64,
    pub source: &'static str,
    pub vram_total_mb: Option<u64>,
    pub vram_used_mb: Option<u64>,
    pub vram_free_mb: Option<u64>,
    pub ram_total_mb: Option<u64>,
    pub ram_used_mb: Option<u64>,
    pub ram_free_mb: Option<u64>,
    pub cpu_util_pct: Option<f64>,
    pub gpu: GpuInfo,
    pub processes: Vec<ProcessInfo>,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn to_mb(bytes: u64) -> u64 {
    bytes / MB
}

/// `vram*` normalisation (§6.5): totals and usage are dedicated + shared; `null` if any part is unknown.
pub fn normalise_vram(g: &GpuInfo) -> (Option<u64>, Option<u64>, Option<u64>) {
    let total = match (g.dedicated_total_mb, g.shared_total_mb) {
        (Some(a), Some(b)) => Some(a + b),
        _ => None,
    };
    let used = match (g.dedicated_used_mb, g.shared_used_mb) {
        (Some(a), Some(b)) => Some(a + b),
        _ => None,
    };
    let free = match (total, used) {
        (Some(t), Some(u)) => Some(t.saturating_sub(u)),
        _ => None,
    };
    (total, used, free)
}

pub fn run(p: &Parsed, pretty: bool) -> Outcome {
    let mut pids: Vec<u32> = Vec::new();
    for raw in p.all("--pid") {
        match raw.parse::<u32>() {
            Ok(v) => pids.push(v),
            Err(_) => return Outcome::err(CoreError::usage(format!("invalid --pid '{raw}'"))),
        }
    }
    let watch = match p.parse_num::<u64>("--watch") {
        Ok(v) => v,
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    };
    if let Some(ms) = watch {
        if ms < MIN_WATCH_MS {
            return Outcome::err(CoreError::usage(format!("--watch must be at least {MIN_WATCH_MS} ms")));
        }
    }

    // `new` takes the first sample for the rate counters (CPU, GPU engine utilisation).
    let mut sampler = Sampler::new(!pids.is_empty());
    match watch {
        None => {
            std::thread::sleep(Duration::from_millis(ONE_SHOT_SAMPLE_MS));
            Outcome::ok(serde_json::to_value(sampler.sample(&pids)).expect("json"))
        }
        Some(ms) => {
            // Deadline-based so sampling and serialization time do not stretch the cadence.
            let period = Duration::from_millis(ms);
            let mut deadline = Instant::now() + period;
            loop {
                let now = Instant::now();
                if deadline > now {
                    std::thread::sleep(deadline - now);
                }
                let started = Instant::now();
                let sample = sampler.sample(&pids);
                let line =
                    crate::envelope::render_ok("telemetry", started.elapsed().as_secs_f64() * 1000.0, &sample, pretty);
                if !crate::envelope::write_line(&line) {
                    // stdout closed: the consumer went away.
                    std::process::exit(0);
                }
                // Keep the phase; skip (never burst through) ticks missed while stalled.
                let now = Instant::now();
                while deadline <= now {
                    deadline += period;
                }
            }
        }
    }
}

pub use imp::Sampler;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::OnceLock;
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        PDH_FMT, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA,
    };
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetSystemTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    const STILL_ACTIVE: u32 = 259;

    /// `STUDIO_CORE_DEBUG`, looked up once per process.
    fn debug_enabled() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var_os("STUDIO_CORE_DEBUG").is_some())
    }

    /// Logs only when debugging is on; the message is not even formatted otherwise.
    fn debug(msg: impl FnOnce() -> String) {
        if debug_enabled() {
            crate::log::info(&msg());
        }
    }
    const PDH_FMT_NOCAP100: PDH_FMT = PDH_FMT(0x0000_8000);

    #[derive(Debug, Clone)]
    struct Adapter {
        name: String,
        /// `luid_0xHHHHHHHH_0xLLLLLLLL` as used in PDH instance names (lower-case).
        luid_tag: String,
        dedicated_total: u64,
        shared_total: u64,
    }

    struct Pdh {
        query: isize,
        adapter_dedicated: isize,
        adapter_shared: isize,
        /// `0` (not registered) when no `--pid` was given.
        process_dedicated: isize,
        process_shared: isize,
        engine_util: isize,
        /// Item buffer reused across reads and ticks; grown only on `PDH_MORE_DATA`.
        scratch: Vec<PDH_FMT_COUNTERVALUE_ITEM_W>,
        /// Reused lower-cased instance name.
        name: String,
    }

    impl Drop for Pdh {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    impl Pdh {
        /// Opens the query; per-process GPU memory counters only when `processes` is set.
        fn open(processes: bool) -> Option<Pdh> {
            unsafe {
                let mut q: isize = 0;
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                    return None;
                }
                let add = |path: PCWSTR| -> isize {
                    let mut c: isize = 0;
                    let rc = PdhAddEnglishCounterW(q, path, 0, &mut c);
                    if rc == 0 {
                        c
                    } else {
                        debug(|| format!("PdhAddEnglishCounterW({}) rc=0x{rc:08x}", path.to_string().unwrap_or_default()));
                        0
                    }
                };
                let pdh = Pdh {
                    query: q,
                    adapter_dedicated: add(w!("\\GPU Adapter Memory(*)\\Dedicated Usage")),
                    adapter_shared: add(w!("\\GPU Adapter Memory(*)\\Shared Usage")),
                    process_dedicated: if processes { add(w!("\\GPU Process Memory(*)\\Dedicated Usage")) } else { 0 },
                    process_shared: if processes { add(w!("\\GPU Process Memory(*)\\Shared Usage")) } else { 0 },
                    engine_util: add(w!("\\GPU Engine(*)\\Utilization Percentage")),
                    scratch: Vec::new(),
                    name: String::new(),
                };
                Some(pdh)
            }
        }

        fn collect(&self) {
            let rc = unsafe { PdhCollectQueryData(self.query) };
            if rc != 0 {
                // PDH_NO_DATA / partial failures still leave the other counters readable.
                debug(|| format!("PdhCollectQueryData rc=0x{rc:08x}"));
            }
        }

        /// Calls `f(instance, value)` for every valid item of a wildcard counter. The instance
        /// name is ASCII-lower-cased into a reused buffer, so a tick allocates nothing per item.
        /// Does nothing when the counter is unavailable.
        fn for_each(&mut self, counter: isize, mut f: impl FnMut(&str, f64)) {
            if counter == 0 {
                return;
            }
            let fmt = PDH_FMT(PDH_FMT_DOUBLE.0 | PDH_FMT_NOCAP100.0);
            let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
            let mut count: u32 = 0;
            let mut rc;
            let mut attempts = 0;
            loop {
                // In: the buffer size in bytes; out: the size required.
                let mut size = (self.scratch.len() * item_size) as u32;
                let buf = if self.scratch.is_empty() { None } else { Some(self.scratch.as_mut_ptr()) };
                rc = unsafe { PdhGetFormattedCounterArrayW(counter, fmt, &mut size, &mut count, buf) };
                if rc != PDH_MORE_DATA || attempts == 2 {
                    break;
                }
                attempts += 1;
                // The buffer holds the items followed by their name strings.
                let words = (size as usize).div_ceil(item_size) + 1;
                self.scratch.resize(words, unsafe { std::mem::zeroed() });
            }
            if rc != 0 {
                debug(|| format!("PdhGetFormattedCounterArrayW rc=0x{rc:08x}"));
                return;
            }
            let Pdh { scratch, name, .. } = self;
            let n = (count as usize).min(scratch.len());
            for item in &scratch[..n] {
                // CStatus: PDH_CSTATUS_VALID_DATA (0) or PDH_CSTATUS_NEW_DATA (1).
                if item.FmtValue.CStatus > 1 {
                    debug(|| format!("PDH item status 0x{:08x}", item.FmtValue.CStatus));
                    continue;
                }
                name.clear();
                if !item.szName.is_null() {
                    // SAFETY: `szName` points at a NUL-terminated string inside `scratch`.
                    let wide = unsafe { item.szName.as_wide() };
                    name.extend(
                        char::decode_utf16(wide.iter().copied())
                            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER).to_ascii_lowercase()),
                    );
                }
                f(name, unsafe { item.FmtValue.Anonymous.doubleValue });
            }
        }
    }

    #[derive(Clone, Copy)]
    struct CpuTimes {
        idle: u64,
        kernel: u64,
        user: u64,
    }

    fn ft(f: FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    fn cpu_times() -> Option<CpuTimes> {
        let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetSystemTimes(Some(&mut i), Some(&mut k), Some(&mut u)).ok()? };
        Some(CpuTimes { idle: ft(i), kernel: ft(k), user: ft(u) })
    }

    fn adapters() -> Vec<Adapter> {
        let mut out = Vec::new();
        let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
            return out;
        };
        let mut i = 0;
        while let Ok(a) = unsafe { factory.EnumAdapters1(i) } {
            i += 1;
            let Ok(d) = (unsafe { a.GetDesc1() }) else { continue };
            // Skip WARP / Microsoft Basic Render Driver.
            if d.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 || d.VendorId == 0x1414 {
                continue;
            }
            let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            out.push(Adapter {
                name: String::from_utf16_lossy(&d.Description[..len]).trim().to_string(),
                luid_tag: format!("luid_0x{:08x}_0x{:08x}", d.AdapterLuid.HighPart as u32, d.AdapterLuid.LowPart),
                dedicated_total: d.DedicatedVideoMemory as u64,
                shared_total: d.SharedSystemMemory as u64,
            });
        }
        out
    }

    pub struct Sampler {
        pdh: Option<Pdh>,
        prev_cpu: Option<CpuTimes>,
        adapter: Option<Adapter>,
    }

    impl Sampler {
        /// Opens the counters and takes the first sample for the rate counters (CPU, GPU engine
        /// utilisation), so the next [`Sampler::sample`] reports utilisation since now.
        /// `processes` registers the per-process GPU memory counters.
        pub fn new(processes: bool) -> Self {
            // Prefer the adapter with the most video memory (dedicated + shared).
            let all = adapters();
            for a in &all {
                debug(|| format!("adapter {} {} ded={} sh={}", a.name, a.luid_tag, a.dedicated_total, a.shared_total));
            }
            let mut pdh = Pdh::open(processes);
            // LUIDs the performance counters know about (the same GPU can be enumerated twice by DXGI).
            // This collection doubles as the baseline sample for the engine utilisation counters.
            let mut known: Vec<String> = Vec::new();
            if let Some(p) = pdh.as_mut() {
                p.collect();
                p.for_each(p.adapter_dedicated, |n, _| known.push(n.to_string()));
            }
            let prev_cpu = cpu_times();
            let adapter = pick_adapter(all, &known);
            Sampler { pdh, prev_cpu, adapter }
        }

        pub fn sample(&mut self, pids: &[u32]) -> CoreTelemetry {
            let ts = chrono::Utc::now().timestamp_millis();

            // RAM.
            let mut ms = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
            let (ram_total, ram_free) = if unsafe { GlobalMemoryStatusEx(&mut ms) }.is_ok() {
                (Some(to_mb(ms.ullTotalPhys)), Some(to_mb(ms.ullAvailPhys)))
            } else {
                (None, None)
            };
            let ram_used = match (ram_total, ram_free) {
                (Some(t), Some(f)) => Some(t.saturating_sub(f)),
                _ => None,
            };

            // CPU.
            let now = cpu_times();
            let cpu = match (self.prev_cpu, now) {
                (Some(a), Some(b)) => {
                    let idle = b.idle.saturating_sub(a.idle);
                    // Kernel time includes idle time.
                    let total = b.kernel.saturating_sub(a.kernel) + b.user.saturating_sub(a.user);
                    if total > 0 {
                        Some(round1((1.0 - idle as f64 / total as f64).clamp(0.0, 1.0) * 100.0))
                    } else {
                        None
                    }
                }
                _ => None,
            };
            self.prev_cpu = now;

            // GPU: every counter is folded in a single pass, straight from the PDH buffer.
            let luid = self.adapter.as_ref().map(|a| a.luid_tag.as_str());
            let (mut ded, mut sh, mut eng) = (Sum::default(), Sum::default(), EngineUtil::default());
            let mut per_pid: Vec<(u32, Sum, Sum)> = pids.iter().map(|&p| (p, Sum::default(), Sum::default())).collect();
            if let Some(p) = self.pdh.as_mut() {
                p.collect();
                if let Some(l) = luid {
                    p.for_each(p.adapter_dedicated, |n, v| if n.starts_with(l) { ded.add(v) });
                    p.for_each(p.adapter_shared, |n, v| if n.starts_with(l) { sh.add(v) });
                    p.for_each(p.engine_util, |n, v| eng.add(n, l, v));
                }
                if !pids.is_empty() {
                    p.for_each(p.process_dedicated, |n, v| {
                        if let Some(e) = process_entry(&mut per_pid, n, luid) {
                            e.1.add(v);
                        }
                    });
                    p.for_each(p.process_shared, |n, v| {
                        if let Some(e) = process_entry(&mut per_pid, n, luid) {
                            e.2.add(v);
                        }
                    });
                }
            }

            let gpu = match &self.adapter {
                None => GpuInfo {
                    name: String::new(),
                    dedicated_total_mb: None,
                    dedicated_used_mb: None,
                    shared_total_mb: None,
                    shared_used_mb: None,
                    util_pct: None,
                },
                Some(a) => GpuInfo {
                    name: a.name.clone(),
                    dedicated_total_mb: Some(to_mb(a.dedicated_total)),
                    dedicated_used_mb: ded.get().map(|b| to_mb(b as u64)),
                    shared_total_mb: Some(to_mb(a.shared_total)),
                    shared_used_mb: sh.get().map(|b| to_mb(b as u64)),
                    util_pct: eng.get(),
                },
            };
            let (vram_total, vram_used, vram_free) = normalise_vram(&gpu);

            let processes = per_pid
                .iter()
                .map(|(pid, pded, psh)| {
                    let mut info = process_info(*pid);
                    if info.alive {
                        info.gpu_dedicated_mb = pded.get().map(|b| to_mb(b as u64));
                        info.gpu_shared_mb = psh.get().map(|b| to_mb(b as u64));
                    }
                    info
                })
                .collect();

            CoreTelemetry {
                ts,
                source: "core",
                vram_total_mb: vram_total,
                vram_used_mb: vram_used,
                vram_free_mb: vram_free,
                ram_total_mb: ram_total,
                ram_used_mb: ram_used,
                ram_free_mb: ram_free,
                cpu_util_pct: cpu,
                gpu,
                processes,
            }
        }
    }

    /// Largest adapter (dedicated, then shared memory); among equals the first one that PDH reports.
    fn pick_adapter(all: Vec<Adapter>, known: &[String]) -> Option<Adapter> {
        let best = all.iter().map(|a| (a.dedicated_total, a.shared_total)).max()?;
        let mut candidates: Vec<Adapter> =
            all.into_iter().filter(|a| (a.dedicated_total, a.shared_total) == best).collect();
        let idx = candidates
            .iter()
            .position(|a| known.iter().any(|k| k.starts_with(&a.luid_tag)))
            .unwrap_or(0);
        Some(candidates.swap_remove(idx))
    }

    /// Sum of non-negative values; `None` when the counter is unavailable or nothing matched.
    #[derive(Debug, Default, Clone, Copy)]
    struct Sum {
        any: bool,
        total: f64,
    }

    impl Sum {
        fn add(&mut self, v: f64) {
            self.any = true;
            self.total += v.max(0.0);
        }
        fn get(&self) -> Option<f64> {
            self.any.then_some(self.total)
        }
    }

    /// The `per_pid` slot for a `pid_<N>_..._<luid>_...` GPU process-memory instance on our adapter.
    fn process_entry<'a>(
        per_pid: &'a mut [(u32, Sum, Sum)],
        name: &str,
        luid: Option<&str>,
    ) -> Option<&'a mut (u32, Sum, Sum)> {
        let (digits, _) = name.strip_prefix("pid_")?.split_once('_')?;
        let pid: u32 = digits.parse().ok()?;
        if luid.is_some_and(|l| !name.contains(l)) {
            return None;
        }
        per_pid.iter_mut().find(|e| e.0 == pid)
    }

    /// Task-Manager style: sum per engine type over all processes, then the busiest engine type.
    #[derive(Debug, Default)]
    struct EngineUtil {
        /// A handful of engine types (`3d`, `compute`, `copy`, ...): linear search beats hashing.
        by_type: Vec<(String, f64)>,
    }

    impl EngineUtil {
        fn add(&mut self, name: &str, luid: &str, v: f64) {
            if !name.contains(luid) {
                return;
            }
            let ty = name.rsplit_once("engtype_").map(|(_, t)| t).unwrap_or("");
            match self.by_type.iter_mut().find(|(t, _)| t == ty) {
                Some((_, sum)) => *sum += v.max(0.0),
                None => self.by_type.push((ty.to_string(), v.max(0.0))),
            }
        }
        fn get(&self) -> Option<f64> {
            if self.by_type.is_empty() {
                return None;
            }
            let max = self.by_type.iter().map(|(_, v)| *v).fold(0.0_f64, f64::max);
            Some(round1(max.min(100.0)))
        }
    }

    fn process_info(pid: u32) -> ProcessInfo {
        if pid == 0 {
            return ProcessInfo::dead(pid);
        }
        let handle: HANDLE = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid) }
            .or_else(|_| unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        {
            Ok(h) => h,
            Err(e) => {
                // ERROR_ACCESS_DENIED (0x80070005): it exists but we may not inspect it.
                if e.code().0 as u32 == 0x8007_0005 {
                    return ProcessInfo { alive: true, ..ProcessInfo::dead(pid) };
                }
                return ProcessInfo::dead(pid);
            }
        };
        let mut info = ProcessInfo { alive: true, ..ProcessInfo::dead(pid) };
        unsafe {
            let mut code: u32 = 0;
            if GetExitCodeProcess(handle, &mut code).is_ok() && code != STILL_ACTIVE {
                let _ = CloseHandle(handle);
                return ProcessInfo::dead(pid);
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                let full = String::from_utf16_lossy(&buf[..len as usize]);
                info.name = full.rsplit(['\\', '/']).next().map(str::to_string);
            }
            let mut pmc = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            if K32GetProcessMemoryInfo(handle, &mut pmc as *mut _ as *mut PROCESS_MEMORY_COUNTERS, pmc.cb).as_bool() {
                info.rss_mb = Some(to_mb(pmc.WorkingSetSize as u64));
                info.private_mb = Some(to_mb(pmc.PrivateUsage as u64));
            }
            let _ = CloseHandle(handle);
        }
        info
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn engine_util_takes_busiest_type() {
            let l = "luid_0x00000000_0x0000abcd";
            let items = vec![
                (format!("pid_1_{l}_phys_0_eng_0_engtype_3d"), 20.0),
                (format!("pid_2_{l}_phys_0_eng_0_engtype_3d"), 15.0),
                (format!("pid_2_{l}_phys_0_eng_1_engtype_compute"), 30.0),
                ("pid_2_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3d".to_string(), 90.0),
            ];
            let util = |luid: &str| {
                let mut e = EngineUtil::default();
                for (n, v) in &items {
                    e.add(n, luid, *v);
                }
                e.get()
            };
            assert_eq!(util(l), Some(35.0));
            assert_eq!(util("luid_nope"), None);

            assert_eq!(Sum::default().get(), None);
            let mut per_pid = vec![(1, Sum::default(), Sum::default()), (9, Sum::default(), Sum::default())];
            for (n, v) in &items {
                if let Some(e) = process_entry(&mut per_pid, n, Some(l)) {
                    e.1.add(*v);
                }
            }
            assert_eq!(per_pid[0].1.get(), Some(20.0));
            assert_eq!(per_pid[1].1.get(), None);
            // `pid_1_` never matches `pid_12_`; without an adapter every LUID counts.
            let mut per_pid = vec![(1, Sum::default(), Sum::default())];
            assert!(process_entry(&mut per_pid, "pid_12_luid_x", None).is_none());
            assert!(process_entry(&mut per_pid, "pid_1_luid_x", None).is_some());
            assert!(process_entry(&mut per_pid, "pid_1_luid_x", Some("luid_y")).is_none());
        }

        #[test]
        fn picks_adapter_known_to_pdh() {
            let mk = |l: &str| Adapter { name: "g".into(), luid_tag: l.into(), dedicated_total: 10, shared_total: 5 };
            let small = Adapter { name: "s".into(), luid_tag: "luid_s".into(), dedicated_total: 1, shared_total: 1 };
            let all = vec![small.clone(), mk("luid_a"), mk("luid_b")];
            assert_eq!(pick_adapter(all.clone(), &["luid_b_phys_0".into()]).unwrap().luid_tag, "luid_b");
            assert_eq!(pick_adapter(all, &[]).unwrap().luid_tag, "luid_a");
            assert!(pick_adapter(vec![], &[]).is_none());
        }

        #[test]
        fn samples_this_machine() {
            let mut s = Sampler::new(true);
            std::thread::sleep(Duration::from_millis(300));
            let me = std::process::id();
            let t = s.sample(&[me, 0xFFFF_FFF0]);
            assert_eq!(t.source, "core");
            assert!(t.ram_total_mb.unwrap() > 0);
            assert!(t.ram_used_mb.unwrap() <= t.ram_total_mb.unwrap());
            assert!(t.cpu_util_pct.is_some());
            let mine = &t.processes[0];
            assert!(mine.alive);
            assert!(mine.name.as_deref().unwrap_or("").to_lowercase().ends_with(".exe"));
            assert!(mine.rss_mb.is_some());
            let ghost = &t.processes[1];
            assert_eq!(ghost, &ProcessInfo::dead(0xFFFF_FFF0));
            let v = serde_json::to_value(&t).unwrap();
            assert!(v["processes"][1]["rssMb"].is_null());
            assert!(v.get("vramTotalMb").is_some() && v["gpu"].get("utilPct").is_some());

            // Without pids the per-process counters are never registered; a second tick reuses buffers.
            let mut s = Sampler::new(false);
            assert!(s.pdh.as_ref().map(|p| p.process_dedicated == 0 && p.process_shared == 0).unwrap_or(true));
            std::thread::sleep(Duration::from_millis(100));
            let a = s.sample(&[]);
            let b = s.sample(&[]);
            assert!(a.processes.is_empty() && b.processes.is_empty());
            assert_eq!(a.gpu.name, b.gpu.name);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    /// Non-Windows stub: every OS figure is unknown.
    pub struct Sampler;
    impl Sampler {
        pub fn new(_processes: bool) -> Self {
            Sampler
        }
        pub fn sample(&mut self, pids: &[u32]) -> CoreTelemetry {
            CoreTelemetry {
                ts: chrono::Utc::now().timestamp_millis(),
                source: "core",
                vram_total_mb: None,
                vram_used_mb: None,
                vram_free_mb: None,
                ram_total_mb: None,
                ram_used_mb: None,
                ram_free_mb: None,
                cpu_util_pct: None,
                gpu: GpuInfo { name: String::new(), dedicated_total_mb: None, dedicated_used_mb: None, shared_total_mb: None, shared_used_mb: None, util_pct: None },
                processes: pids.iter().map(|&p| ProcessInfo::dead(p)).collect(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vram_normalisation_never_fabricates() {
        let mut g = GpuInfo {
            name: "x".into(),
            dedicated_total_mb: Some(512),
            dedicated_used_mb: Some(480),
            shared_total_mb: Some(103936),
            shared_used_mb: Some(19632),
            util_pct: None,
        };
        assert_eq!(normalise_vram(&g), (Some(104448), Some(20112), Some(84336)));
        g.shared_used_mb = None;
        assert_eq!(normalise_vram(&g), (Some(104448), None, None));
    }
}
