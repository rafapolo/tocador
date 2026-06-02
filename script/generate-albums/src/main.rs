use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use flate2::{write::GzEncoder, Compression};
use id3::{Tag, TagLike};
use once_cell::sync::Lazy;
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use walkdir::WalkDir;

const IMAGE_EXTS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp"];
const COVER_PRIORITY: &[&str] = &["cover", "capa", "folder", "front", "artwork", "albumart"];

// Matches OS copy suffixes like " (2)", " (3)" — not "(1)" and not 4-digit years
static RE_COPY_SUFFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.*)\s+\(([2-9]|[1-9]\d{1,2})\)\s*$").unwrap()
});
static RE_ARTIST_ALBUM_YEAR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s*[-–]\s*(.+?)\s*\((\d{4})\)\s*$").unwrap()
});
static RE_YEAR_ARTIST_ALBUM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4})\s*[-–]\s*(.+?)\s*[-–]\s*(.+)$").unwrap()
});
static RE_ALBUM_YEAR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s*\((\d{4})\)\s*$").unwrap()
});
static RE_YEAR_ALBUM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4})\s*[-–]\s*(.+)$").unwrap()
});
// Track number from filename: "01. Title", "01-Title", "01_Title", "01 Title"
static RE_TRACK_NUM_START: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{1,3})[\.\-_\s]").unwrap()
});
// Track number embedded mid-filename: "Artist - Album - 01 Title", "Artist - Album - 01. Title"
static RE_TRACK_NUM_MID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[-–]\s*(\d{1,3})[\.\s]").unwrap()
});
// Slug-style filename: all-lowercase, hyphens only, no spaces — signals a "full album as one MP3"
// artifact mixed into an extracted archive (e.g. bando-mastodontes-ciranda-celestial-2022.mp3)
static RE_SLUG_TAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[a-z][a-z0-9\-]+\.mp3$").unwrap()
});
// Strip leading track-number prefix from filename-derived titles ("01. ", "02 - ", "03_", etc.)
static RE_TRACK_NUM_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\d{1,3}[\.\-_\s]+").unwrap()
});

// Per-directory config file (acervo.json in the music root)

#[derive(serde::Deserialize, Default)]
struct DirConfig {
    title:    Option<String>,
    subtitle: Option<String>,
}

// Tocador-compatible schema

#[derive(Serialize)]
struct Track {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    num: Option<u32>,
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artists: Option<String>,
    duration: u32,
}

#[derive(Serialize)]
struct Album {
    title: String,
    artist: String,
    year: u32,
    path: String,
    #[serde(skip_serializing_if = "Clone::clone")]
    has_cover: bool,
    tracks: Vec<Track>,
}

#[derive(Serialize)]
struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hours: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    s3_prefix: Option<String>,
}

#[derive(Serialize)]
struct Output {
    meta: Meta,
    albums: Vec<Album>,
}

fn parse_folder_name(name: &str) -> (String, String, u32) {
    if let Some(caps) = RE_YEAR_ARTIST_ALBUM.captures(name) {
        let year = caps[1].parse().unwrap_or(0);
        return (caps[2].trim().to_string(), caps[3].trim().to_string(), year);
    }
    if let Some(caps) = RE_ARTIST_ALBUM_YEAR.captures(name) {
        let year = caps[3].parse().unwrap_or(0);
        return (caps[1].trim().to_string(), caps[2].trim().to_string(), year);
    }
    if let Some(caps) = RE_ALBUM_YEAR.captures(name) {
        let year = caps[2].parse().unwrap_or(0);
        return (String::new(), caps[1].trim().to_string(), year);
    }
    if let Some(caps) = RE_YEAR_ALBUM.captures(name) {
        let year = caps[1].parse().unwrap_or(0);
        return (String::new(), caps[2].trim().to_string(), year);
    }
    (String::new(), name.to_string(), 0)
}

fn read_id3(path: &Path) -> (String, String, String, u32, u32, u32) {
    match Tag::read_from_path(path) {
        Ok(tag) => {
            let title  = tag.title().unwrap_or("").trim().to_string();
            let artist = tag.artist().unwrap_or("").trim().to_string();
            let album  = tag.album().unwrap_or("").trim().to_string();
            let year   = tag.year().map(|y| y as u32).unwrap_or(0);
            let track  = tag.track().unwrap_or(0);
            let dur_hint = tag.duration().unwrap_or(0) / 1000;
            (title, artist, album, year, track, dur_hint)
        }
        Err(_) => Default::default(),
    }
}

fn read_duration(path: &Path, hint: u32) -> u32 {
    if hint > 0 {
        return hint;
    }
    use lofty::prelude::AudioFile;
    use lofty::probe::Probe;
    if let Some(d) = Probe::open(path)
        .ok()
        .and_then(|p| p.guess_file_type().ok())
        .and_then(|p| p.read().ok())
        .map(|f| f.properties().duration().as_secs() as u32)
        .filter(|&d| d > 0)
    {
        return d;
    }
    // fallback: ffprobe handles edge cases lofty can't (non-standard VBR headers, etc.)
    std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|d| d as u32)
        .unwrap_or(0)
}

fn has_cover(folder: &Path) -> bool {
    fs::read_dir(folder)
        .map(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| {
                e.file_type().map(|t| t.is_file()).unwrap_or(false) && {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    let stem = Path::new(&*name)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    IMAGE_EXTS.iter().any(|ext| name.ends_with(ext))
                        && COVER_PRIORITY.iter().any(|p| stem.contains(p))
                }
            })
        })
        .unwrap_or(false)
}

// Natural sort: compares digit runs numerically so "10 - Track" sorts after "2 - Track".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _)    => return std::cmp::Ordering::Less,
            (_, None)    => return std::cmp::Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let an: u64 = std::iter::from_fn(|| ai.next_if(|c| c.is_ascii_digit()))
                        .fold(0u64, |n, c| n * 10 + c.to_digit(10).unwrap() as u64);
                    let bn: u64 = std::iter::from_fn(|| bi.next_if(|c| c.is_ascii_digit()))
                        .fold(0u64, |n, c| n * 10 + c.to_digit(10).unwrap() as u64);
                    match an.cmp(&bn) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                } else {
                    let ord = ac.to_lowercase().cmp(bc.to_lowercase());
                    ai.next(); bi.next();
                    if ord != std::cmp::Ordering::Equal { return ord; }
                }
            }
        }
    }
}

fn collect_mp3s(folder: &Path) -> Vec<PathBuf> {
    let mut mp3s: Vec<PathBuf> = fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    e.file_type().map(|t| t.is_file()).unwrap_or(false)
                        && name.ends_with(".mp3")
                        && !name.starts_with("._")
                })
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    mp3s.sort_by(|a, b| {
        natural_cmp(
            &a.file_name().unwrap_or_default().to_string_lossy().to_lowercase(),
            &b.file_name().unwrap_or_default().to_string_lossy().to_lowercase(),
        )
    });
    mp3s
}

fn process_album(folder: &Path, music_dir: &Path) -> Option<Album> {
    let mp3s = collect_mp3s(folder);
    if mp3s.is_empty() {
        return None;
    }

    let folder_name = folder.file_name()?.to_string_lossy().into_owned();
    let rel_path = folder.strip_prefix(music_dir).ok()?.to_string_lossy().replace('\\', "/");
    // Folder name is the authoritative source for album-level metadata; ID3 fills gaps only.
    let (fa, ft, fy) = parse_folder_name(&folder_name);
    let (mut album_artist, mut album_title, mut album_year) = (fa, ft, fy);
    let mut tracks = Vec::new();

    for mp3 in &mp3s {
        let (title, artist, album, year, mut track_n, dur_hint) = read_id3(mp3);
        if track_n == 0 {
            let fname = mp3.file_name().unwrap_or_default().to_string_lossy();
            track_n = RE_TRACK_NUM_START.captures(&*fname)
                .or_else(|| RE_TRACK_NUM_MID.captures(&*fname))
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .unwrap_or(0);
        }
        let duration = read_duration(mp3, dur_hint);

        if album_artist.is_empty() && !artist.is_empty() { album_artist = artist.clone(); }
        if album_title.is_empty()  && !album.is_empty()  { album_title  = album; }
        if album_year  == 0        && year > 0            { album_year   = year; }

        let file = mp3
            .strip_prefix(folder)
            .ok()?
            .to_string_lossy()
            .into_owned();
        let title = if title.is_empty() {
            let stem = mp3.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let stripped = RE_TRACK_NUM_STRIP.find(&stem).map(|m| stem[m.end()..].trim()).unwrap_or(&stem);
            stripped.to_string()
        } else {
            title
        };
        let track_artist = if artist.is_empty() { album_artist.clone() } else { artist };
        tracks.push(Track { title, num: Some(track_n), file, artists: Some(track_artist), duration });
    }

    // Drop slug-tail: a kebab-case single-file artifact (e.g. artist-album-year.mp3) that gets
    // mixed in when a single-MP3 download lands in the same folder as the extracted archive tracks.
    if tracks.len() > 1 {
        let is_slug = tracks.last().map(|t| RE_SLUG_TAIL.is_match(&t.file)).unwrap_or(false);
        if is_slug {
            let rest_have_nums = tracks[..tracks.len() - 1].iter().any(|t| {
                RE_TRACK_NUM_START.is_match(&t.file) || RE_TRACK_NUM_MID.is_match(&t.file)
            });
            if rest_have_nums {
                tracks.pop();
            }
        }
    }

    // Sort by track number when any track has one, so the player's array position matches
    // the intended playback order. Covers two cases:
    //   - compilations where filenames sort by artist prefix instead of track number
    //   - albums where an ID3 track number is correct but the file sorts alphabetically wrong
    // Unnumbered tracks (num=0) go after numbered ones in their original relative order.
    // Uses indexed drain to avoid pointer aliasing during in-place sort.
    if tracks.iter().any(|t| t.num.unwrap_or(0) > 0) {
        let mut indexed: Vec<(usize, Track)> = tracks.drain(..).enumerate().collect();
        indexed.sort_by(|(ai, a), (bi, b)| {
            match (a.num.unwrap_or(0), b.num.unwrap_or(0)) {
                (0, 0) => ai.cmp(bi),
                (0, _) => std::cmp::Ordering::Greater,
                (_, 0) => std::cmp::Ordering::Less,
                (an, bn) => an.cmp(&bn).then(ai.cmp(bi)),
            }
        });
        tracks = indexed.into_iter().map(|(_, t)| t).collect();
    }

    // Omit artists when it duplicates the album artist; omit num when it equals array position
    // or is 0 (no track number in ID3 and filename gave no hint either).
    for (i, t) in tracks.iter_mut().enumerate() {
        if t.artists.as_deref() == Some(album_artist.as_str()) {
            t.artists = None;
        }
        if t.num == Some(0) || t.num == Some((i + 1) as u32) {
            t.num = None;
        }
    }

    Some(Album {
        title: album_title,
        artist: album_artist,
        year: album_year,
        path: rel_path,
        has_cover: has_cover(folder),
        tracks,
    })
}

struct Config {
    music_dir: PathBuf,
    output: PathBuf,
    meta_title: Option<String>,
    meta_subtitle: Option<String>,
    meta_hours: Option<String>,
    meta_base_url: Option<String>,
    meta_s3_prefix: Option<String>,
    meta_sitemap_url: Option<String>, // overrides base_url for sitemap <loc>
}

fn parse_args() -> Config {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("Uso: generate-albums <pasta-de-musicas> [saida.json.gz]");
        eprintln!("     [--title \"Nome do Acervo\"] [--subtitle \"Subtítulo\"]");
        eprintln!("     [--hours \"42\"] [--base-url \"https://cdn.exemplo.com/musicas\"] [--s3-prefix \"indie/\"]");
        eprintln!("     [--sitemap-url \"https://exemplo.com/player\"]");
        std::process::exit(if args.is_empty() { 1 } else { 0 });
    }

    let mut positional = vec![];
    let mut meta_title = None;
    let mut meta_subtitle = None;
    let mut meta_hours = None;
    let mut meta_base_url = None;
    let mut meta_s3_prefix = None;
    let mut meta_sitemap_url = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--title"       => { i += 1; meta_title       = args.get(i).cloned(); }
            "--subtitle"    => { i += 1; meta_subtitle    = args.get(i).cloned(); }
            "--hours"       => { i += 1; meta_hours       = args.get(i).cloned(); }
            "--base-url"    => { i += 1; meta_base_url    = args.get(i).cloned(); }
            "--s3-prefix"   => { i += 1; meta_s3_prefix   = args.get(i).cloned(); }
            "--sitemap-url" => { i += 1; meta_sitemap_url = args.get(i).cloned(); }
            other           => positional.push(other.to_string()),
        }
        i += 1;
    }

    let music_dir = PathBuf::from(&positional[0]);
    let output = positional.get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("acervo.json.gz"));

    Config { music_dir, output, meta_title, meta_subtitle, meta_hours, meta_base_url, meta_s3_prefix, meta_sitemap_url }
}

fn main() {
    let cfg = parse_args();

    if !cfg.music_dir.is_dir() {
        eprintln!("Erro: pasta não encontrada — {}", cfg.music_dir.display());
        std::process::exit(1);
    }

    let dir_cfg: DirConfig = fs::read_to_string(cfg.music_dir.join("acervo.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // base_url: CLI flag → .env in music dir → BASE_URL env var
    let env_base_url = fs::read_to_string(cfg.music_dir.join(".env")).ok()
        .and_then(|s| {
            s.lines()
                .filter(|l| !l.starts_with('#'))
                .find(|l| l.trim_start().starts_with("BASE_URL="))
                .map(|l| l.splitn(2, '=').nth(1).unwrap_or("").trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("BASE_URL").ok());

    let meta_title    = cfg.meta_title   .or(dir_cfg.title);
    let meta_subtitle = cfg.meta_subtitle.or(dir_cfg.subtitle);
    let meta_base_url = cfg.meta_base_url.or(env_base_url);

    let mut folders: Vec<PathBuf> = WalkDir::new(&cfg.music_dir)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_dir()
                && !e.file_name().to_string_lossy().starts_with('_')
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    folders.sort_by(|a, b| {
        a.file_name().unwrap_or_default().to_string_lossy().to_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });

    let total = folders.len();
    println!("Processando {} pastas...", total);

    let counter = AtomicUsize::new(0);
    let music_dir = &cfg.music_dir;
    let albums: Vec<Album> = folders
        .par_iter()
        .filter_map(|folder| {
            let result = process_album(folder, music_dir);
            let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 200 == 0 || n == total {
                eprint!("\r  [{n}/{total}]   ");
            }
            result
        })
        .collect();

    eprintln!("\r  [{total}/{total}] pronto        ");

    // Merge albums split across OS-numbered copies ("Álbum (2)", "Álbum (3)" → "Álbum").
    // Only merges when the base album already exists; preserves original path otherwise.
    // Only re-sorts tracks for albums that actually absorbed copy-folder tracks; unmerged
    // albums already have the correct order from process_album's sort-by-num pass.
    let albums = {
        let mut merged: Vec<Album> = Vec::with_capacity(albums.len());
        let mut absorbed_indices: std::collections::HashSet<usize> = Default::default();
        for mut album in albums {
            let base = RE_COPY_SUFFIX.captures(&album.path).map(|c| c[1].to_string());
            let absorbed = if let Some(ref base_path) = base {
                if let Some((idx, existing)) = merged.iter_mut().enumerate().find(|(_, a)| a.path == *base_path) {
                    for t in album.tracks.drain(..) {
                        if !existing.tracks.iter().any(|e| e.file == t.file) {
                            existing.tracks.push(t);
                        }
                    }
                    if album.has_cover { existing.has_cover = true; }
                    absorbed_indices.insert(idx);
                    true
                } else { false }
            } else { false };
            if !absorbed {
                merged.push(album);
            }
        }
        for (i, a) in merged.iter_mut().enumerate() {
            if absorbed_indices.contains(&i) {
                a.tracks.sort_by(|x, y| natural_cmp(&x.file.to_lowercase(), &y.file.to_lowercase()));
            }
        }
        merged
    };
    let mut albums = albums;

    albums.sort_by(|a, b| b.year.cmp(&a.year));

    let total_secs: u64 = albums.iter()
        .flat_map(|a| a.tracks.iter())
        .map(|t| t.duration as u64)
        .sum();
    let meta_hours = cfg.meta_hours.or_else(|| {
        (total_secs > 0).then(|| format!("{}", (total_secs as f64 / 3600.0).round() as u64))
    });

    let output = Output {
        meta: Meta {
            title: meta_title,
            subtitle: meta_subtitle,
            hours: meta_hours,
            base_url: meta_base_url,
            s3_prefix: cfg.meta_s3_prefix,
        },
        albums,
    };

    let json = serde_json::to_string(&output).expect("Falha na serialização JSON");

    let out_gz = if cfg.output.extension().map(|e| e == "gz").unwrap_or(false) {
        cfg.output.clone()
    } else {
        cfg.output.with_extension("json.gz")
    };

    let gz_file = fs::File::create(&out_gz).expect("Não foi possível criar o arquivo .gz");
    let mut gz = GzEncoder::new(gz_file, Compression::default());
    gz.write_all(json.as_bytes()).expect("Falha ao escrever");
    gz.finish().expect("Falha ao finalizar gzip");

    let n_albums = output.albums.len();
    let size_gz = fs::metadata(&out_gz).map(|m| m.len() / 1024).unwrap_or(0);
    println!("{} álbuns  →  {} ({size_gz} KB)", n_albums, out_gz.display());

    if let Some(ref sitemap_url) = cfg.meta_sitemap_url {
        let sitemap_out = out_gz.parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("sitemap.xml"))
            .unwrap_or_else(|| PathBuf::from("sitemap.xml"));
        write_sitemap(&output.albums, sitemap_url, &sitemap_out);
    }
}

fn is_leap(y: u32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn today_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut days = (secs / 86400) as u32;
    let mut year = 1970u32;
    loop {
        let in_year = if is_leap(year) { 366 } else { 365 };
        if days < in_year { break; }
        days -= in_year;
        year += 1;
    }
    let month_days = [31u32, if is_leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    for &m in &month_days {
        if days < m { break; }
        days -= m;
        month += 1;
    }
    format!("{:04}-{:02}-{:02}", year, month, days + 1)
}

fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' |
            b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

fn write_sitemap(albums: &[Album], base_url: &str, sitemap_path: &Path) {
    let today = today_iso();
    let base = base_url.trim_end_matches('/');

    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n");

    for album in albums {
        let album_param = form_encode(&album.path);
        let mut loc = format!("{}/?album={}", base, album_param);
        if !album.artist.is_empty() {
            loc.push_str(&format!("&amp;artist={}", form_encode(&album.artist)));
        }
        let priority = if album.year >= 2020 { "0.9" } else if album.year >= 2010 { "0.7" } else { "0.5" };
        xml.push_str(&format!(
            "  <url>\n    <loc>{}</loc>\n    <lastmod>{}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>{}</priority>\n  </url>\n",
            loc, today, priority
        ));
    }

    xml.push_str("</urlset>\n");
    fs::write(&sitemap_path, xml).expect("Falha ao escrever sitemap.xml");
    let size = fs::metadata(&sitemap_path).map(|m| m.len() / 1024).unwrap_or(0);
    println!("sitemap.xml  →  {} ({} KB, {} URLs)", sitemap_path.display(), size, albums.len());
}
