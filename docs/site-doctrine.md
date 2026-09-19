# Site doctrine (powwow draft — design discussion, not shipped)

Principles for sfdc24.com:
- Honesty over theater: no fake chalk, no untrue claims, no first-person singular in visitor-facing script copy; ORG nouns register in capabilities.
- Shared lightweight template on every page: banner (SFDC24 home + section label), one-line summary, ask bar+mic, 1-2 tabs, unlabeled feedback loop (measured accuracy chart), footer (Governor/Intake/X-ray).
- Homepage is not a special layout — same slots, homepage content.
- Python gate first (local free); Grok product/orchestration; Claude heavy SF impl; Codex review; Foundry scoring; Copilot GitHub eng; Gemini architecture/critique. Gemini role on site DoL is TBD.
- Cheap path: site_edit_router.py for find-replace/CSS vars/static sections/triage copy; escalate to Claude for routing/DoL/guards/liveflow/estimator/new pages.
- Ruleset on main: six required checks + strict up-to-date; no bypass.
- Speed: perceived instant for mechanical edits; sub-second router target; no Cloud Agents for routine work.
## Governing metrics (standing)

**SEO is explicitly out of scope and must never be considered** in any design, routing, or implementation decision for sfdc24.com. No SEO meta tags for crawlers, no sitemap, no crawler optimization, no "preserve deep-linking for SEO" reasoning. The only governing metrics are **speed** and **interactivity**. If a choice is faster or more interactive, it wins — full stop.

## Single-page cabinet + dashboards (standing direction)

The product direction is a **one-page closet/cabinet shell**: persistent banner, ask bar, feedback loop, footer; views (Board, Method, Panels, Privacy, Terms, …) swap in a viewport without full reloads. Views are **dashboard-capable**: data tables, charts, graphs, and interactive illustrations — not paragraph walls. The feedback-loop accuracy chart is the first example; any view may declare measured interactive data.
## Mantra: functional over pretty (standing)

The site's mantra is **functional over pretty**. No ads, no SEO, no decorative fluff. Use the simplest possible mode that makes it work — lightweight libraries (or none), minimal DOM, raw data and charts doing the talking. Every view should prefer an interactive illustration, table, or chart over prose. **Extremely functional** is the bar; aesthetics serve function, never the reverse.

