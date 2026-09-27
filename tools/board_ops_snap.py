#!/usr/bin/env python3
"""Board ops snap — loader unpacks the living-board build (open PRs + productivity metrics)."""
from __future__ import annotations
import base64, zlib, sys
from pathlib import Path
_here = Path(__file__).resolve().parent
_BLOB = "".join((_here / name).read_text() for name in sorted(p.name for p in _here.glob("board_ops_snap.blob.p*")))
exec(compile(zlib.decompress(base64.b64decode(_BLOB)).decode("utf-8"), str(Path(__file__).resolve()), "exec"), globals())
if __name__ == "__main__":
    raise SystemExit(main())
