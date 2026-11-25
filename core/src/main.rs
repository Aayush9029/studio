//! `studio-core` — Studio's stateless native helper (API_CONTRACT.md §6).
//!
//! Every invocation writes exactly one compact JSON envelope line to stdout
//! (or NDJSON with `telemetry --watch`). Diagnostics go to stderr and, when
//! `STUDIO_LOG_DIR` is set, are appended to `%STUDIO_LOG_DIR%\core.log`.

mod args;
mod delete;
mod envelope;
mod library;
mod log;
mod models;
mod telemetry;
mod util;

use std::process::ExitCode;
use std::time::Instant;

use args::{ArgError, Parsed};
use envelope::{CoreError, Outcome};

pub const VERSION: &str = "1.0.0";

const COMMANDS: &[&str] = &["scan-models", "library-scan", "delete", "telemetry"];

fn main() -> ExitCode {
    let started = Instant::now();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let pretty = argv.iter().any(|a| a == "--pretty");
    let rest: Vec<String> = argv.into_iter().filter(|a| a != "--pretty").collect();

    if rest.iter().any(|a| a == "--version" || a == "-V") && rest.len() == 1 {
        println!("studio-core {VERSION}");
        return ExitCode::from(0);
    }

    let Some(command) = rest.first().cloned() else {
        let err = CoreError::usage("missing command (expected one of: scan-models, library-scan, delete, telemetry)");
        return finish("", started, pretty, Outcome::err(err));
    };
    if !COMMANDS.contains(&command.as_str()) {
        let err = CoreError::usage(format!("unknown command '{command}'"));
        return finish(&command, started, pretty, Outcome::err(err));
    }
    log::info(&format!("{command} {}", rest[1..].join(" ")));

    let outcome = match command.as_str() {
        "scan-models" => with_args(&rest[1..], models::SPEC, models::run),
        "library-scan" => with_args(&rest[1..], library::SPEC, library::run),
        "delete" => with_args(&rest[1..], delete::SPEC, delete::run),
        "telemetry" => {
            // `--watch` streams NDJSON and never returns normally.
            match args::parse(&rest[1..], telemetry::SPEC) {
                Ok(p) => telemetry::run(&p, pretty),
                Err(e) => Outcome::err(arg_err(e)),
            }
        }
        _ => unreachable!(),
    };
    finish(&command, started, pretty, outcome)
}

fn with_args(argv: &[String], spec: &[args::FlagSpec], f: fn(&Parsed) -> Outcome) -> Outcome {
    match args::parse(argv, spec) {
        Ok(p) => f(&p),
        Err(e) => Outcome::err(arg_err(e)),
    }
}

fn arg_err(e: ArgError) -> CoreError {
    CoreError::usage(e.0)
}

fn finish(command: &str, started: Instant, pretty: bool, outcome: Outcome) -> ExitCode {
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    if let Some(err) = &outcome.error {
        log::error(&format!("{command}: {} — {}", err.code, err.message));
    }
    let exit = outcome.exit_code();
    let line = envelope::render(command, elapsed, &outcome, pretty);
    envelope::write_line(&line);
    ExitCode::from(exit as u8)
}
