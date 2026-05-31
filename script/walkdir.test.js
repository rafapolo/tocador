import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Logic mirrored from sync-to-bucket.js — keep in sync if ALLOWED_EXTS or walkDir changes
const ALLOWED_EXTS = new Set(['.mp3', '.jpg', '.jpeg', '.png', '.json', '.gz']);

function walkDir(dir, base = dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      entries.push(...walkDir(full, base));
    } else {
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_EXTS.has(ext)) {
        entries.push({ localPath: full, relativePath: path.relative(base, full), size: stat.size });
      } else {
        console.warn(`skipping ${path.relative(base, full)} (ext: ${ext || 'none'})`);
      }
    }
  }
  return entries;
}

let tmpDir;

describe('walkDir', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkdir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('includes files with allowed extensions', () => {
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), 'data');
    fs.writeFileSync(path.join(tmpDir, 'cover.jpg'), 'data');
    const entries = walkDir(tmpDir);
    const names = entries.map(e => e.relativePath);
    expect(names).toContain('track.mp3');
    expect(names).toContain('cover.jpg');
    expect(entries).toHaveLength(2);
  });

  test('skips hidden files (starting with .)', () => {
    fs.writeFileSync(path.join(tmpDir, '.DS_Store'), 'hidden');
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), 'data');
    const entries = walkDir(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe('track.mp3');
  });

  test('skips files with disallowed extensions', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), 'audio');
    const entries = walkDir(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe('track.mp3');
  });

  test('emits console.warn for each skipped disallowed file', () => {
    const warned = [];
    const origWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), 'audio');
    walkDir(tmpDir);
    console.warn = origWarn;
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('notes.txt');
    expect(warned[0]).toContain('.txt');
  });

  test('no warn emitted for allowed extensions', () => {
    const warned = [];
    const origWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), 'audio');
    fs.writeFileSync(path.join(tmpDir, 'cover.jpeg'), 'img');
    walkDir(tmpDir);
    console.warn = origWarn;
    expect(warned).toHaveLength(0);
  });

  test('recurses into subdirectories', () => {
    const sub = path.join(tmpDir, 'album');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'track.mp3'), 'audio');
    const entries = walkDir(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe(path.join('album', 'track.mp3'));
  });

  test('skips hidden directories entirely', () => {
    const hidden = path.join(tmpDir, '.hidden');
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, 'track.mp3'), 'audio');
    const entries = walkDir(tmpDir);
    expect(entries).toHaveLength(0);
  });

  test('includes file size in each entry', () => {
    const content = 'hello audio data';
    fs.writeFileSync(path.join(tmpDir, 'track.mp3'), content);
    const entries = walkDir(tmpDir);
    expect(entries[0].size).toBe(Buffer.byteLength(content));
  });
});
