// Scratch harness: does S5+S6 catch foundry's next four roles, and the no-role tabindex card?
// Serves the PR120 head worktree; mutates the two .cd-profile cards; measures selectors AND
// the real Chromium accessibility tree. Not part of the repo.
const { chromium } = require("playwright-core");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve("C:/Users/salam/Quantum/.ccc-pr120-v7");
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".ico":"image/x-icon" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(REPO, rel.replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("missing"); return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// tag + attrs for the card; null = leave the shipped fix alone
const TREES = {
  FIX:  null,
  V1:   { tag: "button", attrs: { type: "button", "aria-pressed": "false" }, note: "main's defect: native button card" },
  V6:   { tag: "div", attrs: { role: "button", tabindex: "0", "aria-pressed": "false" }, note: "role=button card" },
  V7:   { tag: "div", attrs: { role: "link", tabindex: "0" }, note: "foundry: role=link" },
  V8:   { tag: "div", attrs: { role: "tab", tabindex: "0", "aria-selected": "false" }, note: "foundry: role=tab" },
  V9:   { tag: "div", attrs: { role: "menuitem", tabindex: "0" }, note: "foundry: role=menuitem" },
  V10:  { tag: "div", attrs: { role: "option", tabindex: "0", "aria-selected": "false" }, note: "foundry: role=option" },
  V11:  { tag: "div", attrs: { tabindex: "0" }, note: "foundry: tabindex only, no role, click handler" },
};

const SELECTORS = {
  S5: ':is(button,[role="button"]) :is(h1,h2,h3,h4,h5,h6)',
  S6: '.cd-profile:is(button,[role="button"])',
  // candidate: every ARIA role whose children are presentational, plus native button
  S7: ':is(button,[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="slider"],[role="progressbar"],[role="meter"],[role="img"]) :is(h1,h2,h3,h4,h5,h6)',
  // S8: roles whose accessible NAME comes from contents -- the property that actually tracks the harm
  S8: ':is(button,a[href],[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"]) :is(h1,h2,h3,h4,h5,h6)',
  // S9: the card contract itself -- a profile card is never the control, whatever the vocabulary
  S9: '#choice-design-probe .cd-profile:is(button,a,[role],[tabindex])',
};

function mutate(spec) {
  const cards = Array.from(document.querySelectorAll("#choice-design-probe .cd-profile"));
  for (const card of cards) {
    const el = document.createElement(spec.tag);
    el.className = card.className;
    for (const [k, v] of Object.entries(spec.attrs)) el.setAttribute(k, v);
    el.setAttribute("data-profile", card.getAttribute("data-profile") || "");
    while (card.firstChild) el.appendChild(card.firstChild);
    // the card is now itself the control, so the inner <button> becomes a span, as main had
    const pick = el.querySelector("button.cd-pick");
    if (pick) {
      const span = document.createElement("span");
      span.className = "cd-pick";
      span.textContent = pick.textContent;
      pick.replaceWith(span);
    }
    if (spec.tag === "div" && !spec.attrs.role) el.addEventListener("click", () => {});
    card.replaceWith(el);
  }
  return cards.length;
}

(async () => {
  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  const out = [];
  try {
    for (const [name, spec] of Object.entries(TREES)) {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Accessibility.enable");
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      page.on("response", (r) => { if (r.status() >= 400) errs.push(r.status() + " " + r.url()); });
      await page.goto(origin + "/method/#choice-design");
      await page.waitForSelector("#choice-design-probe .cd-profile");
      if (spec) await page.evaluate(mutate, spec);

      const counts = {};
      for (const [k, sel] of Object.entries(SELECTORS)) {
        counts[k] = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
      }
      // control assertions: the page really mounted, and there really are two cards
      const cardCount = await page.locator("#choice-design-probe .cd-profile").count();
      const status = (await page.locator("[data-cd-status]").first().textContent() || "").trim();

      // GROUND TRUTH pass 1: does "Profile N" still exist as a heading in the a11y tree?
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const headings = nodes.filter((n) =>
        !n.ignored && n.role && n.role.value === "heading" &&
        n.name && /^Profile [12]$/.test((n.name.value || "").trim()));

      // GROUND TRUTH pass 2: the card's OWN computed role and accessible name.
      // A name-from-contents widget swallows the whole card into one label.
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const found = await cdp.send("DOM.querySelectorAll",
        { nodeId: root.nodeId, selector: "#choice-design-probe .cd-profile" });
      const cardFacts = [];
      for (const nodeId of found.nodeIds) {
        const part = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
        const n = part.nodes && part.nodes[0];
        if (!n) continue;
        const nm = ((n.name && n.name.value) || "");
        cardFacts.push({ role: (n.role && n.role.value) || "-", nameLen: nm.length,
          swallowsDl: /Trust Navy|Cobalt/.test(nm), focusable: !!(n.properties || [])
            .find((p) => p.name === "focusable" && p.value && p.value.value === true) });
      }
      const c0 = cardFacts[0] || { role: "-", nameLen: 0, swallowsDl: false, focusable: false };

      out.push({ tree: name, note: spec ? spec.note : "shipped fix (article + inner button)",
        cards: cardCount, status: status.slice(0, 12), errs: errs.length,
        S5: counts.S5, S6: counts.S6, S7: counts.S7, S8: counts.S8, S9: counts.S9,
        headingsSurviving: headings.length,
        axRole: c0.role, nameLen: c0.nameLen,
        swallowsDl: c0.swallowsDl ? "YES" : "no", focusable: c0.focusable ? "yes" : "no" });
      await page.close();
    }
  } finally { await browser.close(); server.close(); }

  const cols = ["tree","cards","errs","S5","S6","S7","S8","S9","headingsSurviving","axRole","nameLen","swallowsDl","focusable","note"];
  console.log(cols.join("\t"));
  for (const r of out) console.log(cols.map((c) => r[c]).join("\t"));
})();
