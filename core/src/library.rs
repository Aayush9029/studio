//! `library-scan` (API_CONTRACT.md §5, §6.3).

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::SystemTime;

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, Limits};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Map, Value};
use walkdir::WalkDir;

use crate::args::{flag, opt, FlagSpec, Parsed};
use crate::envelope::{code, CoreError, Outcome};
use crate::util::{is_plain_file_name, is_safe_id, is_strictly_inside, parse_iso_ms, path_str, require_dir, same_path};

pub const SPEC: &[FlagSpec] = &[
    opt("--dir"),
    opt("--kind"),
    flag("--thumbs"),
    opt("--thumb-size"),
    opt("--limit"),
    opt("--offset"),
    opt("--since"),
];

pub const SIDECAR_SUFFIX: &str = ".studio.json";
pub const THUMB_QUALITY: f32 = 82.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Edit,
    ThreeD,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "image" => Some(Kind::Image),
            "edit" => Some(Kind::Edit),
            "3d" => Some(Kind::ThreeD),
            _ => None,
        }
    }
    pub fn folder(self) -> &'static str {
        match self {
            Kind::Image => "images",
            Kind::Edit => "edits",
            Kind::ThreeD => "3d",
        }
    }
    /// Lower-case extension of the primary file a sidecar of this kind owns.
    pub fn primary_ext(self) -> &'static str {
        match self {
            Kind::ThreeD => "glb",
            Kind::Image | Kind::Edit => "png",
        }
    }
    pub const ALL: [Kind; 3] = [Kind::Image, Kind::Edit, Kind::ThreeD];
}

#[derive(Debug, Clone)]
pub struct ScanOpts {
    pub kind: Option<Kind>,
    pub thumbs: bool,
    pub thumb_size: u32,
    pub limit: Option<usize>,
    pub offset: usize,
    pub since_ms: Option<i64>,
}

impl Default for ScanOpts {
    fn default() -> Self {
        Self { kind: None, thumbs: false, thumb_size: 512, limit: None, offset: 0, since_ms: None }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InvalidSidecar {
    pub sidecar_path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ThumbFailure {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbStats {
    pub generated: usize,
    pub up_to_date: usize,
    pub failed: Vec<ThumbFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanResult {
    pub dir: String,
    pub total: usize,
    pub items: Vec<Value>,
    pub thumbs: ThumbStats,
    pub invalid: Vec<InvalidSidecar>,
    pub orphans: Vec<String>,
}

/// A parsed, validated sidecar with resolved paths.
#[derive(Debug, Clone)]
pub struct Item {
    pub raw: Map<String, Value>,
    pub id: String,
    pub kind: Kind,
    pub created_ms: i64,
    pub path: PathBuf,
    pub dir: PathBuf,
    pub sidecar: PathBuf,
    pub preview: Option<PathBuf>,
}

impl Item {
    pub fn thumb_source(&self) -> Option<&Path> {
        match self.kind {
            Kind::ThreeD => self.preview.as_deref().filter(|p| p.is_file()),
            _ => Some(self.path.as_path()),
        }
    }

    /// `OutputItem`: every sidecar field plus the resolved absolute fields (§5.3).
    /// `thumbs_dir` is `None` when the cache directory is missing or failed containment checks.
    pub fn to_output_item(&self, thumbs_dir: Option<&Path>) -> Value {
        let mut m = self.raw.clone();
        let thumb = thumbs_dir.map(|d| d.join(format!("{}.webp", self.id))).filter(|t| t.is_file());
        m.insert("path".into(), json!(path_str(&self.path)));
        m.insert("dir".into(), json!(path_str(&self.dir)));
        m.insert("sidecarPath".into(), json!(path_str(&self.sidecar)));
        m.insert("previewPath".into(), self.preview.as_ref().map(|p| json!(path_str(p))).unwrap_or(Value::Null));
        m.insert("thumbPath".into(), thumb.map(|t| json!(path_str(&t))).unwrap_or(Value::Null));
        m.insert(
            "assetDir".into(),
            if self.kind == Kind::ThreeD { json!(path_str(&self.dir)) } else { Value::Null },
        );
        Value::Object(m)
    }
}

/// Parses one sidecar file into an [`Item`] or an `(code, message)` failure.
pub fn parse_sidecar(sidecar: &Path) -> Result<Item, (&'static str, String)> {
    let text = std::fs::read(sidecar).map_err(|e| (code::IO, format!("cannot read sidecar: {e}")))?;
    let text = text.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&text);
    let value: Value = serde_json::from_slice(text).map_err(|e| (code::PARSE, format!("invalid JSON: {e}")))?;
    let Value::Object(raw) = value else {
        return Err((code::PARSE, "sidecar is not a JSON object".into()));
    };
    let s = |k: &str| raw.get(k).and_then(Value::as_str).map(str::to_string);
    let id = s("id").ok_or((code::PARSE, "missing string field 'id'".to_string()))?;
    if !is_safe_id(&id) {
        return Err((code::PARSE, format!("invalid id '{id}'")));
    }
    let kind_s = s("kind").ok_or((code::PARSE, "missing string field 'kind'".to_string()))?;
    let kind = Kind::parse(&kind_s).ok_or((code::PARSE, format!("unknown kind '{kind_s}'")))?;
    let file = s("file").ok_or((code::PARSE, "missing string field 'file'".to_string()))?;
    if !is_plain_file_name(&file) {
        return Err((code::PARSE, format!("'file' must be a plain file name, got '{file}'")));
    }
    let created = s("createdAt").ok_or((code::PARSE, "missing string field 'createdAt'".to_string()))?;
    let created_ms = parse_iso_ms(&created).ok_or((code::PARSE, format!("invalid createdAt '{created}'")))?;

    let dir = sidecar.parent().map(Path::to_path_buf).unwrap_or_default();
    let path = dir.join(&file);
    if !path.is_file() {
        return Err((code::FILE_NOT_FOUND, format!("primary file missing: {}", path_str(&path))));
    }
    let preview = match (kind, raw.get("preview").and_then(Value::as_str)) {
        (Kind::ThreeD, Some(p)) if is_plain_file_name(p) => Some(dir.join(p)),
        _ => None,
    };
    Ok(Item { raw, id, kind, created_ms, path, dir, sidecar: sidecar.to_path_buf(), preview })
}

pub fn run(p: &Parsed) -> Outcome {
    let mut opts = ScanOpts::default();
    let dir = match p.require("--dir") {
        Ok(d) => d.to_string(),
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    };
    match p.get("--kind") {
        None | Some("all") => {}
        Some(k) => match Kind::parse(k) {
            Some(k) => opts.kind = Some(k),
            None => return Outcome::err(CoreError::usage(format!("invalid --kind '{k}' (all|image|edit|3d)"))),
        },
    }
    opts.thumbs = p.has("--thumbs");
    match p.parse_num::<u32>("--thumb-size") {
        Ok(Some(s)) if (64..=1024).contains(&s) => opts.thumb_size = s,
        Ok(Some(s)) => return Outcome::err(CoreError::usage(format!("--thumb-size {s} out of range 64-1024"))),
        Ok(None) => {}
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    }
    match p.parse_num::<usize>("--limit") {
        Ok(v) => opts.limit = v,
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    }
    match p.parse_num::<usize>("--offset") {
        Ok(v) => opts.offset = v.unwrap_or(0),
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    }
    if let Some(s) = p.get("--since") {
        match parse_iso_ms(s) {
            Some(ms) => opts.since_ms = Some(ms),
            None => return Outcome::err(CoreError::usage(format!("invalid --since '{s}' (ISO-8601 expected)"))),
        }
    }
    let root = match require_dir(&dir) {
        Ok(r) => r,
        Err(e) => return Outcome::err(e),
    };
    let result = scan(&root, &opts);
    let partial = !result.thumbs.failed.is_empty();
    let data = serde_json::to_value(result).expect("json");
    if partial {
        Outcome::partial(data)
    } else {
        Outcome::ok(data)
    }
}

pub fn thumbs_dir(root: &Path) -> PathBuf {
    root.join(".cache").join("thumbs")
}

/// Validates (and with `create`, creates) `<root>\.cache\thumbs`, returning its lexical path.
///
/// `.cache` and `.cache\thumbs` must both be real directories whose canonical paths are exactly
/// `<canonical root>\.cache[\thumbs]`. A junction or symlink at either level is rejected
/// (`OUTSIDE_ROOT` when it resolves outside the root, `IO` otherwise), so thumbnail writes and
/// deletes can never be redirected out of `outputsDir`. A missing directory without `create`
/// is `FILE_NOT_FOUND`.
pub fn checked_thumbs_dir(root: &Path, create: bool) -> Result<PathBuf, (&'static str, String)> {
    let canon_root =
        dunce::canonicalize(root).map_err(|e| (code::IO, format!("cannot resolve {}: {e}", path_str(root))))?;
    let outside = |p: &Path| (code::OUTSIDE_ROOT, format!("{} resolves outside {}", path_str(p), path_str(&canon_root)));
    let mut expected = canon_root.clone();
    for seg in [".cache", "thumbs"] {
        expected.push(seg);
        if create {
            match std::fs::create_dir(&expected) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err((code::IO, format!("mkdir {}: {e}", path_str(&expected)))),
            }
        }
        let md = match std::fs::symlink_metadata(&expected) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err((code::FILE_NOT_FOUND, format!("{} does not exist", path_str(&expected))))
            }
            Err(e) => return Err((code::IO, format!("stat {}: {e}", path_str(&expected)))),
        };
        // On Windows `is_symlink` also covers NTFS junctions (name-surrogate reparse points).
        if md.file_type().is_symlink() || !md.is_dir() {
            let resolved = dunce::canonicalize(&expected).unwrap_or_else(|_| expected.clone());
            return Err(if is_strictly_inside(&canon_root, &resolved) {
                (code::IO, format!("{} is not a plain directory", path_str(&expected)))
            } else {
                outside(&expected)
            });
        }
        let resolved = dunce::canonicalize(&expected)
            .map_err(|e| (code::IO, format!("cannot resolve {}: {e}", path_str(&expected))))?;
        if !is_strictly_inside(&canon_root, &resolved) {
            return Err(outside(&expected));
        }
        if !same_path(&resolved, &expected) {
            return Err((code::IO, format!("{} is redirected to {}", path_str(&expected), path_str(&resolved))));
        }
    }
    Ok(thumbs_dir(root))
}

pub fn scan(root: &Path, opts: &ScanOpts) -> LibraryScanResult {
    let kinds: Vec<Kind> = match opts.kind {
        Some(k) => vec![k],
        None => Kind::ALL.to_vec(),
    };

    let mut items: Vec<Item> = Vec::new();
    let mut invalid: Vec<InvalidSidecar> = Vec::new();
    let mut orphans: Vec<String> = Vec::new();

    for kind in kinds {
        let base = root.join(kind.folder());
        if !base.is_dir() {
            continue;
        }
        let mut sidecars: Vec<PathBuf> = Vec::new();
        let mut primaries: Vec<PathBuf> = Vec::new();
        let primary_suffix = format!(".{}", kind.primary_ext());
        for entry in WalkDir::new(&base)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 || !e.file_type().is_dir() {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                // Hidden folders are never scanned; 3D `stages\` only hold pipeline intermediates.
                !(name.starts_with('.') || (kind == Kind::ThreeD && name.eq_ignore_ascii_case("stages")))
            })
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(SIDECAR_SUFFIX) {
                sidecars.push(entry.into_path());
            } else if name.ends_with(&primary_suffix) {
                primaries.push(entry.into_path());
            }
        }

        type ParsedSidecar = (PathBuf, Result<Item, (&'static str, String)>);
        let parsed: Vec<ParsedSidecar> =
            sidecars.into_par_iter().map(|s| { let r = parse_sidecar(&s); (s, r) }).collect();

        let mut claimed: HashSet<String> = HashSet::new();
        for (sidecar, r) in parsed {
            // A sidecar, valid or not, claims its same-stem primary so it is not an orphan.
            let stem_primary = sidecar_stem_path(&sidecar, kind);
            match r {
                Ok(item) => {
                    claimed.insert(key(&item.path));
                    if let Some(sp) = &stem_primary {
                        claimed.insert(key(sp));
                    }
                    if item.kind == kind || opts.kind.is_none() {
                        items.push(item);
                    }
                }
                Err((c, message)) => {
                    if let Some(sp) = &stem_primary {
                        claimed.insert(key(sp));
                    }
                    invalid.push(InvalidSidecar { sidecar_path: path_str(&sidecar), code: c.to_string(), message });
                }
            }
        }
        for p in primaries {
            let k = key(&p);
            if !claimed.contains(&k) {
                // Fallback: same-stem sidecar exists but is outside this walk (shouldn't happen) — check disk.
                let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let sc = p.with_file_name(format!("{stem}{SIDECAR_SUFFIX}"));
                if !sc.is_file() {
                    orphans.push(path_str(&p));
                }
            }
        }
    }

    // When a single kind is requested, filter on the sidecar's own kind.
    if let Some(k) = opts.kind {
        items.retain(|i| i.kind == k);
    }
    if let Some(since) = opts.since_ms {
        items.retain(|i| i.created_ms >= since);
    }
    items.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then_with(|| a.id.cmp(&b.id)));
    let total = items.len();
    let page: Vec<Item> = items
        .into_iter()
        .skip(opts.offset)
        .take(opts.limit.unwrap_or(usize::MAX))
        .collect();

    let mut thumbs = ThumbStats::default();
    // Only a validated cache directory is ever written to or reported as `thumbPath`.
    let tdir: Option<PathBuf> = match checked_thumbs_dir(root, opts.thumbs && !page.is_empty()) {
        Ok(t) => Some(t),
        Err((c, message)) => {
            if c != code::FILE_NOT_FOUND {
                crate::log::warn(&format!("thumbnail cache rejected ({c}): {message}"));
                if opts.thumbs {
                    for item in page.iter().filter(|i| i.thumb_source().is_some()) {
                        thumbs.failed.push(ThumbFailure { id: item.id.clone(), message: format!("{c}: {message}") });
                    }
                }
            }
            None
        }
    };
    if let (true, Some(tdir)) = (opts.thumbs, tdir.as_deref()) {
        let budget = DecodeBudget::new(DECODE_BUDGET_BYTES);
        let results: Vec<ThumbOutcome> =
            page.par_iter().map(|item| ensure_thumb(item, tdir, opts.thumb_size, &budget)).collect();
        for r in results {
            match r {
                ThumbOutcome::Generated => thumbs.generated += 1,
                ThumbOutcome::UpToDate => thumbs.up_to_date += 1,
                ThumbOutcome::NoSource => {}
                ThumbOutcome::Failed(f) => {
                    crate::log::warn(&format!("thumb {} failed: {}", f.id, f.message));
                    thumbs.failed.push(f)
                }
            }
        }
    }

    orphans.sort();
    invalid.sort_by(|a, b| a.sidecar_path.cmp(&b.sidecar_path));
    LibraryScanResult {
        dir: path_str(root),
        total,
        items: page.iter().map(|i| i.to_output_item(tdir.as_deref())).collect(),
        thumbs,
        invalid,
        orphans,
    }
}

fn key(p: &Path) -> String {
    path_str(p).to_lowercase()
}

/// `<dir>\<stem>.studio.json` → `<dir>\<stem>.<png|glb>`: the primary a sidecar in a `kind`
/// folder may own. Derived from the folder kind (only that extension is ever a primary there),
/// so no per-sidecar `exists()` probe is needed.
fn sidecar_stem_path(sidecar: &Path, kind: Kind) -> Option<PathBuf> {
    let name = sidecar.file_name()?.to_string_lossy();
    let stem = name.get(..name.len().checked_sub(SIDECAR_SUFFIX.len())?)?;
    Some(sidecar.with_file_name(format!("{stem}.{}", kind.primary_ext())))
}

#[derive(Debug)]
pub enum ThumbOutcome {
    Generated,
    UpToDate,
    NoSource,
    Failed(ThumbFailure),
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

/// Aggregate budget for decoded pixel buffers held at once by parallel thumbnail workers.
pub const DECODE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

/// Byte-weighted counting semaphore. A request larger than the whole budget is clamped to it,
/// so an oversized image runs alone once the others drain instead of waiting forever.
pub struct DecodeBudget {
    cap: u64,
    used: Mutex<u64>,
    freed: Condvar,
}

pub struct DecodePermit<'a> {
    budget: &'a DecodeBudget,
    bytes: u64,
}

impl DecodeBudget {
    pub fn new(cap: u64) -> Self {
        Self { cap: cap.max(1), used: Mutex::new(0), freed: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, u64> {
        self.used.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Blocks until `bytes` fit in the remaining budget, or nothing else is in flight.
    pub fn acquire(&self, bytes: u64) -> DecodePermit<'_> {
        let want = bytes.clamp(1, self.cap);
        let mut used = self.lock();
        while *used > 0 && *used + want > self.cap {
            used = self.freed.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += want;
        DecodePermit { budget: self, bytes: want }
    }

    /// Bytes currently held by outstanding permits.
    #[cfg(test)]
    pub fn in_use(&self) -> u64 {
        *self.lock()
    }
}

impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        let mut used = self.budget.lock();
        *used = used.saturating_sub(self.bytes);
        drop(used);
        self.budget.freed.notify_all();
    }
}

pub fn ensure_thumb(item: &Item, tdir: &Path, size: u32, budget: &DecodeBudget) -> ThumbOutcome {
    let Some(src) = item.thumb_source() else {
        return ThumbOutcome::NoSource;
    };
    let dst = tdir.join(format!("{}.webp", item.id));
    if let (Some(t), Some(s)) = (mtime(&dst), mtime(src)) {
        if t >= s {
            return ThumbOutcome::UpToDate;
        }
    }
    match make_thumb(src, &dst, size, budget) {
        Ok(()) => ThumbOutcome::Generated,
        Err(message) => ThumbOutcome::Failed(ThumbFailure { id: item.id.clone(), message }),
    }
}

/// Estimated decoded size: `w * h * 4`, or the decoder's own figure when larger (16-bit PNG).
fn estimated_decode_bytes(w: u32, h: u32, decoder_total: u64) -> u64 {
    (u64::from(w) * u64::from(h) * 4).max(decoder_total)
}

/// Catmull-Rom-resizes `src` so its long edge is at most `size` (aspect and alpha preserved)
/// and writes a lossy WebP (quality 82) atomically to `dst`, whose directory must exist.
///
/// The dimensions are read from the header *before* any pixels are decoded, and a `budget`
/// permit sized to the decoded buffer is held while the full-size image is alive. It is
/// released before WebP encoding, which only touches the (at most `size`²) thumbnail buffer.
pub fn make_thumb(src: &Path, dst: &Path, size: u32, budget: &DecodeBudget) -> Result<(), String> {
    let decoder = image::ImageReader::open(src)
        .map_err(|e| format!("open: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("format: {e}"))?
        .into_decoder()
        .map_err(|e| format!("decode: {e}"))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 {
        return Err("image has zero size".into());
    }
    let estimated = estimated_decode_bytes(w, h, decoder.total_bytes());
    // The same allocation ceiling `ImageReader::decode` enforces (512 MiB by default).
    Limits::default().reserve(estimated).map_err(|e| format!("decode: {e}"))?;
    let permit = budget.acquire(estimated);
    let img = DynamicImage::from_decoder(decoder).map_err(|e| format!("decode: {e}"))?;
    let long = w.max(h);
    let target = size.min(long);
    let (nw, nh) = if w >= h {
        (target, ((h as f64 * target as f64 / w as f64).round() as u32).max(1))
    } else {
        (((w as f64 * target as f64 / h as f64).round() as u32).max(1), target)
    };
    let resized = if (nw, nh) == (w, h) {
        // Already within `size`: the decoded buffer is the thumbnail.
        img
    } else {
        let r = img.resize_exact(nw, nh, FilterType::CatmullRom);
        drop(img); // free the full-size buffer before encoding
        r
    };
    // Only the thumbnail-sized buffer is left: let other workers decode while this one encodes.
    drop(permit);

    // `into_rgba8`/`into_rgb8` move the buffer when it already has that layout (no copy).
    let encoded = if resized.color().has_alpha() {
        let rgba = resized.into_rgba8();
        webp::Encoder::from_rgba(rgba.as_raw(), nw, nh).encode(THUMB_QUALITY)
    } else {
        let rgb = resized.into_rgb8();
        webp::Encoder::from_rgb(rgb.as_raw(), nw, nh).encode(THUMB_QUALITY)
    };
    if encoded.is_empty() {
        return Err("webp encoder produced no data".into());
    }
    let tmp = dst.with_extension(format!("webp.{}.tmp", std::process::id()));
    // `create_new` never writes through a pre-planted link at the temp path, and `rename`
    // replaces a link at `dst` itself rather than following it.
    let _ = std::fs::remove_file(&tmp);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(&encoded))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("write: {e}")
        })?;
    std::fs::rename(&tmp, dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    pub fn sidecar_json(id: &str, kind: &str, file: &str, created: &str, preview: Option<&str>) -> String {
        let mode = match kind {
            "image" => "t2i",
            "edit" => "inpaint",
            _ => "i23d",
        };
        json!({
            "schemaVersion": 1, "id": id, "jobId": "job_0000000000000001", "kind": kind, "mode": mode,
            "createdAt": created, "elapsedMs": 10, "file": file,
            "mime": if kind == "3d" { "model/gltf-binary" } else { "image/png" },
            "bytes": 1, "width": null, "height": null, "hasAlpha": false,
            "model": {"family": "z_image", "label": "Z-Image Turbo", "files": []},
            "params": {"prompt": "p", "negativePrompt": "", "enhanced": false, "enhancedPrompt": null, "seed": 1,
                       "steps": 9, "cfg": 1.0, "sampler": "euler", "scheduler": "simple", "denoise": null,
                       "resolution": null, "batchIndex": 0, "batchSize": 1},
            "inputs": {"sourceId": null, "imagePath": null, "referencePaths": []},
            "mesh": null, "stages": [], "preview": preview, "favorite": false,
            "app": {"name": "Studio", "engineVersion": "1.0.0", "apiVersion": 1}
        })
        .to_string()
    }

    pub fn write_png(path: &Path, w: u32, h: u32, alpha: bool) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if alpha {
            let img = RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 255) as u8, (y % 255) as u8, 128, if x < w / 2 { 0 } else { 255 }]));
            img.save(path).unwrap();
        } else {
            let img = RgbImage::from_fn(w, h, |x, y| Rgb([(x % 255) as u8, (y % 255) as u8, 64]));
            img.save(path).unwrap();
        }
    }

    /// Builds a small outputs tree; returns the root tempdir.
    pub fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        let day = r.join("images").join("2026-11-25");
        write_png(&day.join("20261125_100000_aaaaaaaa.png"), 64, 32, false);
        std::fs::write(day.join("20261125_100000_aaaaaaaa.studio.json"),
            sidecar_json("aaaaaaaa00000001", "image", "20261125_100000_aaaaaaaa.png", "2026-11-25T10:00:00.000Z", None)).unwrap();
        // Same createdAt as above → id ascending tiebreak.
        write_png(&day.join("20261125_100000_00000000.png"), 16, 16, false);
        std::fs::write(day.join("20261125_100000_00000000.studio.json"),
            sidecar_json("0000000000000002", "image", "20261125_100000_00000000.png", "2026-11-25T10:00:00.000Z", None)).unwrap();
        // Orphan PNG.
        write_png(&day.join("20261125_150000_ab12cd34.png"), 8, 8, false);
        // Invalid: broken JSON.
        std::fs::write(day.join("broken.studio.json"), b"{ nope").unwrap();
        // Invalid: primary missing.
        std::fs::write(day.join("20261125_160000_cccccccc.studio.json"),
            sidecar_json("cccccccc00000003", "image", "20261125_160000_cccccccc.png", "2026-11-25T16:00:00.000Z", None)).unwrap();

        let eday = r.join("edits").join("2026-11-26");
        write_png(&eday.join("20261126_090000_dddddddd.png"), 40, 80, true);
        std::fs::write(eday.join("20261126_090000_dddddddd.studio.json"),
            sidecar_json("dddddddd00000004", "edit", "20261126_090000_dddddddd.png", "2026-11-26T09:00:00.000Z", None)).unwrap();

        let asset = r.join("3d").join("20261124_120000_eeeeeeee");
        std::fs::create_dir_all(asset.join("stages")).unwrap();
        // Pipeline intermediates under `stages\` are never scanned (no orphan reported).
        std::fs::write(asset.join("stages").join("stage_1.glb"), b"glTF").unwrap();
        std::fs::write(asset.join("20261124_120000_eeeeeeee.glb"), b"glTF").unwrap();
        write_png(&asset.join("source.png"), 8, 8, false);
        write_png(&asset.join("preview.png"), 32, 32, true);
        std::fs::rename(asset.join("preview.png"), asset.join("preview.webp.png")).unwrap();
        // A real WebP preview made through our own encoder.
        make_thumb(&asset.join("preview.webp.png"), &asset.join("preview.webp"), 1024, &DecodeBudget::new(DECODE_BUDGET_BYTES)).unwrap();
        std::fs::remove_file(asset.join("preview.webp.png")).unwrap();
        std::fs::write(asset.join("20261124_120000_eeeeeeee.studio.json"),
            sidecar_json("eeeeeeee00000005", "3d", "20261124_120000_eeeeeeee.glb", "2026-11-24T12:00:00.000Z", Some("preview.webp"))).unwrap();
        // 3D without preview → no thumbnail, no failure.
        let asset2 = r.join("3d").join("20261123_120000_ffffffff");
        std::fs::create_dir_all(&asset2).unwrap();
        std::fs::write(asset2.join("20261123_120000_ffffffff.glb"), b"glTF").unwrap();
        std::fs::write(asset2.join("20261123_120000_ffffffff.studio.json"),
            sidecar_json("ffffffff00000006", "3d", "20261123_120000_ffffffff.glb", "2026-11-23T12:00:00.000Z", None)).unwrap();
        tmp
    }

    #[test]
    fn scans_sorts_and_reports() {
        let tmp = fixture();
        let res = scan(tmp.path(), &ScanOpts::default());
        let ids: Vec<&str> = res.items.iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["dddddddd00000004", "0000000000000002", "aaaaaaaa00000001", "eeeeeeee00000005", "ffffffff00000006"]);
        assert_eq!(res.total, 5);
        assert_eq!(res.orphans.len(), 1);
        assert!(res.orphans[0].ends_with("20261125_150000_ab12cd34.png"));
        let codes: Vec<&str> = res.invalid.iter().map(|i| i.code.as_str()).collect();
        assert_eq!(res.invalid.len(), 2);
        assert!(codes.contains(&"PARSE") && codes.contains(&"FILE_NOT_FOUND"));

        // OutputItem fields.
        let img = &res.items[1];
        assert!(img["path"].as_str().unwrap().ends_with("20261125_100000_00000000.png"));
        assert!(img["sidecarPath"].as_str().unwrap().ends_with(".studio.json"));
        assert!(img["assetDir"].is_null() && img["previewPath"].is_null() && img["thumbPath"].is_null());
        assert_eq!(img["params"]["steps"], 9);
        let three = &res.items[3];
        assert_eq!(three["assetDir"], three["dir"]);
        assert!(three["previewPath"].as_str().unwrap().ends_with("preview.webp"));
        // Sidecar field order preserved, resolved fields appended.
        let keys: Vec<&String> = img.as_object().unwrap().keys().collect();
        assert_eq!(keys[0], "schemaVersion");
        assert_eq!(keys[keys.len() - 1], "assetDir");
    }

    #[test]
    fn filters_and_pages() {
        let tmp = fixture();
        let r = scan(tmp.path(), &ScanOpts { kind: Some(Kind::ThreeD), ..Default::default() });
        assert_eq!(r.total, 2);
        assert!(r.orphans.is_empty());
        let r = scan(tmp.path(), &ScanOpts { limit: Some(2), offset: 1, ..Default::default() });
        assert_eq!(r.total, 5);
        let ids: Vec<&str> = r.items.iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["0000000000000002", "aaaaaaaa00000001"]);
        let r = scan(tmp.path(), &ScanOpts { since_ms: parse_iso_ms("2026-11-25T00:00:00Z"), ..Default::default() });
        assert_eq!(r.total, 3);
        let empty = tempfile::tempdir().unwrap();
        let r = scan(empty.path(), &ScanOpts::default());
        assert_eq!(r.total, 0);
        assert!(r.items.is_empty());
    }

    #[test]
    fn generates_webp_thumbnails() {
        let tmp = fixture();
        let opts = ScanOpts { thumbs: true, thumb_size: 32, ..Default::default() };
        let r = scan(tmp.path(), &opts);
        assert!(r.thumbs.failed.is_empty(), "{:?}", r.thumbs.failed);
        assert_eq!(r.thumbs.generated, 4); // 2 images, 1 edit, 1 3D with preview
        assert_eq!(r.thumbs.up_to_date, 0);
        for it in &r.items {
            let id = it["id"].as_str().unwrap();
            if id == "ffffffff00000006" {
                assert!(it["thumbPath"].is_null());
            } else {
                assert!(it["thumbPath"].as_str().unwrap().ends_with(&format!("{id}.webp")));
            }
        }
        let t = thumbs_dir(tmp.path());
        let bytes = std::fs::read(t.join("aaaaaaaa00000001.webp")).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let thumb = image::open(t.join("aaaaaaaa00000001.webp")).unwrap();
        assert_eq!(thumb.dimensions(), (32, 16)); // 64x32 → long edge 32
        let edit = image::open(t.join("dddddddd00000004.webp")).unwrap();
        assert_eq!(edit.dimensions(), (16, 32));
        assert!(edit.color().has_alpha());
        let small = image::open(t.join("0000000000000002.webp")).unwrap();
        assert_eq!(small.dimensions(), (16, 16)); // never upscaled

        let r2 = scan(tmp.path(), &opts);
        assert_eq!(r2.thumbs.generated, 0);
        assert_eq!(r2.thumbs.up_to_date, 4);
    }

    #[test]
    fn corrupt_source_fails_thumb() {
        let tmp = fixture();
        let day = tmp.path().join("images").join("2026-11-25");
        std::fs::write(day.join("20261125_100000_aaaaaaaa.png"), b"not a png").unwrap();
        let r = scan(tmp.path(), &ScanOpts { thumbs: true, kind: Some(Kind::Image), ..Default::default() });
        assert_eq!(r.thumbs.failed.len(), 1);
        assert_eq!(r.thumbs.failed[0].id, "aaaaaaaa00000001");
    }

    /// Creates a directory link `link` → `target` (an NTFS junction on Windows, which needs no
    /// privilege; a symlink elsewhere). Returns false when the platform refuses.
    pub fn make_dir_link(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
                && link.is_dir()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn thumbs_dir_containment() {
        // Missing without `create` → FILE_NOT_FOUND; with `create` → real nested dirs.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(checked_thumbs_dir(tmp.path(), false).unwrap_err().0, "FILE_NOT_FOUND");
        let t = checked_thumbs_dir(tmp.path(), true).unwrap();
        assert!(t.is_dir());
        assert_eq!(t, thumbs_dir(tmp.path()));
        assert!(checked_thumbs_dir(tmp.path(), false).is_ok());

        // `.cache\thumbs` that is a plain file → IO, never written through.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".cache")).unwrap();
        std::fs::write(thumbs_dir(tmp.path()), b"x").unwrap();
        assert_eq!(checked_thumbs_dir(tmp.path(), true).unwrap_err().0, "IO");

        let outside = tempfile::tempdir().unwrap();
        // `.cache` junction escaping the root → OUTSIDE_ROOT.
        let tmp = tempfile::tempdir().unwrap();
        assert!(make_dir_link(&tmp.path().join(".cache"), outside.path()), "cannot create junction");
        assert_eq!(checked_thumbs_dir(tmp.path(), true).unwrap_err().0, "OUTSIDE_ROOT");
        assert!(!outside.path().join("thumbs").exists(), "nothing created through the junction");

        // `.cache\thumbs` junction escaping the root → OUTSIDE_ROOT.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".cache")).unwrap();
        assert!(make_dir_link(&thumbs_dir(tmp.path()), outside.path()));
        assert_eq!(checked_thumbs_dir(tmp.path(), false).unwrap_err().0, "OUTSIDE_ROOT");

        // A junction that stays inside the root is still refused (IO), not followed.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("images")).unwrap();
        assert!(make_dir_link(&tmp.path().join(".cache"), &tmp.path().join("images")));
        assert_eq!(checked_thumbs_dir(tmp.path(), true).unwrap_err().0, "IO");
        assert!(!tmp.path().join("images").join("thumbs").exists());
    }

    #[test]
    fn scan_never_writes_thumbs_through_escaping_junction() {
        let tmp = fixture();
        let outside = tempfile::tempdir().unwrap();
        assert!(make_dir_link(&tmp.path().join(".cache"), outside.path()));
        let r = scan(tmp.path(), &ScanOpts { thumbs: true, thumb_size: 32, ..Default::default() });
        assert_eq!(r.thumbs.generated, 0);
        assert_eq!(r.thumbs.failed.len(), 4, "every item with a source reports the rejected cache");
        assert!(r.thumbs.failed.iter().all(|f| f.message.starts_with("OUTSIDE_ROOT")));
        assert!(r.items.iter().all(|i| i["thumbPath"].is_null()));
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0, "nothing written outside the root");
    }

    #[test]
    fn decode_budget_bounds_bytes_in_flight() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let budget = DecodeBudget::new(100);
        let peak = AtomicU64::new(0);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..20 {
                        let _p = budget.acquire(40);
                        peak.fetch_max(budget.in_use(), Ordering::SeqCst);
                        std::thread::yield_now();
                    }
                });
            }
        });
        let peak = peak.load(Ordering::SeqCst);
        assert!((40..=100).contains(&peak), "peak {peak}");
        assert_eq!(budget.in_use(), 0, "all permits released");

        // Larger than the whole budget: admitted alone (clamped), never deadlocks.
        let huge = budget.acquire(10_000);
        assert_eq!(budget.in_use(), 100);
        drop(huge);
        assert_eq!(budget.in_use(), 0);
    }

    #[test]
    fn tiny_budget_still_makes_thumbnails() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("a.png");
        write_png(&src, 64, 32, true);
        assert_eq!(estimated_decode_bytes(64, 32, 0), 64 * 32 * 4);
        let budget = DecodeBudget::new(16); // far below 64*32*4
        make_thumb(&src, &tmp.path().join("a.webp"), 32, &budget).unwrap();
        assert_eq!(image::open(tmp.path().join("a.webp")).unwrap().dimensions(), (32, 16));
        assert_eq!(budget.in_use(), 0);
    }

    #[test]
    fn rejects_unsafe_sidecar_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let day = tmp.path().join("images").join("d");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("x.studio.json"), sidecar_json("../evil", "image", "x.png", "2026-11-25T00:00:00Z", None)).unwrap();
        std::fs::write(day.join("y.studio.json"), sidecar_json("abcd", "image", "..\\..\\y.png", "2026-11-25T00:00:00Z", None)).unwrap();
        let r = scan(tmp.path(), &ScanOpts::default());
        assert_eq!(r.invalid.len(), 2);
        assert!(r.invalid.iter().all(|i| i.code == "PARSE"));
    }
}
