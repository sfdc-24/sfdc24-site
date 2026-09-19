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
## Speedforce (inside metaphor, not a public rebrand)

**Speedforce** is an inside joke and guiding metaphor — not a public rebrand of the site. **Speed is king.** The **force** is the engine that pushes, crunches, and forwards data in interactive form. Design and routing choices should feel like that engine: fast, forceful, data-first.

## What "interactive" means (standing)

Everything must be **clickable**. Visitors ask questions and **immediately see data change and morph**. That requires data tables and a solid backend (Salesforce-class object model). Do **not** fetch Salesforce on every ask — accounts, contacts, opportunities (and related) are obvious; **cache the schema locally** and deduce the rest from a few questions. Round-trips to Salesforce are the exception, not the path.
## Closeable decisions (standing)

Every interaction **narrows toward a closeable decision**. The architect's loop — **question → decision → action** — is the skeleton of every view. No dead-end answers. Every path ends at a recommendation the visitor can act on (buy, save, schedule, walk away).

## Six Sigma triad: speed, cost, quality (standing)

Every product or service decision the site helps with is framed on three axes: **speed**, **cost**, **quality**. **Speed is primary** — the metric the site lives and breathes. Show the visitor how fast they get it (arrival time, setup time, time-to-value) as a **first-class displayed number**, not an afterthought. Cost and quality are the other two axes the visitor can weight. The system reads which axis the visitor leans on and **narrows accordingly**.
## Inference engine (standing)

The site is an **inference engine**. Core rule: **infer, don't interrogate**. Use behavioral signals — referrer, IP/region, device class, scroll depth, hover time, which options they linger on or skip — to predict intent and weight the speed/cost/quality triad **before** the visitor asks. Start predictions early, refine with every interaction, and surface the best outcome before they request it. The accuracy chart is the engine's report card. Store inferences **locally for the session**; persisting across sessions is a separate privacy decision for later — **default to not persisting**.
## Scope: decision engine, not a search engine (standing)

This site is a **decision engine, not a search engine**.

**In scope:** aspirational, time-lagged decisions — where the visitor is now and where they want to be has a gap (buying a TV, getting an AI machine, finding a job, getting into school, planning a trip).

**Out of scope:** informational/factual lookups (who won the World Cup, what is the best zodiac sign, trivia, data mining). Those should be **routed elsewhere**, not served here.

**Test for any query:** does it require a decision with a **time lag** between present state and desired state? If yes, in. If it is just a fact, out.

