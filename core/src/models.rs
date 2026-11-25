//! `scan-models` (API_CONTRACT.md §6.2).

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use rayon::prelude::*;
use serde::de::{self, DeserializeSeed, Deserializer, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use walkdir::WalkDir;

use crate::args::{opt, FlagSpec, Parsed};
use crate::envelope::{CoreError, Outcome};
use crate::util::{iso_millis, path_str, rel_slash, require_dir};

pub const SPEC: &[FlagSpec] = &[opt("--dir"), opt("--max-metadata-bytes")];

pub const MODEL_EXTS: &[&str] = &["safetensors", "gguf", "pt", "pth", "ckpt", "bin"];

/// Upper bound for a safetensors JSON header. Real headers are a few MB at most;
/// anything larger is treated as corrupt rather than allocated.
pub const MAX_HEADER_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SafetensorsHeader {
    pub header_bytes: u64,
    pub tensor_count: u64,
    pub parameter_count: u64,
    pub dtypes: BTreeMap<String, u64>,
    pub primary_dtype: String,
    pub metadata: Map<String, Value>,
    pub metadata_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedModelFile {
    pub rel_path: String,
    pub path: String,
    pub category: String,
    pub name: String,
    pub ext: String,
    pub bytes: u64,
    pub modified_at: String,
    pub header: Option<SafetensorsHeader>,
    pub header_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelScan {
    pub dir: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub files: Vec<ScannedModelFile>,
}

pub fn run(p: &Parsed) -> Outcome {
    let dir = match p.require("--dir") {
        Ok(d) => d,
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    };
    let max_meta = match p.parse_num::<usize>("--max-metadata-bytes") {
        Ok(v) => v.unwrap_or(4096),
        Err(e) => return Outcome::err(CoreError::usage(e.0)),
    };
    let root = match require_dir(dir) {
        Ok(r) => r,
        Err(e) => return Outcome::err(e),
    };
    let scan = scan_dir(&root, max_meta);
    Outcome::ok(serde_json::to_value(scan).expect("json"))
}

pub fn scan_dir(root: &Path, max_meta: usize) -> ModelScan {
    let candidates: Vec<_> = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !(e.depth() > 0 && e.file_type().is_dir() && e.file_name().to_string_lossy().starts_with('.')))
        .filter_map(|e| match e {
            Ok(e) => Some(e),
            Err(err) => {
                crate::log::warn(&format!("scan-models: walk error: {err}"));
                None
            }
        })
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let ext = ext_of(e.path()).filter(|x| MODEL_EXTS.contains(&x.as_str()))?;
            Some((e.into_path(), ext))
        })
        .collect();

    let mut files: Vec<ScannedModelFile> = candidates
        .into_par_iter()
        .map(|(path, ext)| scan_file(root, &path, ext, max_meta))
        .collect();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    ModelScan { dir: path_str(root), file_count: files.len(), total_bytes, files }
}

fn ext_of(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

fn scan_file(root: &Path, path: &Path, ext: String, max_meta: usize) -> ScannedModelFile {
    let rel_path = rel_slash(root, path);
    let category = match rel_path.split_once('/') {
        Some((first, _)) => first.to_string(),
        None => String::new(),
    };
    // Safetensors files are opened once and their metadata read from the open handle;
    // other formats only need the metadata.
    let (meta, header, header_error) = if ext == "safetensors" {
        match File::open(path) {
            Ok(mut f) => {
                let meta = f.metadata().ok();
                let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                // Unbuffered on purpose: two exact reads (8-byte prefix, then the header) and
                // nothing more, so no tensor bytes are prefetched for small headers.
                match parse_safetensors_header(&mut f, len, max_meta) {
                    Ok(h) => (meta, Some(h), None),
                    Err(e) => (meta, None, Some(e)),
                }
            }
            Err(e) => (std::fs::metadata(path).ok(), None, Some(e.to_string())),
        }
    } else {
        (std::fs::metadata(path).ok(), None, None)
    };
    let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified_at = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(iso_millis)
        .unwrap_or_else(|| iso_millis(std::time::UNIX_EPOCH));

    ScannedModelFile {
        rel_path,
        path: path_str(path),
        category,
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        ext,
        bytes,
        modified_at,
        header,
        header_error,
    }
}

/// Reads only the 8-byte length prefix and the JSON header; never tensor data.
pub fn parse_safetensors_header<R: Read>(r: &mut R, file_len: u64, max_meta: usize) -> Result<SafetensorsHeader, String> {
    let mut len_buf = [0u8; 8];
    r.read_exact(&mut len_buf).map_err(|_| "file shorter than 8 bytes".to_string())?;
    let n = u64::from_le_bytes(len_buf);
    if n < 2 {
        return Err(format!("header length {n} too small"));
    }
    if n > MAX_HEADER_BYTES {
        return Err(format!("header length {n} exceeds limit {MAX_HEADER_BYTES}"));
    }
    if n > file_len.saturating_sub(8) {
        return Err(format!("header length {n} exceeds file size {file_len}"));
    }
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf).map_err(|e| format!("truncated header: {e}"))?;

    // Stream the header object entry by entry: tensor names and dtypes are borrowed straight
    // from `buf`, shapes are folded into a parameter count, and only `__metadata__` is
    // materialised. Trailing space padding is JSON whitespace and is accepted by `end()`.
    let mut acc = HeaderAcc { max_meta, ..Default::default() };
    let mut de = serde_json::Deserializer::from_slice(&buf);
    HeaderSeed(&mut acc).deserialize(&mut de).map_err(|e| format!("header JSON: {e}"))?;
    de.end().map_err(|e| format!("header JSON: {e}"))?;
    let HeaderAcc { tensor_count, parameter_count, dtypes, dtype_params, metadata, metadata_truncated, .. } = acc;

    // Most parameters wins; ties resolve to the alphabetically first dtype.
    let primary_dtype = dtype_params
        .iter()
        .fold(None::<(&String, u128)>, |best, (k, &v)| match best {
            Some((_, bv)) if bv >= v => best,
            _ => Some((k, v)),
        })
        .map(|(k, _)| k.clone())
        .unwrap_or_default();

    Ok(SafetensorsHeader {
        header_bytes: n,
        tensor_count,
        parameter_count: parameter_count.min(u64::MAX as u128) as u64,
        dtypes,
        primary_dtype,
        metadata,
        metadata_truncated,
    })
}

fn truncate_utf8(mut s: String, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    (s, true)
}

// ── Streaming header parser ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct HeaderAcc {
    max_meta: usize,
    tensor_count: u64,
    parameter_count: u128,
    dtypes: BTreeMap<String, u64>,
    dtype_params: BTreeMap<String, u128>,
    metadata: Map<String, Value>,
    metadata_truncated: bool,
}

impl HeaderAcc {
    fn add_tensor(&mut self, dtype: &str, count: u128) {
        self.tensor_count += 1;
        self.parameter_count = self.parameter_count.saturating_add(count);
        // Look up by `&str` first so a repeated dtype allocates nothing.
        match self.dtypes.get_mut(dtype) {
            Some(c) => *c += 1,
            None => {
                self.dtypes.insert(dtype.to_owned(), 1);
            }
        }
        match self.dtype_params.get_mut(dtype) {
            Some(p) => *p = p.saturating_add(count),
            None => {
                self.dtype_params.insert(dtype.to_owned(), count);
            }
        }
    }
}

/// Visits the top-level header object, feeding [`HeaderAcc`].
struct HeaderSeed<'a>(&'a mut HeaderAcc);

impl<'de> DeserializeSeed<'de> for HeaderSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for HeaderSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let acc = self.0;
        while let Some(CowStr(key)) = map.next_key::<CowStr<'de>>()? {
            if key == "__metadata__" {
                if let Value::Object(m) = map.next_value::<Value>()? {
                    for (mk, mv) in m {
                        let s = match mv {
                            Value::String(s) => s,
                            other => other.to_string(),
                        };
                        let (cut, truncated) = truncate_utf8(s, acc.max_meta);
                        acc.metadata_truncated |= truncated;
                        acc.metadata.insert(mk, Value::String(cut));
                    }
                }
                continue;
            }
            let (dtype, count) = match map.next_value::<Tensor<'de>>()? {
                Tensor::NotObject => return Err(A::Error::custom(format!("tensor '{key}' is not an object"))),
                Tensor::Object { dtype: None, .. } => return Err(A::Error::custom(format!("tensor '{key}' has no dtype"))),
                Tensor::Object { shape: Shape::Missing, .. } => {
                    return Err(A::Error::custom(format!("tensor '{key}' has no shape")))
                }
                Tensor::Object { shape: Shape::BadDim, .. } => {
                    return Err(A::Error::custom(format!("tensor '{key}' has a non-integer dimension")))
                }
                Tensor::Object { dtype: Some(d), shape: Shape::Count(c) } => (d, c),
            };
            acc.add_tensor(&dtype, count);
        }
        Ok(())
    }
}

/// A string borrowed from the input when it has no escapes.
struct CowStr<'de>(Cow<'de, str>);

impl<'de> Deserialize<'de> for CowStr<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CowStr<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(CowStr(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(CowStr(Cow::Owned(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(CowStr(Cow::Owned(v)))
            }
        }
        d.deserialize_str(V)
    }
}

/// Any JSON value, keeping only what a tensor entry needs.
enum Scalar<'de> {
    Str(Cow<'de, str>),
    U64(u64),
    Other,
}

/// Implements the "anything else" visitor methods, draining compound values without storing them.
macro_rules! visit_other {
    ($other:expr) => {
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok($other)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok($other)
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok($other)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($other)
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($other)
        }
    };
}

fn drain_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
    while seq.next_element::<IgnoredAny>()?.is_some() {}
    Ok(())
}

fn drain_map<'de, A: MapAccess<'de>>(mut map: A) -> Result<(), A::Error> {
    while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
    Ok(())
}

impl<'de> Deserialize<'de> for Scalar<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Scalar<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(Scalar::Str(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(Scalar::Str(Cow::Owned(v.to_owned())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(Scalar::U64(v))
            }
            visit_other!(Scalar::Other);
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
                drain_seq(seq).map(|_| Scalar::Other)
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                drain_map(map).map(|_| Scalar::Other)
            }
        }
        d.deserialize_any(V)
    }
}

/// A tensor's `shape`, folded into its element count.
enum Shape {
    Missing,
    BadDim,
    Count(u128),
}

impl<'de> Deserialize<'de> for Shape {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Shape;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an array of dimensions")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Shape, A::Error> {
                let mut count: u128 = 1;
                let mut bad = false;
                while let Some(dim) = seq.next_element::<Scalar<'de>>()? {
                    match dim {
                        Scalar::U64(d) => count = count.saturating_mul(u128::from(d)),
                        _ => bad = true,
                    }
                }
                Ok(if bad { Shape::BadDim } else { Shape::Count(count) })
            }
            fn visit_borrowed_str<E: de::Error>(self, _: &'de str) -> Result<Shape, E> {
                Ok(Shape::Missing)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Shape, E> {
                Ok(Shape::Missing)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Shape, E> {
                Ok(Shape::Missing)
            }
            visit_other!(Shape::Missing);
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Shape, A::Error> {
                drain_map(map).map(|_| Shape::Missing)
            }
        }
        d.deserialize_any(V)
    }
}

/// One tensor entry: `dtype` (borrowed) and the folded `shape`; other fields are skipped.
enum Tensor<'de> {
    NotObject,
    Object { dtype: Option<Cow<'de, str>>, shape: Shape },
}

impl<'de> Deserialize<'de> for Tensor<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Tensor<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a tensor object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Tensor<'de>, A::Error> {
                let mut dtype = None;
                let mut shape = Shape::Missing;
                while let Some(CowStr(k)) = map.next_key::<CowStr<'de>>()? {
                    match k.as_ref() {
                        "dtype" => {
                            dtype = match map.next_value::<Scalar<'de>>()? {
                                Scalar::Str(s) => Some(s),
                                _ => None,
                            }
                        }
                        "shape" => shape = map.next_value::<Shape>()?,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(Tensor::Object { dtype, shape })
            }
            fn visit_borrowed_str<E: de::Error>(self, _: &'de str) -> Result<Self::Value, E> {
                Ok(Tensor::NotObject)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(Tensor::NotObject)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(Tensor::NotObject)
            }
            visit_other!(Tensor::NotObject);
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
                drain_seq(seq).map(|_| Tensor::NotObject)
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Cursor;

    pub fn make_safetensors(header: &str, data_len: usize) -> Vec<u8> {
        let mut out = (header.len() as u64).to_le_bytes().to_vec();
        out.extend_from_slice(header.as_bytes());
        out.extend(std::iter::repeat_n(0u8, data_len));
        out
    }

    #[test]
    fn parses_header() {
        let header = r#"{"__metadata__":{"format":"pt","long":"abcdefghij"},
            "a.weight":{"dtype":"BF16","shape":[4,8],"data_offsets":[0,64]},
            "a.bias":{"dtype":"F32","shape":[8],"data_offsets":[64,96]},
            "b.weight":{"dtype":"BF16","shape":[2,2],"data_offsets":[96,104]},
            "scalar":{"dtype":"F32","shape":[],"data_offsets":[104,108]}}  "#;
        let bytes = make_safetensors(header, 108);
        let h = parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 4).unwrap();
        assert_eq!(h.header_bytes, header.len() as u64);
        assert_eq!(h.tensor_count, 4);
        assert_eq!(h.parameter_count, 32 + 8 + 4 + 1);
        assert_eq!(h.dtypes.get("BF16"), Some(&2));
        assert_eq!(h.dtypes.get("F32"), Some(&2));
        assert_eq!(h.primary_dtype, "BF16");
        assert_eq!(h.metadata.get("format").unwrap(), "pt");
        assert_eq!(h.metadata.get("long").unwrap(), "abcd");
        assert!(h.metadata_truncated);
    }

    #[test]
    fn primary_dtype_is_by_parameters_not_count() {
        let header = r#"{"a":{"dtype":"F32","shape":[1000],"data_offsets":[0,4000]},
            "b":{"dtype":"F16","shape":[1],"data_offsets":[4000,4002]},
            "c":{"dtype":"F16","shape":[1],"data_offsets":[4002,4004]}}"#;
        let bytes = make_safetensors(header, 4004);
        let h = parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 4096).unwrap();
        assert_eq!(h.primary_dtype, "F32");
        assert!(!h.metadata_truncated);
        assert!(h.metadata.is_empty());
    }

    #[test]
    fn rejects_corrupt_headers() {
        // Huge declared length: must not allocate.
        let mut bytes = (u64::MAX / 2).to_le_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 10)
            .unwrap_err()
            .contains("exceeds limit"));
        // Longer than the file.
        let mut bytes = 1000u64.to_le_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 10).is_err());
        // Too short.
        assert!(parse_safetensors_header(&mut Cursor::new(&[1u8, 2]), 2, 10).is_err());
        // Not JSON.
        let bytes = make_safetensors("not json!", 0);
        assert!(parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 10).is_err());
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        assert_eq!(truncate_utf8("héllo".into(), 2), ("h".to_string(), true));
        assert_eq!(truncate_utf8("abc".into(), 3), ("abc".to_string(), false));
    }

    #[test]
    fn reads_exactly_prefix_and_header_never_tensor_data() {
        let header = r#"{"w":{"dtype":"F16","shape":[2,3],"data_offsets":[0,12]}}   "#;
        let bytes = make_safetensors(header, 1 << 20);
        let mut cur = Cursor::new(&bytes);
        let h = parse_safetensors_header(&mut cur, bytes.len() as u64, 16).unwrap();
        assert_eq!(cur.position(), 8 + header.len() as u64, "no read past the header");
        assert_eq!(h.parameter_count, 6);
        // And straight from a `File`, as `scan_file` does.
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("m.safetensors");
        std::fs::write(&p, &bytes).unwrap();
        let mut f = File::open(&p).unwrap();
        parse_safetensors_header(&mut f, bytes.len() as u64, 16).unwrap();
        use std::io::Seek;
        assert_eq!(f.stream_position().unwrap(), 8 + header.len() as u64);
    }

    #[test]
    fn streaming_parser_handles_escapes_extras_and_errors() {
        let header = r#"{"__metadata__":{"n":3,"s":"x\"y"},"a.b":{"shape":[2],"extra":{"k":[1,2]},"dtype":"F32","data_offsets":[0,8]},
            "c":{"dtype":"F32","shape":[3],"data_offsets":[8,20]}}"#;
        let bytes = make_safetensors(header, 20);
        let h = parse_safetensors_header(&mut Cursor::new(&bytes), bytes.len() as u64, 64).unwrap();
        assert_eq!(h.tensor_count, 2);
        assert_eq!(h.parameter_count, 5);
        assert_eq!(h.dtypes.get("F32"), Some(&2));
        assert_eq!(h.metadata.get("n").unwrap(), "3");
        assert_eq!(h.metadata.get("s").unwrap(), "x\"y");

        let err = |hdr: &str| {
            let b = make_safetensors(hdr, 0);
            parse_safetensors_header(&mut Cursor::new(&b), b.len() as u64, 8).unwrap_err()
        };
        assert!(err(r#"{"t":[1,2]}"#).contains("tensor 't' is not an object"));
        assert!(err(r#"{"t":{"shape":[1]}}"#).contains("tensor 't' has no dtype"));
        assert!(err(r#"{"t":{"dtype":7,"shape":[1]}}"#).contains("has no dtype"));
        assert!(err(r#"{"t":{"dtype":"F32"}}"#).contains("tensor 't' has no shape"));
        assert!(err(r#"{"t":{"dtype":"F32","shape":[1.5]}}"#).contains("non-integer dimension"));
        assert!(err(r#"{"t":{"dtype":"F32","shape":[-1]}}"#).contains("non-integer dimension"));
        assert!(err(r#"[1]"#).contains("header JSON"));
        assert!(err(r#"{} trailing"#).contains("header JSON"));
    }

    #[test]
    fn scans_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("vae")).unwrap();
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        let header = r#"{"w":{"dtype":"F16","shape":[2,3],"data_offsets":[0,12]}}"#;
        std::fs::write(root.join("vae/x.safetensors"), make_safetensors(header, 12)).unwrap();
        std::fs::write(root.join("vae/broken.safetensors"), b"xx").unwrap();
        std::fs::write(root.join("top.GGUF"), b"gguf").unwrap();
        std::fs::write(root.join(".cache/hidden.safetensors"), b"zz").unwrap();
        std::fs::write(root.join("vae/readme.txt"), b"no").unwrap();

        let scan = scan_dir(root, 4096);
        let rels: Vec<_> = scan.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["top.GGUF", "vae/broken.safetensors", "vae/x.safetensors"]);
        assert_eq!(scan.file_count, 3);
        let top = &scan.files[0];
        assert_eq!(top.category, "");
        assert_eq!(top.ext, "gguf");
        assert!(top.header.is_none() && top.header_error.is_none());
        let broken = &scan.files[1];
        assert!(broken.header.is_none() && broken.header_error.is_some());
        let x = &scan.files[2];
        assert_eq!(x.category, "vae");
        assert_eq!(x.header.as_ref().unwrap().parameter_count, 6);
        assert_eq!(scan.total_bytes, scan.files.iter().map(|f| f.bytes).sum::<u64>());

        let v = serde_json::to_value(&scan).unwrap();
        assert!(v["files"][2]["header"]["parameterCount"].is_u64());
        assert!(v["files"][2]["modifiedAt"].as_str().unwrap().ends_with('Z'));
        assert!(v["fileCount"].is_u64());
    }
}
