#!/usr/bin/env python3
"""Rename files/dirs whose names contain %XX CP850-encoded bytes.

Walks the given root directory bottom-up, finds names with %XX patterns
that decode to valid CP850 accented characters, and renames them.

Usage: python3 decode-cp850-filenames.py <root> [--dry-run]
"""

import os
import re
import sys

PERCENT_RE = re.compile(r'(?:%[0-9a-fA-F]{2})+')

def decode_name(name: str) -> str:
    def replacer(m: re.Match) -> str:
        raw = m.group(0)
        byte_vals = bytes(int(raw[i+1:i+3], 16) for i in range(0, len(raw), 3))
        try:
            decoded = byte_vals.decode('cp850')
            # Only accept if all decoded chars are printable (guard against box-drawing etc.)
            if all(c.isprintable() for c in decoded):
                return decoded
        except (UnicodeDecodeError, ValueError):
            pass
        return raw
    return PERCENT_RE.sub(replacer, name)

def main():
    args = sys.argv[1:]
    dry_run = '--dry-run' in args
    roots = [a for a in args if not a.startswith('--')]
    if not roots:
        print("Usage: decode-cp850-filenames.py <root> [--dry-run]")
        sys.exit(1)

    root = roots[0]
    renamed = 0
    skipped = 0

    # Walk bottom-up so we rename files before their parent dirs
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        # Rename files
        for fname in filenames:
            new_fname = decode_name(fname)
            if new_fname != fname:
                src = os.path.join(dirpath, fname)
                dst = os.path.join(dirpath, new_fname)
                if os.path.exists(dst):
                    print(f"  SKIP (exists): {src}")
                    skipped += 1
                    continue
                print(f"  {'WOULD RENAME' if dry_run else 'RENAME'}: {fname!r}  →  {new_fname!r}")
                if not dry_run:
                    os.rename(src, dst)
                renamed += 1

        # Rename current dir itself (dirpath's basename)
        parent, dname = os.path.split(dirpath)
        new_dname = decode_name(dname)
        if new_dname != dname:
            src = dirpath
            dst = os.path.join(parent, new_dname)
            if os.path.exists(dst):
                print(f"  SKIP dir (exists): {src}")
                skipped += 1
                continue
            print(f"  {'WOULD RENAME' if dry_run else 'RENAME'} dir: {dname!r}  →  {new_dname!r}")
            if not dry_run:
                os.rename(src, dst)
            renamed += 1

    label = "Would rename" if dry_run else "Renamed"
    print(f"\n{label} {renamed} items, skipped {skipped}")

if __name__ == '__main__':
    main()
