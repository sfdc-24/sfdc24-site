"""Redis floor: sample data, flag off, call diagrams, no secrets."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALL = (
    "call-access",
    "call-agents",
    "call-future",
    "call-architecture",
)
BANNED = ("REDIS_AUTH", "API_KEY", "BEGIN PRIVATE", "password=", "redis://")


class Floor(unittest.TestCase):
    def test_live_switch_defaults_off(self):
        config = json.loads((ROOT / "data/floor/config.json").read_text(encoding="utf-8"))
        self.assertIs(config["liveRedis"], False)
        self.assertIs(config["writesEnabled"], False)
        self.assertEqual(config["readApi"], "")
        text = (ROOT / "data/floor/config.json").read_text(encoding="utf-8")
        self.assertIn('"liveRedis": false', text)

    def test_sample_is_labeled(self):
        sample = json.loads((ROOT / "data/floor/sample.json").read_text(encoding="utf-8"))
        self.assertEqual(sample["label"], "sample")
        self.assertEqual(sample["gate"], "held")
        self.assertIn("Sample", sample["banner"])
        self.assertTrue(sample["threads"])
        self.assertTrue(all(row["sample"] is True for row in sample["threads"]))

    def test_call_diagrams_and_brief(self):
        brief = (ROOT / "docs/conference-diagrams-brief.md").read_text(encoding="utf-8")
        self.assertEqual(brief.count("### How we'll validate this"), 4)
        for name in CALL:
            self.assertIn(f"floor/diagrams/{name}.mmd", brief)
            mmd = (ROOT / "floor/diagrams" / f"{name}.mmd").read_text(encoding="utf-8")
            self.assertIn("NOW", mmd)
            self.assertIn("LATER", mmd.upper() + mmd)
            self.assertTrue((ROOT / "floor/diagrams" / f"{name}.svg").is_file())
            self.assertTrue((ROOT / "floor/diagrams" / f"{name}.png").is_file())
        page = (ROOT / "floor-conference/index.html").read_text(encoding="utf-8")
        self.assertIn("docs/conference-diagrams-brief.md", page)
        self.assertIn("Sample data", page)
        standalone = (ROOT / "docs/conference-call.html").read_text(encoding="utf-8")
        for name in CALL:
            self.assertIn(name, standalone)

    def test_no_secrets_or_bare_numbers(self):
        blobs = []
        for path in (
            list((ROOT / "floor").rglob("*"))
            + list((ROOT / "data/floor").rglob("*"))
            + list((ROOT / "floor-conference").rglob("*"))
            + [ROOT / "docs/conference-diagrams-brief.md", ROOT / "docs/conference-call.html"]
        ):
            if path.is_file() and path.suffix in {".html", ".md", ".mmd", ".json", ".js", ".css", ".svg"}:
                blobs.append(path.read_text(encoding="utf-8"))
        text = "\n".join(blobs)
        for needle in BANNED:
            self.assertNotIn(needle, text)
        visible = (ROOT / "floor-conference/index.html").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"(^|\s)#\d+\b", visible))


if __name__ == "__main__":
    unittest.main()
