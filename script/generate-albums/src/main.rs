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

static RE_ARTIST_ALBUM_YEAR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s*[-–]\s*(.+?)\s*\((\d{4})\)\s*$").unwrap()
});
static RE_YEAR_ARTIST_ALBUM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4})\s*[-–]\s*(.+?)\s*[-–]\s*(.+)$").unwrap()
});
static RE_ALBUM_YEAR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s*\((\d{4})\)\s*$").unwrap()
});

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
    mp3_duration::from_path(path)
        .map(|d| d.as_secs() as u32)
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

fn collect_mp3s(folder: &Path) -> Vec<PathBuf> {
    let mut mp3s: Vec<PathBuf> = WalkDir::new(folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            e.file_type().is_file() && name.ends_with(".mp3") && !name.starts_with("._")
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    mp3s.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });
    mp3s
}

fn process_album(folder: &Path) -> Option<Album> {
    let mp3s = collect_mp3s(folder);
    if mp3s.is_empty() {
        return None;
    }

    let folder_name = folder.file_name()?.to_string_lossy().into_owned();
    let (mut album_artist, mut album_title, mut album_year) = (String::new(), String::new(), 0u32);
    let mut tracks = Vec::new();

    for mp3 in &mp3s {
        let (title, artist, album, year, track_n, dur_hint) = read_id3(mp3);
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
            mp3.file_stem().unwrap_or_default().to_string_lossy().into_owned()
        } else {
            title
        };
        let track_artist = if artist.is_empty() { album_artist.clone() } else { artist };
        tracks.push(Track { title, num: Some(track_n), file, artists: Some(track_artist), duration });
    }

    // Fall back to folder name parsing when ID3 tags are missing or incomplete
    if album_artist.is_empty() || album_title.is_empty() || album_year == 0 {
        let (fa, ft, fy) = parse_folder_name(&folder_name);
        if album_artist.is_empty() { album_artist = fa; }
        if album_title.is_empty()  { album_title  = ft; }
        if album_year  == 0        { album_year   = fy; }
    }

    // Omit artists when it duplicates the album artist; omit num when it equals array position.
    for (i, t) in tracks.iter_mut().enumerate() {
        if t.artists.as_deref() == Some(album_artist.as_str()) {
            t.artists = None;
        }
        if t.num == Some((i + 1) as u32) {
            t.num = None;
        }
    }

    Some(Album {
        title: album_title,
        artist: album_artist,
        year: album_year,
        path: folder_name,
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
}

fn parse_args() -> Config {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("Uso: generate-albums <pasta-de-musicas> [saida.json.gz]");
        eprintln!("     [--title \"Nome do Acervo\"] [--subtitle \"Subtítulo\"]");
        eprintln!("     [--hours \"42\"] [--base-url \"https://cdn.exemplo.com/musicas\"] [--s3-prefix \"indie/\"]");
        std::process::exit(if args.is_empty() { 1 } else { 0 });
    }

    let mut positional = vec![];
    let mut meta_title = None;
    let mut meta_subtitle = None;
    let mut meta_hours = None;
    let mut meta_base_url = None;
    let mut meta_s3_prefix = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--title"     => { i += 1; meta_title     = args.get(i).cloned(); }
            "--subtitle"  => { i += 1; meta_subtitle  = args.get(i).cloned(); }
            "--hours"     => { i += 1; meta_hours     = args.get(i).cloned(); }
            "--base-url"  => { i += 1; meta_base_url  = args.get(i).cloned(); }
            "--s3-prefix" => { i += 1; meta_s3_prefix = args.get(i).cloned(); }
            other         => positional.push(other.to_string()),
        }
        i += 1;
    }

    let music_dir = PathBuf::from(&positional[0]);
    let output = positional.get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("acervo.json.gz"));

    Config { music_dir, output, meta_title, meta_subtitle, meta_hours, meta_base_url, meta_s3_prefix }
}

fn main() {
    let cfg = parse_args();

    if !cfg.music_dir.is_dir() {
        eprintln!("Erro: pasta não encontrada — {}", cfg.music_dir.display());
        std::process::exit(1);
    }

    let mut folders: Vec<PathBuf> = fs::read_dir(&cfg.music_dir)
        .expect("Não foi possível abrir a pasta de músicas")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && !e.file_name().to_string_lossy().starts_with('_')
        })
        .map(|e| e.path())
        .collect();

    folders.sort_by(|a, b| {
        a.file_name().unwrap_or_default().to_string_lossy().to_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });

    let total = folders.len();
    println!("Processando {} pastas...", total);

    let counter = AtomicUsize::new(0);
    let mut albums: Vec<Album> = folders
        .par_iter()
        .filter_map(|folder| {
            let result = process_album(folder);
            let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 200 == 0 || n == total {
                eprint!("\r  [{n}/{total}]   ");
            }
            result
        })
        .collect();

    eprintln!("\r  [{total}/{total}] pronto        ");

    albums.sort_by(|a, b| b.year.cmp(&a.year));

    let output = Output {
        meta: Meta {
            title: cfg.meta_title,
            subtitle: cfg.meta_subtitle,
            hours: cfg.meta_hours,
            base_url: cfg.meta_base_url,
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
}
