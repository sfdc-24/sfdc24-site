"""tools/ops_forward.py: the Ops delivery snapshot only moves forward (no network)."""
import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
import ops_forward as f  # noqa: E402


def snap(observed="2026-09-29T05:00:00Z", **items):
    return {"observed_at": observed,
            "items": [{"id": k, "observed_at": v[0], "stage": v[1]} for k, v in items.items()]}


class ForwardTest(unittest.TestCase):
    def test_adding_and_updating_moves_forward(self):
        base = snap(a=("2026-09-29T01:00:00Z", "test"))
        head = snap("2026-09-29T06:00:00Z", a=("2026-09-29T02:00:00Z", "production"), b=("2026-09-29T06:00:00Z", "dev"))
        self.assertEqual([], f.backwards(base, head))

    def test_the_owner_s_case_a_stale_copy_that_drops_receipts_fails(self):
        # #260 (2026-09-30): an older copy of the file, without two production receipts main had.
        base = snap("2026-09-29T03:52:42Z", **{"conference-telemetry-log": ("2026-09-29T03:52:42Z", "production"),
                                               "waker-standby-wording": ("2026-09-29T03:46:00Z", "production"),
                                               "ops-gantt": ("2026-09-27T17:18:16Z", "production")})
        head = snap("2026-09-29T05:17:28Z", **{"ops-gantt": ("2026-09-27T17:18:16Z", "production")})
        self.assertEqual(["item conference-telemetry-log was dropped", "item waker-standby-wording was dropped"],
                         f.backwards(base, head))

    def test_time_never_goes_back_for_the_snapshot_or_an_item(self):
        base = snap("2026-09-29T05:00:00Z", a=("2026-09-29T04:00:00Z", "test"))
        head = snap("2026-09-28T05:00:00Z", a=("2026-09-29T03:00:00Z", "test"))
        self.assertEqual(["the snapshot's observed_at went back from 2026-09-29T05:00:00Z to 2026-09-28T05:00:00Z",
                          "item a went back from 2026-09-29T04:00:00Z to 2026-09-29T03:00:00Z"],
                         f.backwards(base, head))

    def test_production_is_never_undone(self):
        base = snap(a=("2026-09-29T04:00:00Z", "production"))
        head = snap(a=("2026-09-29T05:00:00Z", "staging"))
        self.assertEqual(["item a left production (now staging)"], f.backwards(base, head))

    def test_the_committed_file_is_forward_of_its_own_history_line(self):
        # The file on this branch keeps every item the recorded #260 regression lost.
        data = json.loads((REPO / "data" / "ops-delivery.json").read_text(encoding="utf-8"))
        ids = {item["id"] for item in data["items"]}
        self.assertTrue({"conference-telemetry-log", "waker-standby-wording"} <= ids)

    def test_the_command_exits_1_on_backwards_and_0_forward(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            base, head = Path(d, "base.json"), Path(d, "head.json")
            base.write_text(json.dumps(snap(a=("2026-09-29T04:00:00Z", "test"))), encoding="utf-8")
            head.write_text(json.dumps(snap()), encoding="utf-8")
            self.assertEqual(1, f.main(["ops_forward.py", "--base", str(base), "--head", str(head)]))
            head.write_text(json.dumps(snap(a=("2026-09-29T04:00:00Z", "test"))), encoding="utf-8")
            self.assertEqual(0, f.main(["ops_forward.py", "--base", str(base), "--head", str(head)]))


if __name__ == "__main__":
    unittest.main()
