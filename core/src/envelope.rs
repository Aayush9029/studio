//! `CoreEnvelope<T>` and error codes (API_CONTRACT.md §6.1).

use std::io::Write;

use serde::Serialize;
use serde_json::Value;

pub mod code {
    pub const USAGE: &str = "USAGE";
    pub const DIR_NOT_FOUND: &str = "DIR_NOT_FOUND";
    pub const FILE_NOT_FOUND: &str = "FILE_NOT_FOUND";
    pub const IO: &str = "IO";
    pub const PARSE: &str = "PARSE";
    pub const OUTSIDE_ROOT: &str = "OUTSIDE_ROOT";
    pub const TRASH_FAILED: &str = "TRASH_FAILED";
    /// Listed in API_CONTRACT.md §6.1 but not currently emitted; kept so the code set matches the contract.
    #[allow(dead_code)]
    pub const OS_API: &str = "OS_API";
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl CoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), path: None }
    }
    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(code::USAGE, message)
    }
    /// Exit code implied by an envelope-level error (§6.1).
    pub fn exit_code(&self) -> i32 {
        match self.code {
            code::USAGE => 2,
            code::DIR_NOT_FOUND | code::FILE_NOT_FOUND => 4,
            _ => 1,
        }
    }
}

/// Result of one command: data, an envelope error, or both (all-failed delete).
#[derive(Debug)]
pub struct Outcome {
    pub data: Option<Value>,
    pub error: Option<CoreError>,
    /// Explicit exit code for successful/partial outcomes (0 or 3).
    pub exit: i32,
}

impl Outcome {
    pub fn ok(data: Value) -> Self {
        Self { data: Some(data), error: None, exit: 0 }
    }
    pub fn partial(data: Value) -> Self {
        Self { data: Some(data), error: None, exit: 3 }
    }
    pub fn err(e: CoreError) -> Self {
        Self { data: None, error: Some(e), exit: 1 }
    }
    pub fn err_with_data(e: CoreError, data: Value) -> Self {
        Self { data: Some(data), error: Some(e), exit: 1 }
    }
    pub fn exit_code(&self) -> i32 {
        match &self.error {
            Some(e) => e.exit_code(),
            None => self.exit,
        }
    }
}

/// Wire shape of one envelope. Borrows its payload, so rendering never clones `data`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a, T: Serialize + ?Sized> {
    ok: bool,
    command: &'a str,
    version: &'static str,
    elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a CoreError>,
}

fn to_line<T: Serialize + ?Sized>(env: &Envelope<'_, T>, pretty: bool) -> String {
    if pretty {
        serde_json::to_string_pretty(env).expect("json")
    } else {
        serde_json::to_string(env).expect("json")
    }
}

fn round_ms(elapsed_ms: f64) -> f64 {
    (elapsed_ms * 100.0).round() / 100.0
}

pub fn render(command: &str, elapsed_ms: f64, outcome: &Outcome, pretty: bool) -> String {
    let env = Envelope {
        ok: outcome.error.is_none(),
        command,
        version: crate::VERSION,
        elapsed_ms: round_ms(elapsed_ms),
        data: outcome.data.as_ref(),
        error: outcome.error.as_ref(),
    };
    to_line(&env, pretty)
}

/// A successful envelope serialized straight from `data`, skipping the `Value` round trip.
pub fn render_ok<T: Serialize + ?Sized>(command: &str, elapsed_ms: f64, data: &T, pretty: bool) -> String {
    let env = Envelope {
        ok: true,
        command,
        version: crate::VERSION,
        elapsed_ms: round_ms(elapsed_ms),
        data: Some(data),
        error: None,
    };
    to_line(&env, pretty)
}

/// Writes one line to stdout and flushes. Returns `false` when stdout is closed.
pub fn write_line(line: &str) -> bool {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if lock.write_all(line.as_bytes()).is_err() || lock.write_all(b"\n").is_err() {
        return false;
    }
    lock.flush().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_shapes() {
        let ok = render("scan-models", 1.234, &Outcome::ok(json!({"a": 1})), false);
        let v: Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["command"], "scan-models");
        assert_eq!(v["version"], "1.0.0");
        assert_eq!(v["data"]["a"], 1);
        assert!(v.get("error").is_none());
        assert!(!ok.contains('\n'));

        let e = Outcome::err(CoreError::new(code::DIR_NOT_FOUND, "nope").with_path("C:\\x"));
        assert_eq!(e.exit_code(), 4);
        let v: Value = serde_json::from_str(&render("library-scan", 0.2, &e, false)).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "DIR_NOT_FOUND");
        assert_eq!(v["error"]["path"], "C:\\x");
        assert!(v.get("data").is_none());

        assert_eq!(Outcome::err(CoreError::usage("x")).exit_code(), 2);

        // Key order is part of the wire format; the typed fast path matches the generic one.
        let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, Value>>(&ok).unwrap().keys().cloned().collect();
        assert_eq!(keys, ["ok", "command", "version", "elapsedMs", "data"]);
        assert_eq!(render_ok("scan-models", 1.234, &json!({"a": 1}), false), ok);
        assert_eq!(Outcome::partial(json!({})).exit_code(), 3);
    }
}
