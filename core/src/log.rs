//! stderr diagnostics, mirrored to `%STUDIO_LOG_DIR%\core.log` when set.

use std::io::Write;

fn emit(level: &str, msg: &str) {
    let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let line = format!("{ts} [{level}] studio-core[{}] {msg}", std::process::id());
    let _ = writeln!(std::io::stderr(), "{line}");
    if let Some(dir) = std::env::var_os("STUDIO_LOG_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("core.log")) {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub fn info(msg: &str) {
    emit("INFO", msg);
}
pub fn warn(msg: &str) {
    emit("WARN", msg);
}
pub fn error(msg: &str) {
    emit("ERROR", msg);
}
