// Regression coverage for: --v2 is CLI-only and has no acervo.json fallback, so a
// regeneration run for an unrelated reason (e.g. a sitemap fix) silently dropped an
// archive back to v1 (hit both uqt and homi in practice — see CLAUDE.md). Exercises
// the real binary end to end, not just the merge logic, so a future refactor of how
// the flag is wired can't quietly reopen the gap.

use std::io::Read;
use std::path::Path;

fn fixture_mp3() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/silence.mp3")
}

fn run_generate_albums(music_dir: &Path, out_gz: &Path) -> bool {
    std::process::Command::new(env!("CARGO_BIN_EXE_generate-albums"))
        .arg(music_dir)
        .arg(out_gz)
        .status()
        .expect("failed to run generate-albums")
        .success()
}

fn decode_gz(path: &Path) -> serde_json::Value {
    let mut json = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).expect("open output"))
        .read_to_string(&mut json)
        .expect("gunzip output");
    serde_json::from_str(&json).unwrap_or_else(|e| panic!("invalid JSON ({e}): {json}"))
}

fn make_music_dir(name: &str) -> std::path::PathBuf {
    let tmp = std::env::temp_dir().join(format!("tocador-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let album_dir = tmp.join("2020 - Test Artist - Test Album");
    std::fs::create_dir_all(&album_dir).expect("mkdir");
    std::fs::copy(fixture_mp3(), album_dir.join("01 Test Track.mp3")).expect("copy fixture mp3");
    tmp
}

#[test]
fn v2_setting_in_acervo_json_survives_a_run_with_no_cli_flag() {
    let tmp = make_music_dir("v2-persist");
    std::fs::write(tmp.join("acervo.json"), r#"{"v2": true}"#).expect("write acervo.json");

    let out_gz = tmp.join("out.json.gz");
    // Deliberately omit --v2: acervo.json alone must be enough.
    assert!(run_generate_albums(&tmp, &out_gz), "generate-albums exited non-zero");

    let parsed = decode_gz(&out_gz);
    assert_eq!(parsed["v"], 2, "expected v2 payload, got: {parsed}");
    assert!(parsed.get("a").is_some(), "v2 payload missing columnar `a` section");
    assert!(parsed.get("albums").is_none(), "v1 `albums` key leaked into v2 output");

    std::fs::remove_dir_all(&tmp).ok();
}

// Sibling case: no CLI flag and no acervo.json "v2" key still defaults to v1 — guards
// against a fix that makes v2 the default instead of just persisting an explicit opt-in.
#[test]
fn no_v2_setting_anywhere_still_defaults_to_v1() {
    let tmp = make_music_dir("v1-default");
    // No acervo.json at all.

    let out_gz = tmp.join("out.json.gz");
    assert!(run_generate_albums(&tmp, &out_gz), "generate-albums exited non-zero");

    let parsed = decode_gz(&out_gz);
    assert!(parsed.get("v").is_none(), "expected v1 payload (no `v` key), got: {parsed}");
    assert!(parsed.get("albums").is_some(), "v1 payload missing `albums` key");

    std::fs::remove_dir_all(&tmp).ok();
}

// The CLI flag must still work standalone (no acervo.json needed) — this was the
// only way to get v2 before this fix, and must keep working after it.
#[test]
fn cli_flag_still_forces_v2_without_acervo_json() {
    let tmp = make_music_dir("v2-cli-flag");
    // No acervo.json at all.

    let out_gz = tmp.join("out.json.gz");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_generate-albums"))
        .arg(&tmp)
        .arg(&out_gz)
        .arg("--v2")
        .status()
        .expect("failed to run generate-albums");
    assert!(status.success(), "generate-albums exited non-zero");

    let parsed = decode_gz(&out_gz);
    assert_eq!(parsed["v"], 2, "expected v2 payload, got: {parsed}");

    std::fs::remove_dir_all(&tmp).ok();
}
