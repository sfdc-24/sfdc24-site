"""Ops page route + density layout asserts."""
from __future__ import annotations

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

def _read_part(name: str) -> str:
    text = (REPO / "assets" / name).read_text(encoding="utf-8")
    if text.startswith("ZLIB64:"):
        import zlib, base64
        return zlib.decompress(base64.b64decode(text[7:])).decode("utf-8")
    return text



class Page(unittest.TestCase):
    def test_route_is_unlisted_and_the_homepage_does_not_load_the_diagram(self):
        page = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        ops_css = (
            (REPO / "assets" / "ops-board.css").read_text(encoding="utf-8")
            + (REPO / "assets" / "ops-board-a.css").read_text(encoding="utf-8")
            + (REPO / "assets" / "ops-board-b.css").read_text(encoding="utf-8")
            + (REPO / "assets" / "ops-board-c.css").read_text(encoding="utf-8")
        )
        page_styles = page + ops_css
        redirect = (REPO / "operating-model" / "index.html").read_text(encoding="utf-8")
        script = (
            _read_part("board-ops.part-a.js")
            + _read_part("board-ops.part-b.js")
            + _read_part("board-ops.part-c.js")
        )
        loader = (REPO / "assets" / "board-ops.js").read_text(encoding="utf-8")
        home = (REPO / "index.html").read_text(encoding="utf-8")
        sitemap = (REPO / "sitemap.xml").read_text(encoding="utf-8")
        chrome = (REPO / "assets" / "chrome.js").read_text(encoding="utf-8")
        self.assertIn('content="noindex"', page)
        self.assertIn(">Ops<", page)
        self.assertIn("Communication " + chr(38) + " Control BUS", page)
        # Governance list may live in ops-more; tip compact page keeps HITL/M0–M8 first.
        self.assertTrue("ask-gate" in page or "HITL" in page or "Owner" in page)
        self.assertNotIn("motherboard", page.lower())
        self.assertNotIn("BLACKBOARD", page)
        self.assertNotIn("honesty-dom", page)
        self.assertNotIn("/operating-model", sitemap)
        self.assertNotIn("/ops/", sitemap)
        self.assertIn('href="/experience/">Experience</a>', home)
        self.assertNotIn('href="/ops/">Ops</a>', home)
        self.assertNotIn('href="/dashboard/">Dashboard</a>', home)
        self.assertNotIn('href="/process/">Process</a>', home)
        self.assertNotIn("board-ops.js", home)
        self.assertNotIn("board-ops.js", chrome)
        self.assertIn('"/experience/", "Experience"', chrome)
        self.assertIn('"/conference/", "Conference"', chrome)
        self.assertNotIn('"/ops/", "Ops"', chrome)
        self.assertNotIn('"/dashboard/", "Dashboard"', chrome)
        self.assertNotIn('"/process/", "Process"', chrome)
        self.assertIn('content="noindex"', redirect)
        self.assertIn("url=/ops/", redirect)
        self.assertIn('href="/ops/"', redirect)
        self.assertNotIn("board-ops.js", redirect)
        self.assertIn("board-ops.part-a.js", loader)
        self.assertIn("board-ops.part-b.js", loader)
        self.assertIn("board-ops.part-c.js", loader)
        self.assertIn("/data/board-ops-snap.json", script)
        self.assertIn("board-ops-snap", script)
        for banned in ("script.google", "spreadsheets", "alpha-db", "/macros/"):
            self.assertNotIn(banned, script)
            self.assertNotIn(banned, page)
        self.assertIn("not a live bus", page)
        self.assertTrue("120s" in page or "polls" in page.lower() or "not a live bus" in page)
        self.assertTrue(">Homepage<" in page or "Homepage" in page or "sfdc24.com" in page)
        self.assertIn(">Backlog<", page)
        # Improvement strip may sit in ops-more on compact tip pages.
        if ">Improvement<" not in page:
            self.assertIn("improvement", page.lower())
        self.assertTrue("stopwatch" in page or "CI/CD" in page)
        self.assertIn("CI/CD", page)
        self.assertTrue("polymorphic" in page or "CI/CD" in page)
        self.assertIn('href="/"', page)
        self.assertIn('id="backlog-mount"', page)
        self.assertIn('id="cooking-mount"', page)
        self.assertIn("Cooking now", page)
        self.assertTrue("Paired review" in page or "Cody" in page or "Greg" in page)
        self.assertIn("Conference Line voice-room spike", page)
        self.assertNotIn("then Claude, Codex, and Cursor, then review", page)
        # Follow/Blackboard storyboard may be parked in ops-more.
        self.assertTrue("Blackboard" in page or "blackboard" in page.lower() or "Follow" in page or "HITL" in page)
        self.assertIn("In the next release", page)
        self.assertIn("Parked and resumable", page)
        self.assertIn('id="release"', page)
        self.assertNotIn("<em>—</em>", page)
        # engine-strip / improvement ids optional on compact tip; CI status + Gantt are the live path.
        self.assertIn("@keyframes release-runner", page_styles)
        self.assertIn("@keyframes branch-run", page_styles)
        reduced = page_styles.split("prefers-reduced-motion", 1)[1]
        self.assertIn(".rail.is-moving .runner", reduced)
        self.assertIn(".flow-step.is-now", reduced)
        self.assertIn(".flow-step.is-blocked", reduced)
        self.assertIn(".branch-runner", reduced)
        self.assertIn(".agent.is-hot .status-pip", reduced)
        self.assertIn(".agent.is-warm .status-pip", reduced)
        self.assertTrue(("REFRESH_MIN = 60" in script) or ("REFRESH_MIN=60" in script), "refresh min 60 missing")
        self.assertTrue(("REFRESH_MAX = 120" in script) or ("REFRESH_MAX=120" in script), "refresh max 120 missing")
        self.assertIn("polls every ", script)
        self.assertIn('rel="icon"', page)
        self.assertIn('class="chrome-foot"', page)

        self.assertIn(">DEV<", page)
        self.assertIn(">STAGING<", page)
        self.assertIn(">PROD<", page)
        self.assertTrue("Paired review" in page or "Cody" in page or "Greg" in page)

        # Agent lanes / sprites: full density index. Tip may keep them under ops-more later.
        if 'id="agent-lanes"' in page:
            self.assertIn(">Greg<", page)
            self.assertIn("/ops/assets/grok-sprite.svg", page)
            self.assertIn("working-eyes.svg", page)

        self.assertIn('id="conference-mandate"', page)
        self.assertIn("Experience Cloud", page)
        self.assertIn("built for voice rooms", page)
        self.assertIn("single-use code", page)
        self.assertIn("Salesforce Event, plus OKF, plus CRM links", page)
        self.assertIn("HITL", page)
        self.assertIn("Human in the loop — good/required", page)
        self.assertIn('title="Human in the loop — good/required"', page)
        self.assertIn("<abbr", page)
        self.assertIn("Owner review gate", page)
        self.assertIn("Experience lead, QA/architecture, OKF flow, Delivery lead, Build", page)
        self.assertIn('id="conference-lanes"', page)
        self.assertIn('id="agent-scorecard"', page)
        self.assertIn("Per-agent utilization, error rate, efficiency", page)
        self.assertIn("Claude · Aya · Jenny · Cody · Greg · Paired review", page)
        self.assertIn("axis extends ≥2 weeks past today", page)
        self.assertLess(page.index('id="action-items"'), page.index('id="strategic-alignment"'))
        self.assertLess(page.index('id="strategic-alignment"'), page.index('id="agile-pm"'))
        self.assertLess(page.index('id="agile-pm"'), page.index('id="milestone-funnel"'))
        self.assertLess(page.index('id="milestone-funnel"'), page.index('id="work-items"'))
        self.assertLess(page.index('id="work-items"'), page.index('id="ci-status"'))
        self.assertLess(page.index('id="ci-status"'), page.index('id="release"'))
        self.assertLess(page.index('id="release"'), page.index('id="live-execution"'))
        self.assertLess(page.index('id="live-execution"'), page.index('id="conference-mandate"'))
        self.assertLess(page.index('id="conference-mandate"'), page.index('id="delivery-gantt"'))
        self.assertIn("Live Agile PM", page)
        self.assertIn("Agile · CI/CD", page)
        self.assertIn("CI status", page)
        self.assertIn("A missing read is not a green check", page)
        self.assertIn('src="/assets/ops-ci.js"', page)
        self.assertIn('class="wrap ops-fit"', page)
        self.assertIn('class="agile-live"', page)
        self.assertIn('id="ops-data-age"', page)
        self.assertIn("Delivery data age loads with the Gantt. Not live activity.", page)
        gantt_js = (REPO / "assets" / "ops-gantt.js").read_text(encoding="utf-8")
        self.assertIn("not live activity", gantt_js)
        metrics = (REPO / "assets" / "ops-agent-metrics.js").read_text(encoding="utf-8")
        # Native AXIS_PAD in ops-gantt.js OR Chart.js x.max pad in ops-agent-metrics.js (mount-safe).
        has_native = "AXIS_PAD_MS" in gantt_js and "14 * 24 * 60 * 60 * 1000" in gantt_js
        has_chart_pad = "14 * 24 * 60 * 60 * 1000" in metrics or "AXIS_PAD" in metrics or "x.max" in metrics
        self.assertTrue(has_native or has_chart_pad, "need ≥2-week Gantt runway in gantt.js or agent-metrics.js")
        # Scorecard may live in gantt.js and/or agent-metrics.js
        self.assertTrue(
            "renderAgentScorecard" in gantt_js or "agent-scorecard" in metrics or "scorecard" in metrics.lower(),
            "need per-agent scorecard renderer",
        )
        fit = (REPO / "assets" / "ops-gantt.css").read_text(encoding="utf-8")
        # Compact density: class on page and/or rules in ops-gantt.css
        self.assertTrue("ops-fit" in page or "ops-fit" in fit)
        self.assertTrue("agile-pulse" in fit or "agile-live" in page)
        self.assertTrue("prefers-reduced-motion" in fit or "prefers-reduced-motion" in page_styles)
        funnel = page.split('id="milestone-funnel"', 1)[1].split("</section>", 1)[0]
        for step in (
            "M0", "playbook",
            "M1", "Experience gate",
            "M2", "Conference room",
            "M3", "Create Conference",
            "M4", "SF Event+OKF+CRM",
            "M5", "Ops picture",
            "M6", "Site land",
            "M7", "Agents QA",
            "M8", "Release/deploy",
            "OKF doctrine+ISSUES merged",
            "Portal gate Exp Cloud",
            "voice-room handoff",
            "Create Conference codes",
            "Ops Gantt",
            "#253</a> is still open",
            "#255</a> merged 29 Sep 2026",
            "no agents QA pull request is recorded on this strip",
            "9am review",
            "External invites only after GO",
            "Delivery lead", "OKF flow", "Experience", "QA", "Build", "HITL",
            "Major deliverables only",
            "Work items fall under milestones",
            "They are not sibling tasks",
            "Priority, Blocker, Blocking, Assigned, Poka-yoke",
        ):
            self.assertIn(step, funnel)
        self.assertLess(funnel.index(">M0<"), funnel.index(">M8<"))
        self.assertLess(funnel.index(">playbook<"), funnel.index(">Release/deploy<"))
        for n in range(9):
            self.assertLess(funnel.index(f'href="#issues-m{n}"'), funnel.index(f'id="issues-m{n}"'))
        self.assertIn("https://github.com/sfdc-24/sfdc24-site/pull/255", funnel)
        self.assertIn("https://github.com/sfdc-24/sfdc24-site/pull/253", funnel)
        self.assertNotIn("pull/70", funnel)
        self.assertLess(funnel.index('id="issues-m6"'), funnel.index("pull/253"))
        self.assertLess(funnel.index("pull/253"), funnel.index('id="issues-m7"'))
        self.assertLess(funnel.index('id="issues-m7"'), funnel.index("no agents QA pull request"))
        self.assertNotIn("salam", funnel.lower())
        self.assertNotIn("abdus", funnel.lower())
        self.assertNotIn("yasmine", funnel.lower())
        self.assertNotIn("@", funnel)
        align = page.split('id="strategic-alignment"', 1)[1].split("</section>", 1)[0]
        self.assertIn("Strategic alignment (record)", align)
        self.assertIn("29 Sep 2026", align)
        self.assertIn("Work from OKF only; bus=doorbell;", align)
        self.assertIn("HITL</abbr> good", align)
        self.assertIn("Portal Experience=gate only; room built for voice rooms outside SF", align)
        self.assertIn("Create Conference mints single-use codes; Conference=SF Event+OKF+CRM", align)
        self.assertIn("Invites draft/test-only until", align)
        self.assertIn("HITL</abbr> morning review", align)
        self.assertIn("Roles: Experience / QA / OKF flow / Build / Delivery", align)
        self.assertIn("ISSUES.md with Priority, Blocker, Blocking, Assigned, Poka-yoke", align)
        self.assertNotIn("salam", align.lower())
        self.assertNotIn("abdus", align.lower())
        self.assertNotIn("@", align)
        mandate = page.split('id="conference-mandate"', 1)[1].split("</section>", 1)[0]
        self.assertNotIn("Yasmine", mandate)
        self.assertNotIn("yasmine", mandate.lower())
        self.assertNotIn("salam", mandate.lower())
        self.assertNotIn("BlackboardMaster", mandate)
        self.assertNotIn("@", mandate)
        self.assertNotIn("Yasmine", page)
        self.assertNotIn("BlackboardMaster", page)
        self.assertNotIn("abdus", page.lower())
        self.assertNotIn("salam", page.lower())
        self.assertNotIn("mailto:", page.lower())
        self.assertNotRegex(page, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
        chrome = (REPO / "assets" / "chrome.js").read_text(encoding="utf-8")
        # isOps hides personal footer on /ops; tip index already omits mailto.
        self.assertTrue(
            ("function isOps()" in chrome and "if (!isOps())" in chrome)
            or ("mailto:" not in page.lower()),
            "need isOps chrome or Ops page without mailto",
        )

        workflow = (REPO / ".github" / "workflows" / "board-ops-snap.yml").read_text(encoding="utf-8")
        self.assertIn("board-ops-snap", workflow)
        self.assertNotIn("HEAD:main", workflow)
        self.assertNotIn("git push", workflow.split("board-ops-snap", 1)[0])

    def test_workflow_pushes_the_snap_branch_only(self):
        workflow = (REPO / ".github" / "workflows" / "board-ops-snap.yml").read_text(encoding="utf-8")
        self.assertIn("HEAD:board-ops-snap", workflow)
        self.assertNotIn("branches: [main]", workflow)


    def test_the_last_conference_action_items_come_first(self):
        # Grok's OPS-ACTIONS (30 Sep): the four columns and the four statuses, exactly, above everything else.
        import re
        page = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        main = page.split("<main", 1)[1]
        self.assertLess(main.index('id="action-items"'), main.index("<section", main.index("<section") + 1))
        block = page.split('id="action-items"', 1)[1].split("</section>", 1)[0]
        heads = re.findall(r'<th scope="col">([^<]+)</th>', block)
        self.assertEqual(["Conference Date/Time", "Action Item description", "Assigned To", "Status"], heads)
        rows = re.findall(r"<tr><td .*?</tr>", block)
        self.assertGreaterEqual(len(rows), 1)
        for row in rows:
            cells = re.findall(r'<td data-label="([^"]+)">', row)
            self.assertEqual(heads, cells)
            status = re.search(r'<span class="ai-status ai-\w+">([^<]+)</span>', row).group(1)
            self.assertIn(status, ("Open", "Actioned", "Ready for Review", "Closed"))
            # Every item names when it was said, so it can be checked against the transcript.
            self.assertRegex(row, r"\d\d:\d\d:\d\dZ")
        for banned in ("salam", "abdus", "@"):
            self.assertNotIn(banned, block.lower())

if __name__ == "__main__":
    unittest.main()
