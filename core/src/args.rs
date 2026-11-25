//! Minimal, strict flag parser. Unknown flags and missing values are usage errors.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct FlagSpec {
    pub name: &'static str,
    pub takes_value: bool,
    pub repeatable: bool,
}

pub const fn flag(name: &'static str) -> FlagSpec {
    FlagSpec { name, takes_value: false, repeatable: false }
}
pub const fn opt(name: &'static str) -> FlagSpec {
    FlagSpec { name, takes_value: true, repeatable: false }
}
pub const fn multi(name: &'static str) -> FlagSpec {
    FlagSpec { name, takes_value: true, repeatable: true }
}

#[derive(Debug)]
pub struct ArgError(pub String);

#[derive(Debug, Default)]
pub struct Parsed {
    values: HashMap<&'static str, Vec<String>>,
    switches: Vec<&'static str>,
}

impl Parsed {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.last()).map(String::as_str)
    }
    pub fn all(&self, name: &str) -> &[String] {
        self.values.get(name).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn has(&self, name: &str) -> bool {
        self.switches.contains(&name) || self.values.contains_key(name)
    }
    pub fn require(&self, name: &str) -> Result<&str, ArgError> {
        self.get(name).ok_or_else(|| ArgError(format!("missing required flag {name}")))
    }
    pub fn parse_num<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>, ArgError> {
        match self.get(name) {
            None => Ok(None),
            Some(s) => s
                .parse::<T>()
                .map(Some)
                .map_err(|_| ArgError(format!("invalid value for {name}: '{s}'"))),
        }
    }
}

pub fn parse(argv: &[String], spec: &[FlagSpec]) -> Result<Parsed, ArgError> {
    let mut out = Parsed::default();
    let mut i = 0;
    while i < argv.len() {
        let raw = &argv[i];
        if !raw.starts_with("--") {
            return Err(ArgError(format!("unexpected argument '{raw}'")));
        }
        let (name, inline) = match raw.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (raw.as_str(), None),
        };
        let Some(fs) = spec.iter().find(|f| f.name == name) else {
            return Err(ArgError(format!("unknown flag '{name}'")));
        };
        if fs.takes_value {
            let value = match inline {
                Some(v) => v,
                None => {
                    i += 1;
                    match argv.get(i) {
                        Some(v) if !v.starts_with("--") => v.clone(),
                        _ => return Err(ArgError(format!("flag {name} requires a value"))),
                    }
                }
            };
            let entry = out.values.entry(fs.name).or_default();
            if !fs.repeatable && !entry.is_empty() {
                return Err(ArgError(format!("flag {name} given more than once")));
            }
            entry.push(value);
        } else {
            if inline.is_some() {
                return Err(ArgError(format!("flag {name} takes no value")));
            }
            out.switches.push(fs.name);
        }
        i += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags() {
        let spec = [opt("--dir"), flag("--thumbs"), multi("--pid")];
        let p = parse(&v(&["--dir", "C:\\x", "--thumbs", "--pid=1", "--pid", "2"]), &spec).unwrap();
        assert_eq!(p.get("--dir"), Some("C:\\x"));
        assert!(p.has("--thumbs"));
        assert_eq!(p.all("--pid"), &["1".to_string(), "2".to_string()]);
        assert!(parse(&v(&["--nope"]), &spec).is_err());
        assert!(parse(&v(&["--dir"]), &spec).is_err());
        assert!(parse(&v(&["--dir", "a", "--dir", "b"]), &spec).is_err());
        assert!(parse(&v(&["stray"]), &spec).is_err());
    }
}
