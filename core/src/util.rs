//! Path and time helpers.

use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use crate::envelope::{code, CoreError};

/// Absolute, separator-normalised form of a user-supplied path (no symlink resolution).
pub fn absolutize(p: &str) -> PathBuf {
    let raw = PathBuf::from(p);
    std::path::absolute(&raw).unwrap_or(raw)
}

/// Native string form of a path.
pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Resolves `--dir`, failing with `DIR_NOT_FOUND` (exit 4) when it is not a directory.
pub fn require_dir(raw: &str) -> Result<PathBuf, CoreError> {
    let p = absolutize(raw);
    if p.is_dir() {
        Ok(p)
    } else {
        Err(CoreError::new(code::DIR_NOT_FOUND, format!("directory does not exist: {}", path_str(&p)))
            .with_path(path_str(&p)))
    }
}

pub fn iso_millis(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Parses an ISO-8601 timestamp into Unix milliseconds.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis())
}

/// `relPath` with forward slashes.
pub fn rel_slash(root: &Path, p: &Path) -> String {
    let rel = p.strip_prefix(root).unwrap_or(p);
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// A single plain file name: no separators, no `..`, not empty.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(|c| c.is_control())
}

/// Ids used as file names (thumbnails): ASCII alphanumerics, `_` and `-` only.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Lexical path equality ignoring trailing separators (ASCII case-insensitive on Windows).
pub fn same_path(a: &Path, b: &Path) -> bool {
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    let (a, b) = (a.trim_end_matches(['\\', '/']), b.trim_end_matches(['\\', '/']));
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Component-wise containment check (case-insensitive on Windows). `child == root` is not inside.
pub fn is_strictly_inside(root: &Path, child: &Path) -> bool {
    let rc: Vec<String> = norm_components(root);
    let cc: Vec<String> = norm_components(child);
    cc.len() > rc.len() && cc[..rc.len()] == rc[..]
}

fn norm_components(p: &Path) -> Vec<String> {
    p.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| {
            let s = c.as_os_str().to_string_lossy();
            if cfg!(windows) {
                s.replace('/', "\\").to_lowercase()
            } else {
                s.into_owned()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment() {
        let root = Path::new(r"C:\Studio\outputs");
        assert!(is_strictly_inside(root, Path::new(r"C:\Studio\outputs\images\a.png")));
        assert!(is_strictly_inside(root, Path::new(r"c:\studio\OUTPUTS\x")));
        assert!(!is_strictly_inside(root, Path::new(r"C:\Studio\outputs")));
        assert!(!is_strictly_inside(root, Path::new(r"C:\Studio\outputs2\x")));
        assert!(!is_strictly_inside(root, Path::new(r"C:\Studio\x")));
        assert!(same_path(Path::new(r"C:\Studio\outputs\"), root));
        assert!(!same_path(Path::new(r"C:\Studio\outputs2"), root));
        if cfg!(windows) {
            assert!(same_path(Path::new(r"c:\studio\OUTPUTS"), root));
        }
    }

    #[test]
    fn names_and_ids() {
        assert!(is_plain_file_name("a.png"));
        assert!(!is_plain_file_name("..\\a.png"));
        assert!(!is_plain_file_name("../a.png"));
        assert!(!is_plain_file_name("C:a.png"));
        assert!(is_safe_id("5d0c1e7a9b3f4a21"));
        assert!(!is_safe_id("../x"));
        assert!(!is_safe_id(""));
    }

    #[test]
    fn iso() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_iso_ms("bad"), None);
        assert_eq!(iso_millis(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }
}
