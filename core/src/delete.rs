//! `delete` (API_CONTRACT.md §6.4): Recycle Bin removal of Library items.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::{flag, multi, opt, FlagSpec, Parsed};
use crate::envelope::{code, CoreError, Outcome};
use crate::library::{checked_thumbs_dir, SIDECAR_SUFFIX};
use crate::util::{absolutize, is_plain_file_name, is_safe_id, is_strictly_inside, path_str, require_dir, same_path};

pub const SPEC: &[FlagSpec] = &[opt("--dir"), multi("--sidecar"), flag("--stdin"), flag("--permanent")];

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub id: String,
    pub sidecar_path: String,
    pub trashed: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub sidecar_path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: Vec<Deleted>,
    pub failed: Vec<Failed>,
    pub recycle_bin: bool,
}

#[derive(Deserialize)]
struct StdinPayload {
    sidecars: Vec<String>,
}

pub fn run(p: &Parsed) -> Outcome {
    let dir = match p.require("--dir") {
        Ok(d) => d.to_string(),
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    };
    let permanent = p.has("--permanent");
    let from_stdin = p.has("--stdin");
    let mut sidecars: Vec<String> = p.all("--sidecar").to_vec();
    if from_stdin && !sidecars.is_empty() {
        return Outcome::err(CoreError::usage("use either --sidecar or --stdin, not both"));
    }
    if from_stdin {
        let mut buf = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
            return Outcome::err(CoreError::new(code::IO, format!("cannot read stdin: {e}")));
        }
        match serde_json::from_str::<StdinPayload>(buf.trim_start_matches('\u{feff}')) {
            Ok(pl) => sidecars = pl.sidecars,
            Err(e) => return Outcome::err(CoreError::new(code::PARSE, format!("stdin must be {{\"sidecars\": [..]}}: {e}"))),
        }
    }
    if sidecars.is_empty() {
        return Outcome::err(CoreError::usage("no sidecars given (use --sidecar <path> or --stdin)"));
    }
    let root = match require_dir(&dir) {
        Ok(r) => r,
        Err(e) => return Outcome::err(e),
    };
    let result = delete(&root, &sidecars, permanent);
    let data = serde_json::to_value(&result).expect("json");
    if result.failed.is_empty() {
        Outcome::ok(data)
    } else if !result.deleted.is_empty() {
        Outcome::partial(data)
    } else {
        let f = &result.failed[0];
        let code = match f.code.as_str() {
            "OUTSIDE_ROOT" => code::OUTSIDE_ROOT,
            "FILE_NOT_FOUND" => code::TRASH_FAILED, // keep exit 1 per §6.4 ("1 when all failed")
            "PARSE" => code::PARSE,
            "IO" => code::IO,
            _ => code::TRASH_FAILED,
        };
        Outcome::err_with_data(
            CoreError::new(code, format!("all {} item(s) failed; first: {}", result.failed.len(), f.message))
                .with_path(f.sidecar_path.clone()),
            data,
        )
    }
}

/// One path to recycle. Only a validated 3D asset directory is ever a `Dir` target; everything
/// else must be a regular file (never a directory, symlink or junction).
#[derive(Debug, Clone, PartialEq)]
enum Target {
    File(PathBuf),
    AssetDir(PathBuf),
}

impl Target {
    fn path(&self) -> &Path {
        match self {
            Target::File(p) | Target::AssetDir(p) => p,
        }
    }

    /// Re-checks the on-disk type right before removal.
    fn check(&self) -> Result<(), String> {
        let md = std::fs::symlink_metadata(self.path()).map_err(|e| format!("{}: {e}", path_str(self.path())))?;
        let ft = md.file_type();
        let ok = match self {
            Target::File(_) => ft.is_file(),
            Target::AssetDir(_) => ft.is_dir() && !ft.is_symlink(),
        };
        if ok {
            Ok(())
        } else {
            Err(format!("{}: unexpected file type, refusing to remove", path_str(self.path())))
        }
    }
}

/// One validated deletion target.
#[derive(Debug)]
struct Plan {
    id: Option<String>,
    sidecar: PathBuf,
    targets: Vec<Target>,
    /// Date folder to remove if it ends up empty (images/edits only).
    date_dir: Option<PathBuf>,
}

/// A regular file, not following links: directories, symlinks and junctions are all `false`.
fn is_regular_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_file()).unwrap_or(false)
}

/// The primary file extension a sidecar of `kind` may own.
fn primary_ext(kind: &str) -> Option<&'static str> {
    match kind {
        "image" | "edit" => Some("png"),
        "3d" => Some("glb"),
        _ => None,
    }
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case(ext)).unwrap_or(false)
}

fn canonical_root(root: &Path) -> PathBuf {
    dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

fn plan_one(root: &Path, raw: &str) -> Result<Plan, Failed> {
    let fail = |c: &str, path: &str, m: String| Failed { sidecar_path: path.to_string(), code: c.to_string(), message: m };
    let abs = absolutize(raw);
    let abs_s = path_str(&abs);

    // 1. Containment, on the canonical path (resolves `..`, junctions and symlinks).
    let canon = match dunce::canonicalize(&abs) {
        Ok(c) => c,
        Err(_) => {
            if !is_strictly_inside(root, &canonicalize_lenient(&abs)) {
                return Err(fail(code::OUTSIDE_ROOT, &abs_s, format!("path is outside {}", path_str(root))));
            }
            return Err(fail(code::FILE_NOT_FOUND, &abs_s, "sidecar does not exist".into()));
        }
    };
    let canon_s = path_str(&canon);
    if !is_strictly_inside(root, &canon) {
        return Err(fail(code::OUTSIDE_ROOT, &canon_s, format!("path resolves outside {}", path_str(root))));
    }
    let name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.to_ascii_lowercase().ends_with(SIDECAR_SUFFIX) || !canon.is_file() {
        return Err(fail(code::PARSE, &canon_s, "not a .studio.json sidecar file".into()));
    }
    let dir = canon.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
    let stem = name[..name.len() - SIDECAR_SUFFIX.len()].to_string();

    // 2. Read it.
    let parsed: Option<(String, String, String)> = std::fs::read(&canon)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).ok())
        .and_then(|v| {
            let g = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
            Some((g("id")?, g("kind")?, g("file")?))
        })
        .filter(|(id, _, file)| is_safe_id(id) && is_plain_file_name(file));

    let threed_base = root.join("3d");
    let mut plan = Plan { id: None, sidecar: canon.clone(), targets: Vec::new(), date_dir: None };
    match parsed {
        Some((id, kind, _file)) if kind == "3d" && is_direct_child(&threed_base, &dir) => {
            // The asset directory belongs entirely to this item. `dir` is the canonical parent
            // of the canonical sidecar, so it is a real directory, never a link.
            plan.id = Some(id);
            plan.targets.push(Target::AssetDir(dir));
        }
        Some((id, kind, file)) => {
            // Only a regular file of the kind's primary type is taken; a sidecar whose `file`
            // names a subdirectory, link or foreign file type loses just the sidecar.
            let primary = dir.join(&file);
            match primary_ext(&kind) {
                Some(ext) if has_ext(&primary, ext) && is_regular_file(&primary) => plan.targets.push(Target::File(primary)),
                _ if std::fs::symlink_metadata(&primary).is_ok() => crate::log::warn(&format!(
                    "delete: not removing {} (not a regular .{} file for kind '{kind}')",
                    path_str(&primary),
                    primary_ext(&kind).unwrap_or("?"),
                )),
                _ => {}
            }
            plan.targets.push(Target::File(canon.clone()));
            plan.id = Some(id);
            plan.date_dir = Some(dir);
        }
        None => {
            // Unreadable sidecar inside the root: recycle it and a same-stem primary next to it.
            for ext in ["png", "glb"] {
                let p = dir.join(format!("{stem}.{ext}"));
                if is_regular_file(&p) {
                    plan.targets.push(Target::File(p));
                }
            }
            plan.targets.push(Target::File(canon.clone()));
            plan.date_dir = Some(dir);
        }
    }
    // Defence in depth: every target must sit strictly inside the root.
    if let Some(bad) = plan.targets.iter().find(|t| !is_strictly_inside(root, t.path())) {
        return Err(fail(code::OUTSIDE_ROOT, &canon_s, format!("target outside root: {}", path_str(bad.path()))));
    }
    Ok(plan)
}

/// Canonicalizes the longest existing ancestor of `p` and re-appends the missing tail.
fn canonicalize_lenient(p: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = dunce::canonicalize(&cur) {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return out;
        }
        match (cur.file_name().map(|n| n.to_os_string()), cur.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

fn is_direct_child(parent: &Path, child: &Path) -> bool {
    is_strictly_inside(parent, child) && child.parent().map(|p| same_path(p, parent)).unwrap_or(false)
}

/// Dedup key for a canonical sidecar path, matching [`same_path`] equality.
fn path_key(p: &Path) -> String {
    let s = path_str(p);
    let s = s.trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s.to_string()
    }
}

fn remove_targets(targets: &[Target], permanent: bool) -> Result<(), String> {
    // Validate every type first so a swapped-in directory or link aborts before anything moves.
    for t in targets {
        t.check()?;
    }
    if permanent {
        for t in targets {
            let r = match t {
                Target::AssetDir(p) => std::fs::remove_dir_all(p),
                Target::File(p) => std::fs::remove_file(p),
            };
            r.map_err(|e| format!("{}: {e}", path_str(t.path())))?;
        }
        Ok(())
    } else {
        trash::delete_all(targets.iter().map(Target::path)).map_err(|e| e.to_string())
    }
}

/// The validated `.cache\thumbs` (never through a link), or `None` when missing or rejected.
fn thumbs_dir_for_delete(root: &Path) -> Option<PathBuf> {
    match checked_thumbs_dir(root, false) {
        Ok(t) => Some(t),
        Err((c, _)) if c == code::FILE_NOT_FOUND => None,
        Err((c, m)) => {
            crate::log::warn(&format!("not removing thumbnails: cache rejected ({c}): {m}"));
            None
        }
    }
}

/// Permanently removes `<id>.webp` from a validated thumbnail directory.
fn remove_thumb(tdir: &Path, id: &str) {
    let thumb = tdir.join(format!("{id}.webp"));
    // A link is removed itself (never its target); directories are left alone.
    let removable = std::fs::symlink_metadata(&thumb).map(|m| !m.is_dir()).unwrap_or(false);
    if removable {
        if let Err(e) = std::fs::remove_file(&thumb) {
            crate::log::warn(&format!("cannot remove thumb {}: {e}", path_str(&thumb)));
        }
    }
}

pub fn delete(root: &Path, sidecars: &[String], permanent: bool) -> DeleteResult {
    let root = canonical_root(root);
    let mut failed: Vec<Failed> = Vec::new();
    let mut plans: Vec<Plan> = Vec::new();
    let mut seen: HashSet<String> = HashSet::with_capacity(sidecars.len());
    for raw in sidecars {
        match plan_one(&root, raw) {
            Ok(p) => {
                if !seen.insert(path_key(&p.sidecar)) {
                    continue; // duplicate argument
                }
                plans.push(p)
            }
            Err(f) => failed.push(f),
        }
    }

    // 3. One shell operation for everything when possible; per item on failure to attribute errors.
    let mut ok_plans: Vec<&Plan> = Vec::new();
    let all: Vec<Target> = plans.iter().flat_map(|p| p.targets.iter().cloned()).collect();
    if !all.is_empty() && remove_targets(&all, permanent).is_ok() {
        ok_plans.extend(plans.iter());
    } else {
        for p in &plans {
            let remaining: Vec<Target> =
                p.targets.iter().filter(|t| std::fs::symlink_metadata(t.path()).is_ok()).cloned().collect();
            match if remaining.is_empty() { Ok(()) } else { remove_targets(&remaining, permanent) } {
                Ok(()) => ok_plans.push(p),
                Err(m) => failed.push(Failed {
                    sidecar_path: path_str(&p.sidecar),
                    code: code::TRASH_FAILED.into(),
                    message: m,
                }),
            }
        }
    }

    let mut deleted = Vec::new();
    // Validated once for the whole batch (and only when some deleted item has an id).
    let tdir = if ok_plans.iter().any(|p| p.id.is_some()) { thumbs_dir_for_delete(&root) } else { None };
    let kind_roots = [root.join("images"), root.join("edits"), root.join("3d")];
    for p in ok_plans {
        // 4. Thumbnail cache, permanently, only inside a validated `.cache\thumbs`.
        if let (Some(id), Some(tdir)) = (&p.id, tdir.as_deref()) {
            remove_thumb(tdir, id);
        }
        // 5. Empty date folder (never a kind root such as `images\`).
        if let Some(d) = &p.date_dir {
            let is_kind_root = kind_roots.iter().any(|k| same_path(d, k));
            if !is_kind_root
                && is_strictly_inside(&root, d)
                && d.is_dir()
                && std::fs::read_dir(d).map(|mut it| it.next().is_none()).unwrap_or(false)
            {
                let _ = std::fs::remove_dir(d);
            }
        }
        deleted.push(Deleted {
            id: p.id.clone().unwrap_or_default(),
            sidecar_path: path_str(&p.sidecar),
            trashed: p.targets.iter().map(|t| path_str(t.path())).collect(),
        });
    }
    DeleteResult { deleted, failed, recycle_bin: !permanent }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::thumbs_dir;
    use crate::library::tests::{fixture, make_dir_link, sidecar_json};

    #[test]
    fn rejects_outside_root_and_traversal() {
        let tmp = fixture();
        let root = tmp.path().join("images"); // use a sub-root so a sibling exists outside it
        let outside = tmp.path().join("edits").join("2026-11-26").join("20261126_090000_dddddddd.studio.json");
        let traversal = format!("{}\\2026-11-25\\..\\..\\edits\\2026-11-26\\20261126_090000_dddddddd.studio.json", path_str(&root));
        let missing_outside = path_str(&tmp.path().join("nope").join("x.studio.json"));
        let r = delete(&root, &[path_str(&outside), traversal, missing_outside], true);
        assert!(r.deleted.is_empty());
        assert_eq!(r.failed.len(), 3);
        assert!(r.failed.iter().all(|f| f.code == "OUTSIDE_ROOT"), "{:?}", r.failed);
        assert!(outside.is_file(), "file outside root must survive");
        // The root itself and a non-sidecar inside it are refused.
        let r = delete(&root, &[path_str(&root)], true);
        assert_eq!(r.failed[0].code, "OUTSIDE_ROOT");
        let png = root.join("2026-11-25").join("20261125_100000_aaaaaaaa.png");
        let r = delete(&root, &[path_str(&png)], true);
        assert_eq!(r.failed[0].code, "PARSE");
        assert!(png.is_file());
    }

    #[test]
    fn permanently_deletes_image_and_cleans_up() {
        let tmp = fixture();
        let root = tmp.path();
        // Make thumbnails first.
        let _ = crate::library::scan(root, &crate::library::ScanOpts { thumbs: true, thumb_size: 64, ..Default::default() });
        let tdir = thumbs_dir(root);
        assert!(tdir.join("dddddddd00000004.webp").is_file());

        let eday = root.join("edits").join("2026-11-26");
        let sc = eday.join("20261126_090000_dddddddd.studio.json");
        let r = delete(root, &[path_str(&sc)], true);
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(r.deleted.len(), 1);
        assert_eq!(r.deleted[0].id, "dddddddd00000004");
        assert_eq!(r.deleted[0].trashed.len(), 2);
        assert!(!r.recycle_bin);
        assert!(!sc.exists());
        assert!(!eday.join("20261126_090000_dddddddd.png").exists());
        assert!(!tdir.join("dddddddd00000004.webp").exists());
        assert!(!eday.exists(), "empty date folder removed");
        assert!(root.join("edits").is_dir(), "kind root kept");
    }

    #[test]
    fn permanently_deletes_3d_asset_dir_and_reports_partial() {
        let tmp = fixture();
        let root = tmp.path();
        let asset = root.join("3d").join("20261124_120000_eeeeeeee");
        let sc = asset.join("20261124_120000_eeeeeeee.studio.json");
        let missing = root.join("images").join("2026-11-25").join("gone.studio.json");
        let r = delete(root, &[path_str(&sc), path_str(&missing)], true);
        assert_eq!(r.deleted.len(), 1);
        assert_eq!(r.deleted[0].trashed, vec![path_str(&dunce::canonicalize(&asset).unwrap_or(asset.clone()))]);
        assert!(!asset.exists());
        assert!(root.join("3d").is_dir());
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].code, "FILE_NOT_FOUND");
        // Other images untouched; date folder still has content.
        assert!(root.join("images").join("2026-11-25").join("20261125_100000_aaaaaaaa.png").is_file());
    }

    #[test]
    fn unreadable_sidecar_takes_same_stem_primary() {
        let tmp = fixture();
        let day = tmp.path().join("images").join("2026-11-25");
        std::fs::write(day.join("20261125_150000_ab12cd34.studio.json"), b"{garbage").unwrap();
        let r = delete(tmp.path(), &[path_str(&day.join("20261125_150000_ab12cd34.studio.json"))], true);
        assert_eq!(r.deleted.len(), 1);
        assert_eq!(r.deleted[0].trashed.len(), 2);
        assert!(!day.join("20261125_150000_ab12cd34.png").exists());
    }

    #[test]
    fn image_sidecar_pointing_at_subdirectory_never_deletes_it() {
        let tmp = fixture();
        let root = tmp.path();
        let day = root.join("images").join("2026-11-25");
        let sub = day.join("nested.png"); // a directory, even with the expected extension
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("keep.txt"), b"keep").unwrap();
        let sub2 = day.join("plain_dir");
        std::fs::create_dir_all(&sub2).unwrap();
        std::fs::write(sub2.join("keep.txt"), b"keep").unwrap();
        for (name, file) in [("evil1", "nested.png"), ("evil2", "plain_dir")] {
            let sc = day.join(format!("{name}.studio.json"));
            std::fs::write(&sc, sidecar_json(&format!("{name}0000000001"), "image", file, "2026-11-25T00:00:00Z", None)).unwrap();
            let r = delete(root, &[path_str(&sc)], true);
            assert!(r.failed.is_empty(), "{:?}", r.failed);
            assert_eq!(r.deleted[0].trashed.len(), 1, "only the sidecar: {:?}", r.deleted[0].trashed);
            assert!(!sc.exists());
        }
        assert!(sub.join("keep.txt").is_file(), "subdirectory survives");
        assert!(sub2.join("keep.txt").is_file(), "subdirectory survives");
        // A primary of the wrong type (another item's sidecar) is not taken either.
        let other = day.join("20261125_100000_aaaaaaaa.studio.json");
        let sc = day.join("evil3.studio.json");
        std::fs::write(&sc, sidecar_json("evil30000000001", "image", "20261125_100000_aaaaaaaa.studio.json", "2026-11-25T00:00:00Z", None)).unwrap();
        let r = delete(root, &[path_str(&sc)], true);
        assert_eq!(r.deleted[0].trashed.len(), 1);
        assert!(other.is_file());
    }

    #[test]
    fn remove_targets_refuses_type_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("d");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("x"), b"x").unwrap();
        // A directory masquerading as a file target is refused before anything is removed.
        assert!(remove_targets(&[Target::File(d.clone())], true).is_err());
        assert!(d.join("x").is_file());
        let f = tmp.path().join("f.png");
        std::fs::write(&f, b"x").unwrap();
        assert!(remove_targets(&[Target::AssetDir(f.clone()), Target::AssetDir(d.clone())], true).is_err());
        assert!(f.is_file() && d.is_dir());
    }

    #[test]
    fn thumb_delete_never_follows_escaping_junction() {
        let tmp = fixture();
        let root = tmp.path();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("thumbs").join("dddddddd00000004.webp");
        std::fs::create_dir_all(victim.parent().unwrap()).unwrap();
        std::fs::write(&victim, b"precious").unwrap();
        assert!(make_dir_link(&root.join(".cache"), outside.path()), "cannot create junction");

        let sc = root.join("edits").join("2026-11-26").join("20261126_090000_dddddddd.studio.json");
        let r = delete(root, &[path_str(&sc)], true);
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(r.deleted.len(), 1);
        assert!(!sc.exists());
        assert!(victim.is_file(), "thumbnail outside outputsDir must survive");
    }

    #[test]
    fn sidecar_claiming_3d_outside_asset_layout_does_not_trash_parent() {
        let tmp = fixture();
        let root = tmp.path();
        // A kind:3d sidecar placed directly in `3d\` must not trash the whole `3d\` folder.
        std::fs::write(root.join("3d").join("x.glb"), b"glTF").unwrap();
        std::fs::write(root.join("3d").join("x.studio.json"),
            crate::library::tests::sidecar_json("1234", "3d", "x.glb", "2026-11-25T00:00:00Z", None)).unwrap();
        let r = delete(root, &[path_str(&root.join("3d").join("x.studio.json"))], true);
        assert_eq!(r.deleted.len(), 1);
        assert!(root.join("3d").is_dir());
        assert!(root.join("3d").join("20261124_120000_eeeeeeee").is_dir());
    }
}
