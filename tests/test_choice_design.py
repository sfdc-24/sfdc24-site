from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("choice_design", ROOT / "tools" / "choice_design.py")
assert spec and spec.loader
choice_design = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = choice_design
spec.loader.exec_module(choice_design)


class ChoiceDesignTests(unittest.TestCase):
    def setUp(self):
        self.catalog = choice_design.load_catalog(ROOT / "data" / "choice-design-pilot.json")

    def test_catalog_is_explicitly_not_deployed(self):
        self.assertEqual([], choice_design.validate_catalog(self.catalog))
        self.assertEqual("pilot-not-deployed", self.catalog["status"])
        self.assertFalse(self.catalog["privacy"]["cookies"])

    def test_generation_is_deterministic_and_stacked(self):
        first = choice_design.generate(self.catalog, 24)
        second = choice_design.generate(self.catalog, 24)
        self.assertEqual(first, second)
        self.assertEqual(16, len(first))
        self.assertTrue(all(row["selected"] is None for row in first))
        self.assertEqual(set(range(1, 9)), {row["choice_set_id"] for row in first})

    def test_profiles_in_each_set_differ_on_two_attributes(self):
        rows = choice_design.generate(self.catalog, 24)
        for offset in range(0, len(rows), 2):
            a, b = rows[offset]["attributes"], rows[offset + 1]["attributes"]
            self.assertGreaterEqual(sum(a[k] != b[k] for k in a), 2)

    def test_response_validation_requires_one_choice(self):
        rows = choice_design.generate(self.catalog, 24, 1)
        rows[0]["selected"], rows[1]["selected"] = 1, 0
        self.assertEqual([], choice_design.validate_responses(rows))
        rows[1]["selected"] = 1
        self.assertIn("exactly one", choice_design.validate_responses(rows)[0])

    def test_cli_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "pilot.jsonl"
            self.assertEqual(0, choice_design.main(["--seed", "7", "--sets", "2", "--out", str(out)]))
            rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
            for i in range(0, len(rows), 2):
                rows[i]["selected"], rows[i + 1]["selected"] = 1, 0
            out.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            self.assertEqual(0, choice_design.main(["--validate-responses", str(out)]))


if __name__ == "__main__":
    unittest.main()
