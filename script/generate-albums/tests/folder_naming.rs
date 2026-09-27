// Album naming for folders that don't follow "YYYY - Artist - Title": a part folder
// inside a release ("Extras", uqt's "UQT2011_Artist-Title" wrappers), a URL-slug folder
// from a blog post, and a cover saved under the album's name instead of cover.jpg.
// Runs the real binary on a throwaway music dir.

use std::io::Read;
use std::path::{Path, PathBuf};

use id3::{Tag, TagLike, Version};

fn fixture_mp3() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/silence.mp3")
}

fn music_dir(name: &str) -> PathBuf {
    let tmp = std::env::temp_dir().join(format!("tocador-naming-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("mkdir");
    tmp
}

fn add_track(dir: &Path, file: &str) -> PathBuf {
    std::fs::create_dir_all(dir).expect("mkdir");
    let p = dir.join(file);
    std::fs::copy(fixture_mp3(), &p).expect("copy fixture mp3");
    p
}

fn albums(music: &Path) -> Vec<serde_json::Value> {
    let out = music.join("out.json.gz");
    let ok = std::process::Command::new(env!("CARGO_BIN_EXE_generate-albums"))
        .arg(music).arg(&out).status().expect("run generate-albums").success();
    assert!(ok, "generate-albums exited non-zero");
    let mut json = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&out).expect("open output"))
        .read_to_string(&mut json).expect("gunzip");
    let v: serde_json::Value = serde_json::from_str(&json).expect("json");
    std::fs::remove_dir_all(music).ok();
    v["albums"].as_array().expect("albums").clone()
}

// The catalog omits has_cover when true (the player's default) and writes false.
fn has_cover(album: &serde_json::Value) -> bool {
    album.get("has_cover").map(|v| v == true).unwrap_or(true)
}

fn by_path<'a>(albums: &'a [serde_json::Value], path: &str) -> &'a serde_json::Value {
    albums.iter().find(|a| a["path"] == path).unwrap_or_else(|| panic!("no album {path}: {albums:?}"))
}

#[test]
fn a_part_folder_is_named_after_its_release_and_shares_its_cover() {
    let m = music_dir("part");
    let release = m.join("A Olivia - Obrigado Por Perguntar (2026)");
    add_track(&release, "01. Entretenimento.mp3");
    std::fs::write(release.join("Capa.jpg"), b"jpg").unwrap();
    add_track(&release.join("Extras"), "01. Superficie.mp3");

    let all = albums(&m);
    let extras = by_path(&all, "A Olivia - Obrigado Por Perguntar (2026)/Extras");
    assert_eq!(extras["title"], "Obrigado Por Perguntar (Extras)");
    assert_eq!(extras["artist"], "A Olivia");
    assert_eq!(extras["year"], 2026);
    assert!(has_cover(extras));
}

#[test]
fn a_wrapper_folder_repeating_the_release_name_adds_nothing_to_the_title() {
    let m = music_dir("wrapper");
    add_track(&m.join("2011 - Caraivana - Ser Feliz").join("UQT2011_Caraivana-SerFeliz"), "01 Faixa.mp3");

    let all = albums(&m);
    let a = by_path(&all, "2011 - Caraivana - Ser Feliz/UQT2011_Caraivana-SerFeliz");
    assert_eq!(a["title"], "Ser Feliz");
    assert_eq!(a["artist"], "Caraivana");
    assert_eq!(a["year"], 2011);
}

#[test]
fn a_slug_folder_takes_title_and_artists_from_id3_and_year_from_the_slug() {
    let m = music_dir("slug");
    let dir = m.join("lizard-cult-lotico-split-2026");
    for (file, artist) in [("Lizard Cult - Split - 01 Samsara.mp3", "Lizard Cult"), ("lōtico - Split - 02 Redenção.mp3", "lōtico")] {
        let p = add_track(&dir, file);
        let mut tag = Tag::new();
        tag.set_artist(artist);
        tag.set_album("Split");
        tag.set_album_artist("Lizard Cult / lōtico");
        tag.write_to_path(&p, Version::Id3v24).expect("write id3");
    }

    let all = albums(&m);
    let a = by_path(&all, "lizard-cult-lotico-split-2026");
    assert_eq!(a["title"], "Split");
    assert_eq!(a["artist"], "Lizard Cult; lōtico");
    assert_eq!(a["year"], 2026);
}

#[test]
fn a_slug_folder_with_no_id3_album_keeps_the_slug_as_title() {
    let m = music_dir("slug-bare");
    add_track(&m.join("some-band-some-record"), "01 Faixa.mp3");
    let all = albums(&m);
    assert_eq!(by_path(&all, "some-band-some-record")["title"], "some-band-some-record");
}

#[test]
fn any_image_counts_as_a_cover_like_the_uploader_uses() {
    let m = music_dir("cover");
    let dir = m.join("Purple Ties - Purple Void (2026)");
    add_track(&dir, "01 Stunning.mp3");
    std::fs::write(dir.join("Purple Ties - Purple Void.jpg"), b"jpg").unwrap();
    add_track(&m.join("2020 - Sem Capa - Nada"), "01 Faixa.mp3");
    std::fs::write(m.join("2020 - Sem Capa - Nada").join("Capa.png"), b"png").unwrap();
    add_track(&m.join("2020 - Sem Nada - Nada"), "01 Faixa.mp3");
    std::fs::write(m.join("2020 - Sem Nada - Nada").join("notas.pdf"), b"pdf").unwrap();

    let all = albums(&m);
    assert!(has_cover(by_path(&all, "Purple Ties - Purple Void (2026)")));
    assert!(has_cover(by_path(&all, "2020 - Sem Capa - Nada"))); // PNG: the uploader re-encodes it
    assert!(!has_cover(by_path(&all, "2020 - Sem Nada - Nada")));
}

#[test]
fn a_slug_folder_twin_loses_to_the_properly_named_folder() {
    // Same post downloaded twice: once named, once into its URL slug. Both read as
    // "Cepacaína - A Melhor Banda do Mundo (2012)"; only the named one may survive,
    // whichever order the folders are walked in.
    for (name, slug) in [("a", "2012 - cepacaina-melhor-banda-do-mundo-2012"), ("0", "2012 - 0-cepacaina-melhor-banda-do-mundo-2012")] {
        let m = music_dir(&format!("slug-twin-{name}"));
        for dir in ["2012 - Cepacaína - A Melhor Banda do Mundo", slug] {
            let p = add_track(&m.join(dir), "01 - Cepacaína - Amor Doentio.mp3");
            let mut tag = Tag::new();
            tag.set_title("Amor Doentio");
            tag.set_artist("Cepacaína");
            tag.set_album("A Melhor Banda do Mundo");
            tag.write_to_path(&p, Version::Id3v24).expect("write id3");
        }
        let all = albums(&m);
        let paths: Vec<_> = all.iter().map(|a| a["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["2012 - Cepacaína - A Melhor Banda do Mundo"]);
    }
}
