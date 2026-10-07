"""tools/ops_agent_metrics.py: the measures, from fixture records (no network)."""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import ops_agent_metrics as m  # noqa: E402

START = dt.datetime(2026, 9, 23, 0, 0, tzinfo=dt.timezone.utc)
END = START + dt.timedelta(days=7)


def rec(branch, created, merged=None, closed=None, commits=(), go=0, nogo=0, n=1, title="T"):
    return {"repo": "sfdc-24/conference", "number": n, "title": title, "branch": branch, "created": created,
            "merged": merged, "closed": closed or merged, "commits": list(commits), "go": go, "nogo": nogo}


def row(rows, name):
    return next(r for r in rows if r["agent"] == name)


class MeasureTest(unittest.TestCase):
    def test_an_hour_counts_once_and_only_inside_the_window(self):
        rows = m.measure([rec("codex/a", "2026-09-23T01:05:00Z", merged="2026-09-23T01:50:00Z",
                              commits=["2026-09-23T01:10:00Z", "2026-09-23T03:00:00Z", "2026-09-20T00:00:00Z"])],
                         START, END)
        codex = row(rows, "Codex")
        self.assertEqual(2, codex["active_hours"])                   # hour 1 (three events) and hour 3
        self.assertEqual(168, codex["window_hours"])
        self.assertEqual(round(2 / 168, 3), codex["utilization"])

    def test_the_error_rate_is_no_go_over_all_verdicts(self):
        rows = m.measure([rec("cursor/a", "2026-09-24T00:00:00Z", go=1, nogo=3),
                          rec("cursor/b", "2026-09-24T02:00:00Z", go=4, nogo=0, n=2)], START, END)
        cursor = row(rows, "Cursor")
        self.assertEqual((8, 3, 0.375), (cursor["verdicts"], cursor["nogo"], cursor["error_rate"]))

    def test_efficiency_is_the_median_hours_to_merge_of_merged_ones_only(self):
        rows = m.measure([rec("claude-code-cli/a", "2026-09-24T00:00:00Z", merged="2026-09-24T01:00:00Z"),
                          rec("claude-code-cli/b", "2026-09-24T00:00:00Z", merged="2026-09-24T05:00:00Z", n=2),
                          rec("claude-code-cli/c", "2026-09-24T00:00:00Z", merged="2026-09-24T03:00:00Z", n=3),
                          rec("claude-code-cli/d", "2026-09-24T00:00:00Z", closed="2026-09-25T00:00:00Z", n=4)],
                         START, END)
        claude = row(rows, "Claude")
        self.assertEqual((4, 3, 1, 3.0), (claude["pull_requests"], claude["merged"], claude["closed_unmerged"],
                                          claude["median_hours_to_merge"]))
        self.assertEqual([2, 3, 1], [d["number"] for d in claude["did"]])   # newest merge first

    def test_an_agent_with_no_record_has_no_numbers_and_says_why(self):
        rows = m.measure([rec("someone/else", "2026-09-24T00:00:00Z")], START, END)
        gemini = row(rows, "Gemini")
        self.assertEqual((0, None, None, None), (gemini["pull_requests"], gemini["utilization"],
                                                 gemini["error_rate"], gemini["median_hours_to_merge"]))
        self.assertIn("board", gemini["note"])
        self.assertNotIn("note", row(rows, "Codex"))                  # no note for a pure pull-request agent
        self.assertIn("board", row(rows, "Grok")["note"])             # Grok keeps the board undercount note
        self.assertEqual(sum(r["pull_requests"] for r in rows), 0)   # an unknown prefix belongs to nobody

    def test_grok_keeps_board_note_even_with_pull_requests(self):
        rows = m.measure([rec("grok/a", "2026-09-24T00:00:00Z", merged="2026-09-24T01:00:00Z")], START, END)
        grok = row(rows, "Grok")
        self.assertEqual(1, grok["pull_requests"])
        self.assertIn("board", grok["note"])

    def test_a_private_repository_s_titles_never_reach_the_page_and_a_banned_word_is_left_out(self):
        recs = [rec("claude-code-cli/a", "2026-09-24T00:00:00Z", merged="2026-09-24T01:00:00Z", title="Secret plan"),
                rec("claude-code-cli/b", "2026-09-24T00:00:00Z", merged="2026-09-24T02:00:00Z", n=2,
                    title="Public fix"),
                rec("claude-code-cli/c", "2026-09-24T00:00:00Z", merged="2026-09-24T03:00:00Z", n=3,
                    title="Codex motherboard page")]
        recs[1]["repo"] = recs[2]["repo"] = "sfdc-24/sfdc24-site"
        claude = row(m.measure(recs, START, END, frozenset({"sfdc-24/conference"})), "Claude")
        self.assertEqual(["Public fix"], [d["title"] for d in claude["did"]])
        self.assertEqual({"conference": 1, "sfdc24-site": 2}, claude["merged_by_repo"])

    def test_a_verdict_is_cursor_s_or_codex_s_go_or_no_go_only(self):
        def c(who, body):
            return {"user": {"login": who}, "body": body}
        self.assertEqual("GO", m.verdict(c("cursor[bot]", "**GO** for exact commit abc")))
        self.assertEqual("NO-GO", m.verdict(c("cursor[bot]", "**NO-GO** for abc")))
        self.assertEqual("NO-GO", m.verdict(c("sfdc-24", "Codex SOURCE NO-GO for exact head abc")))
        self.assertEqual("GO", m.verdict(c("sfdc-24", "Codex **SOURCE GO for the slice")))
        self.assertIsNone(m.verdict(c("sfdc-24", "@cursor Please reply GO or NO-GO for abc")))   # a request
        self.assertIsNone(m.verdict(c("cursor[bot]", "Taking a look!")))
        # Cursor on #261 (c84a136): the opening decision, not a bag of letters.
        self.assertEqual("GO", m.verdict(c("cursor[bot]", "**GO** for exact commit abc. It closes the NO-GO on def.")))
        self.assertEqual("GO", m.verdict(c("sfdc-24", "Codex: SOURCE GO for exact head 1e3079c; the earlier NO-GO is closed")))
        self.assertEqual("NO-GO", m.verdict(c("cursor[bot]", "Blocking. Not GO.")))
        self.assertEqual("NO-GO", m.verdict(c("cursor[bot]", "BLOCKER. The page is wrong. Not GO.")))
        self.assertEqual("NO-GO", m.verdict(c("sfdc-24", "**Codex exact-head SOURCE NO-GO — abc** (whole diff)")))
        self.assertIsNone(m.verdict(c("cursor[bot]", "Commit abc matches the claim. It is the only commit.")))
        self.assertIsNone(m.verdict(c("cursor[bot]", "We cannot go further without a GOOD reason")))   # no decision word

    def test_the_same_verdict_posted_twice_in_a_row_counts_once(self):
        def c(who, body):
            return {"user": {"login": who}, "body": body}
        comments = [c("cursor[bot]", "**NO-GO** for abc. P1: x."), c("cursor[bot]", "**NO-GO** for abc. P1: x."),
                    c("sfdc-24", "@cursor Please check"), c("cursor[bot]", "**GO** for def. Closes the NO-GO."),
                    c("cursor[bot]", "**NO-GO** for abc. P1: x.")]
        self.assertEqual(["NO-GO", "GO", "NO-GO"], m.verdicts_of(comments))

    def test_an_unreadable_repository_is_not_treated_as_private_or_empty(self):
        available, private, unavailable = m.classify_repos({
            "sfdc-24/sfdc24-site": {"private": False, "full_name": "sfdc-24/sfdc24-site"},
            "sfdc-24/Blackboard": {"private": False},
            "sfdc-24/conference": None,
        })
        self.assertEqual(["sfdc-24/sfdc24-site", "sfdc-24/Blackboard"], available)
        self.assertEqual((), private)
        self.assertEqual(["sfdc-24/conference"], unavailable)
        available, private, unavailable = m.classify_repos({
            "sfdc-24/sfdc24-site": {"private": False},
            "sfdc-24/Blackboard": {"private": False},
            "sfdc-24/conference": {"private": True},
        })
        self.assertEqual(("sfdc-24/conference",), private)
        self.assertEqual([], unavailable)


if __name__ == "__main__":
    unittest.main()
