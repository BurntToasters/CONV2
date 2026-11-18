//! Small file helpers shared by the FFmpeg modules: SHA-256 digests (a
//! dependency-free port of build.rs's FIPS 180-4 implementation, since the
//! app manifest deliberately has no hashing crate) and crash-safe writes.

// Failure modes:
// - a swapped or truncated binary: hashing streams the whole file, so any
//   byte change alters the digest verification compares.
// - a read error mid-file: sha256_file/sha256_range propagate the io error;
//   callers fail closed rather than trusting a partial digest.
// - a crash during a cache write: atomic_write stages a `.tmp` file and
//   renames it over the target, so readers never observe a half-written file.

use std::io::Read;
use std::path::{Path, PathBuf};

const CHUNK: usize = 8192;

#[derive(Clone)]
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
                0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        self.total_len += data.len() as u64;
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            offset += take;
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while offset + 64 <= data.len() {
            let block: [u8; 64] = data[offset..offset + 64].try_into().unwrap();
            self.compress(&block);
            offset += 64;
        }
        if offset < data.len() {
            let remaining = data.len() - offset;
            self.buf[..remaining].copy_from_slice(&data[offset..]);
            self.buf_len = remaining;
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len * 8;
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for byte in self.buf[self.buf_len..64].iter_mut() {
                *byte = 0;
            }
            let block = self.buf;
            self.compress(&block);
            self.buf = [0u8; 64];
            self.buf_len = 0;
        }
        for byte in self.buf[self.buf_len..56].iter_mut() {
            *byte = 0;
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        self.compress(&block);

        let mut out: [u8; 32] = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        #[rustfmt::skip]
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
            0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
            0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];

        let mut w = [0u32; 64];
        for (index, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes(block[index * 4..index * 4 + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 =
                w[index - 15].rotate_right(7) ^ w[index - 15].rotate_right(18) ^ (w[index - 15] >> 3);
            let s1 =
                w[index - 2].rotate_right(17) ^ w[index - 2].rotate_right(19) ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Incremental SHA-256 over heterogeneous chunks (Authenticode candidates hash
/// a patched header, a file body range, and a tail). Clone before `finish`
/// to fork one base hash into several candidates.
#[derive(Clone)]
pub struct Sha256Stream(Sha256);

impl Sha256Stream {
    pub fn new() -> Self {
        Self(Sha256::new())
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    /// Lowercase hex digest; consumes the stream.
    pub fn finish(self) -> String {
        hex_digest(&self.0.finalize())
    }
}

impl Default for Sha256Stream {
    fn default() -> Self {
        Self::new()
    }
}

/// Lowercase hex SHA-256 of a whole file. Read errors propagate so integrity
/// checks fail closed.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; CHUNK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

/// Lowercase hex SHA-256 of `length` bytes starting at `offset`. Used for one
/// arch slice of a macOS universal binary. A range past EOF is an error.
pub fn sha256_range(path: &Path, offset: u64, length: u64) -> std::io::Result<String> {
    use std::io::Seek;
    let mut file = std::fs::File::open(path)?;
    file.seek(std::io::SeekFrom::Start(offset))?;
    let mut hasher = Sha256::new();
    let mut remaining = length;
    let mut buffer = [0u8; CHUNK];
    while remaining > 0 {
        let want = remaining.min(CHUNK as u64) as usize;
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "hash range extends past end of file",
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(hex_digest(&hasher.finalize()))
}

/// Write `contents` to `path` via a `.tmp` sibling and rename, so a reader
/// either sees the old file or the complete new one. The file is fsynced
/// before the rename so a crash or full disk cannot leave truncated state.
pub fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut staged = path.as_os_str().to_owned();
    staged.push(".tmp");
    let staged = PathBuf::from(staged);
    if let Some(parent) = staged.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let result = (|| {
        let mut file = std::fs::File::create(&staged)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&staged, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

/// Pretty JSON written atomically.
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(path, &serialized).map_err(|error| error.to_string())
}

/// Read a UTF-8 file of at most `max_bytes`. A missing file is `Ok(None)`.
pub fn read_bounded(path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is {} bytes (max {max_bytes})",
            path.display(),
            metadata.len()
        ));
    }
    let mut contents = String::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(max_bytes + 1).read_to_string(&mut contents))
        .map_err(|error| error.to_string())?;
    Ok(Some(contents))
}

/// Parse a bounded JSON file; a missing or invalid file is `None`.
pub fn read_json(path: &Path, max_bytes: u64) -> Option<serde_json::Value> {
    match read_bounded(path, max_bytes) {
        Ok(Some(raw)) => match serde_json::from_str(&raw) {
            Ok(value) => Some(value),
            Err(error) => {
                crate::logging::warn(&format!("Could not parse {}: {error}", path.display()));
                None
            }
        },
        Ok(None) => None,
        Err(error) => {
            crate::logging::warn(&format!("Could not read {}: {error}", path.display()));
            None
        }
    }
}

// Coverage for these helpers lives with the FFmpeg gate that consumes them
// (src-tauri/src/ffmpeg_status.rs), so this file stays free of a second
// #[cfg(test)] compilation once the conversion port declares it at the root.

