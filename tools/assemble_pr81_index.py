#!/usr/bin/env python3
"""Assemble index.html from base64 parts (overnight polish restore)."""
from pathlib import Path
import base64, sys
root = Path(__file__).resolve().parents[1]
part_dir = root / "tools" / "_pr81_index_b64"
parts = sorted(part_dir.glob("part-*.txt"))
if not parts:
    sys.exit("no parts")
b64 = "".join(p.read_text().strip() for p in parts)
data = base64.b64decode(b64)
out = root / "index.html"
out.write_bytes(data)
print(f"wrote {out} ({len(data)} bytes) from {len(parts)} parts")
