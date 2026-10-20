"""Prototyping canvas: a portable module on the Oct 13 conference page."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "assets" / "proto-canvas.js"
CSS = ROOT / "assets" / "proto-canvas.css"
FEED = ROOT / "data" / "proto-canvas.json"
ORG_MODEL = ROOT / "data" / "proto-org-model.json"
ORG = ROOT / "data" / "org.json"
PAGE = ROOT / "conference" / "index.html"
HOME = ROOT / "index.html"

BRANDS = ("sfdc24", "converspan")
STATUSES = {"wip", "review", "approved"}
HORIZONS = {"current", "future"}
TYPES = {"process", "model", "logo", "ui"}


def infer(records, key):
    kinds = set()
    for row in records:
        value = row.get(key)
        if value is None:
            continue
        if isinstance(value, bool):
            kinds.add("boolean")
        elif isinstance(value, (int, float)):
            kinds.add("number")
        else:
            kinds.add("string")
    if kinds == {"boolean"}:
        return "boolean"
    if kinds == {"number"}:
        return "number"
    return "string"


class ProtoCanvasModule(unittest.TestCase):
    def test_module_files_carry_no_host_brand(self):
        for path in (JS, CSS, FEED, ORG_MODEL):
            text = path.read_text(encoding="utf-8").lower()
            for brand in BRANDS:
                self.assertNotIn(brand, text, f"{path.name} names {brand}")

    def test_feed_is_examples_only(self):
        feed = json.loads(FEED.read_text(encoding="utf-8"))
        self.assertEqual(feed["format"], "proto-canvas/1")
        self.assertEqual(feed["public_status"], "examples")
        self.assertGreaterEqual(len(feed["items"]), 4)
        seen = set()
        for item in feed["items"]:
            self.assertTrue(item["example"], item["id"])
            self.assertIn(item["status"], STATUSES)
            self.assertIn(item["horizon"], HORIZONS)
            self.assertIn(item["type"], TYPES)
            self.assertTrue(item["by"])
            self.assertTrue(item["source"])
            self.assertEqual(item["penpot"], "")
            seen.add(item["set"])
        for key in ("access", "agents", "future", "architecture", "prototype", "mark"):
            self.assertIn(key, seen)
        approved = [item for item in feed["items"] if item["status"] == "approved"]
        self.assertEqual([item["id"] for item in approved], ["mark"])
        self.assertTrue(any(item["status"] == "wip" and item["type"] == "process" for item in feed["items"]))

    def test_org_model_matches_the_published_snapshot(self):
        org = json.loads(ORG.read_text(encoding="utf-8"))
        model = json.loads(ORG_MODEL.read_text(encoding="utf-8"))
        self.assertFalse(model["live"])
        self.assertTrue(model["snapshot"])
        self.assertEqual(model["generated"], org["_meta"]["generated"])
        self.assertEqual(model["fields_withheld"], org["_meta"]["fields_withheld"])
        expected = []
        for name, key in (("Account", "accounts"), ("Contact", "contacts"), ("Opportunity", "opportunities")):
            rows = org[key]
            fields = []
            seen = set()
            for row in rows:
                for field in row:
                    if field in seen:
                        continue
                    seen.add(field)
                    fields.append({"name": field, "type": infer(rows, field)})
            expected.append({"name": name, "fields": fields})
        self.assertEqual(model["objects"], expected)
        withheld = set(org["_meta"]["fields_withheld"])
        names = {field["name"] for obj in model["objects"] for field in obj["fields"]}
        self.assertTrue(withheld.isdisjoint(names))
        raw = ORG_MODEL.read_text(encoding="utf-8")
        for banned in ("Ada Lovelace", "United Oil", "abdus@", "Headless"):
            self.assertNotIn(banned, raw)

    def test_diagram_library_stays_out_of_the_page_and_the_homepage(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertNotIn("mermaid", page.lower())
        self.assertNotIn("jsdelivr", page.lower())
        self.assertNotIn("mermaid", HOME.read_text(encoding="utf-8").lower())
        script = JS.read_text(encoding="utf-8")
        self.assertIn("mermaid@11.4.1", script)
        self.assertIn('securityLevel: "strict"', script)
        self.assertIn("data-proto-mermaid", script)

    def test_conference_page_mounts_the_canvas_and_stays_a_brochure(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertIn('id="proto-canvas"', page)
        self.assertIn("data-proto-canvas", page)
        self.assertIn('data-started="0"', page)
        self.assertIn('data-feed="/data/proto-canvas.json"', page)
        self.assertIn('data-org="/data/proto-org-model.json"', page)
        self.assertIn(">Open the canvas</button>", page)
        self.assertIn("/assets/proto-canvas.js", page)
        self.assertIn("/assets/proto-canvas.css", page)
        self.assertIn("not the join door", page)
        self.assertIn("Guests stay closed", page)
        self.assertIn("VERIFY", page)
        self.assertIn("public join", page)
        self.assertNotIn("Join the conference", page)
        self.assertNotIn("OKF", page)
        for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE", "LiveKit", "Cloud Run"):
            self.assertNotIn(needle, page)


if __name__ == "__main__":
    unittest.main()
