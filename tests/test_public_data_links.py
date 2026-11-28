"""Public data must not link into the private conference repository."""
import importlib.util
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LINK = "github.com/sfdc-24/conference"


def load(name):
    path = ROOT / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PublicDataLinks(unittest.TestCase):
    def test_no_data_file_links_to_the_private_conference_repo(self):
        hits = []
        for path in sorted(DATA.rglob("*")):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if LINK in text.lower():
                hits.append(str(path.relative_to(ROOT)))
        self.assertEqual([], hits)

    def test_delivery_generator_keeps_conference_number_without_a_url(self):
        delivery = load("ops_delivery")
        self.assertEqual("conference #123", delivery.publish_source("https://github.com/sfdc-24/conference/pull/123"))
        self.assertEqual("conference #123", delivery.publish_source("https://github.com/sfdc-24/conference/pull/123/files"))
        self.assertEqual("conference #196", delivery.publish_source("https://github.com/sfdc-24/conference/issues/196"))
        self.assertEqual("conference", delivery.publish_source("https://github.com/sfdc-24/conference/tree/main/docs/okf"))
        self.assertEqual("conference #123", delivery.publish_source("conference #123"))
        kept = "https://github.com/sfdc-24/sfdc24-site/pull/241"
        self.assertEqual(kept, delivery.publish_source(kept))
        board = "https://github.com/sfdc-24/Blackboard/pull/294"
        self.assertEqual(board, delivery.publish_source(board))

        raw = {
            "schema_version": 1,
            "observed_at": "2026-09-27T12:00:00Z",
            "items": [{
                "id": "voice", "title": "Hear contributors", "project": "Conference", "owner": "Claude",
                "assignment": "Implementation", "stage": "dev", "status": "pending",
                "next": "Review the current head", "evidence": "Curated source observation.",
                "observed_at": "2026-09-27T12:00:00Z",
                "source": "https://github.com/sfdc-24/conference/pull/28",
                "periods": [],
            }, {
                "id": "site", "title": "Site repair", "project": "SFDC24", "owner": "Grok",
                "assignment": "Implementation", "stage": "dev", "status": "pending",
                "next": "Review the current head", "evidence": "Curated source observation.",
                "observed_at": "2026-09-27T11:00:00Z",
                "source": kept, "periods": [],
            }],
        }
        now = datetime(2026, 9, 28, tzinfo=timezone.utc)
        once = delivery.project(raw, now=now)
        self.assertEqual("conference #28", once["items"][0]["source"])
        self.assertEqual(kept, once["items"][1]["source"])
        self.assertNotIn(LINK, delivery.dumps(once))
        export = {"schema_version": 1, "items": [{
            "id": "voice", "source": "https://github.com/sfdc-24/conference/pull/28",
            "head_sha": "a" * 40, "state": "merged", "observed_at": "2026-09-27T16:00:00Z",
            "required_checks": [], "checks": [],
        }]}
        twice = delivery.project(once, export, now=now)
        self.assertEqual("conference #28", twice["items"][0]["source"])
        self.assertNotIn(LINK, delivery.dumps(twice))
        self.assertNotIn("docs/okf", delivery.dumps(once))

    def test_board_generator_keeps_conference_number_without_a_url(self):
        ops = load("board_ops_snap")
        row = ops._clean_ci({
            "repo": "conference",
            "conclusion": "success",
            "name": "private workflow title",
            "url": "https://github.com/sfdc-24/conference/actions/runs/123",
            "ts": "2026-09-26T06:10:00Z",
        })
        self.assertEqual({
            "repo": "conference",
            "conclusion": "success",
            "name": "conference #123",
            "ts": "2026-09-26T06:10:00Z",
        }, row)
        self.assertNotIn("url", row)
        self.assertNotIn(LINK, json.dumps(row))
        self.assertNotIn("private workflow title", json.dumps(row))
        public = ops._clean_ci({
            "repo": "sfdc24-site",
            "conclusion": "success",
            "name": "homepage-browser-tests",
            "url": "https://github.com/sfdc-24/sfdc24-site/actions/runs/9",
            "ts": "2026-09-26T06:10:00Z",
        })
        self.assertEqual("https://github.com/sfdc-24/sfdc24-site/actions/runs/9", public["url"])
        snap = ops.sample_snap()
        snap["ci"].append({
            "repo": "conference",
            "conclusion": "failure",
            "name": "private workflow title",
            "url": "https://github.com/sfdc-24/conference/pull/42",
            "ts": "2026-09-26T06:12:00Z",
        })
        clean = ops.sanitize(snap)
        self.assertEqual([], ops.problems(clean))
        self.assertNotIn(LINK, json.dumps(clean))
        self.assertNotIn("private workflow title", json.dumps(clean))
        kept = [item for item in clean["ci"] if item["repo"] == "conference"]
        self.assertEqual(["conference #42"], [item["name"] for item in kept])
        self.assertTrue(all("url" not in item for item in kept))


if __name__ == "__main__":
    unittest.main()
