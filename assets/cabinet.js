/* Homepage cabinet + tiered asset preload + schema cache.
   Loaded as an external script so the chat inline block stays last
   (homepage_recovery.cjs depends on that ordering).

   Doctrine notes:
   - One-page cabinet: tabs swap panels in place, no navigation.
   - Schema payloads are cached locally with TTL + version stamps.
   - Preload work is bucketed hot / warm / cold with hard budgets.
   - Copy stays second-person; no claims of a live customer org. */
(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var VIEWS = ["board", "method", "panels", "privacy", "terms"];

  var SCHEMA_CACHE = (function () {
    var STORE_KEY = "sfdc24.schemaCache.v1";
    var VERSION = "v1";
    var DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
    var memory = null;
    function store() {
      try { if (window.sessionStorage) return window.sessionStorage; } catch (e) {}
      return null;
    }
    function readAll() {
      var s = store();
      if (!s) return memory || (memory = {});
      try {
        var raw = s.getItem(STORE_KEY);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object") ? parsed : {};
      } catch (e) { return {}; }
    }
    function writeAll(map) {
      var s = store();
      if (!s) { memory = map; return false; }
      try { s.setItem(STORE_KEY, JSON.stringify(map)); return true; } catch (e) { memory = map; return false; }
    }
    function fresh(entry, now) {
      if (!entry || typeof entry !== "object") return false;
      if (entry.version !== VERSION) return false;
      if (typeof entry.fetchedAt !== "number") return false;
      var ttl = typeof entry.ttlMs === "number" ? entry.ttlMs : DEFAULT_TTL_MS;
      if (ttl <= 0) return false;
      return (now - entry.fetchedAt) < ttl;
    }
    function get(key) {
      if (!key) return null;
      var map = readAll();
      var entry = map[key];
      var now = Date.now();
      if (!fresh(entry, now)) {
        if (entry) { delete map[key]; writeAll(map); }
        return null;
      }
      return entry.data;
    }
    function entry(key) {
      if (!key) return null;
      var map = readAll();
      var e = map[key];
      return fresh(e, Date.now()) ? e : null;
    }
    function set(key, data, ttlMs) {
      if (!key) return null;
      var map = readAll();
      var rec = { version: VERSION, fetchedAt: Date.now(), ttlMs: (typeof ttlMs === "number" && ttlMs > 0) ? ttlMs : DEFAULT_TTL_MS, data: data };
      map[key] = rec; writeAll(map); return rec;
    }
    function purge(key) {
      if (typeof key === "undefined" || key === null) {
        memory = {};
        var s = store();
        if (s) { try { s.removeItem(STORE_KEY); } catch (e) {} }
        return true;
      }
      var map = readAll();
      if (map[key]) { delete map[key]; writeAll(map); return true; }
      return false;
    }
    function sweep() {
      var map = readAll(); var now = Date.now(); var dropped = 0;
      Object.keys(map).forEach(function (k) { if (!fresh(map[k], now)) { delete map[k]; dropped++; } });
      if (dropped) writeAll(map); return dropped;
    }
    function keys() {
      var map = readAll(); var now = Date.now();
      return Object.keys(map).filter(function (k) { return fresh(map[k], now); });
    }
    return { VERSION: VERSION, STORE_KEY: STORE_KEY, DEFAULT_TTL_MS: DEFAULT_TTL_MS, get: get, entry: entry, set: set, purge: purge, sweep: sweep, keys: keys };
  })();

  window.__SFDC24_SCHEMA_CACHE = SCHEMA_CACHE;

  var PRELOAD = (function () {
    var BUDGET = { hot: 3, warm: 5, cold: 6 };
    var spent = { hot: 0, warm: 0, cold: 0 };
    var ran = { hot: false, warm: false, cold: false };
    var log = [];
    var HOT = ["/data/site-manifest.json"];
    var WARM_JSON = ["/data/org.json", "/data/desk.json"];
    var COLD_PAGES = ["/agents/", "/method/", "/privacy/", "/terms/"];
    function note(lane, url, how) { if (log.length < 64) log.push({ lane: lane, url: url, how: how, t: Date.now() }); }
    function spend(lane) { if (spent[lane] >= BUDGET[lane]) return false; spent[lane]++; return true; }
    function linkHint(url, rel) {
      try {
        if ($('link[data-preload-url="' + url + '"]')) return false;
        var l = document.createElement("link");
        l.rel = rel || "prefetch"; l.href = url; l.setAttribute("data-preload-url", url);
        document.head.appendChild(l); return true;
      } catch (e) { return false; }
    }
    function schema(url, lane, ttlMs) {
      if (SCHEMA_CACHE.get(url) !== null) { note(lane, url, "cache-hit"); return true; }
      if (!spend(lane)) { note(lane, url, "over-budget"); return false; }
      if (!window.fetch) { linkHint(url, "prefetch"); note(lane, url, "link-only"); return true; }
      try {
        fetch(url, { credentials: "same-origin", cache: "force-cache" })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (data) { if (data) { SCHEMA_CACHE.set(url, data, ttlMs); note(lane, url, "stored"); } else note(lane, url, "empty"); })
          .catch(function () { note(lane, url, "failed"); });
      } catch (e) { note(lane, url, "threw"); }
      return true;
    }
    function page(url, lane) {
      if (!spend(lane)) { note(lane, url, "over-budget"); return false; }
      linkHint(url, "prefetch"); note(lane, url, "prefetch"); return true;
    }
    function hot() { if (ran.hot) return false; ran.hot = true; SCHEMA_CACHE.sweep(); HOT.forEach(function (u) { schema(u, "hot"); }); return true; }
    function warm() {
      if (ran.warm) return false; ran.warm = true;
      HOT.forEach(function (u) { schema(u, "warm"); });
      WARM_JSON.forEach(function (u) { schema(u, "warm"); });
      try { if (window.__TRIAGE && typeof window.__TRIAGE.warm === "function") { window.__TRIAGE.warm(); note("warm", "__TRIAGE.warm", "called"); } } catch (e) {}
      return true;
    }
    function cold() { if (ran.cold) return false; ran.cold = true; COLD_PAGES.forEach(function (u) { page(u, "cold"); }); return true; }
    function scheduleCold() {
      var fire = function () { try { cold(); } catch (e) {} };
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fire, { timeout: 4000 });
      else setTimeout(fire, 2000);
    }
    function status() {
      return { budget: { hot: BUDGET.hot, warm: BUDGET.warm, cold: BUDGET.cold }, spent: { hot: spent.hot, warm: spent.warm, cold: spent.cold }, ran: { hot: ran.hot, warm: ran.warm, cold: ran.cold }, cacheKeys: SCHEMA_CACHE.keys(), log: log.slice(0) };
    }
    return { hot: hot, warm: warm, cold: cold, scheduleCold: scheduleCold, status: status };
  })();

  window.__SFDC24_PRELOAD = { hot: PRELOAD.hot, warm: PRELOAD.warm, cold: PRELOAD.cold, status: PRELOAD.status };

  function show(name) {
    $all("#cabinetTabs [data-cabinet]").forEach(function (btn) {
      var on = btn.getAttribute("data-cabinet") === name;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    $all("[data-cabinet-panel]").forEach(function (p) {
      var on = p.getAttribute("data-cabinet-panel") === name;
      p.classList.toggle("is-on", on); p.hidden = !on;
    });
    $all("[data-cabinet-board]").forEach(function (el) {
      el.hidden = name !== "board"; el.classList.toggle("is-on", name === "board");
    });
    try { history.replaceState(null, "", name === "board" ? "#" : "#cabinet-" + name); } catch (e) {}
    var spd = $("#cabSpeed");
    if (spd && name === "method") {
      spd.textContent = (window.performance && performance.now) ? Math.round(performance.now()) + " ms" : "fast";
    }
    if (name !== "board") { try { PRELOAD.cold(); } catch (e2) {} }
  }

  function injectCabinetChrome() {
    if ($("#cabinetTabs")) return;
    var mount = $("#dol") || $("#liveflow") || $("#console") || document.body;
    if (!mount || !mount.parentNode) return;
    var nav = document.createElement("nav");
    nav.className = "cabinet-tabs"; nav.id = "cabinetTabs"; nav.setAttribute("aria-label", "Cabinet views");
    VIEWS.forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button"; b.setAttribute("data-cabinet", name);
      b.setAttribute("aria-selected", name === "board" ? "true" : "false");
      b.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      nav.appendChild(b);
    });
    mount.parentNode.insertBefore(nav, mount);
    var panels = {
      method: '<div class="cabinet-ill" role="img" aria-label="Method loop"><div class="step"><b>1 · Ask</b><span>Visitor names a gap</span></div><div class="step"><b>2 · Infer</b><span>Signals weight speed/cost/quality</span></div><div class="step"><b>3 · Decide</b><span>Closeable recommendation</span></div><div class="step"><b>4 · Act</b><span>Buy, schedule, or walk away</span></div></div><div class="cabinet-dash"><div class="cabinet-card"><h3>Speed</h3><div class="num" id="cabSpeed">—</div><p>First-class arrival / setup / time-to-value</p></div><div class="cabinet-card"><h3>Cost</h3><div class="num">$</div><p>Second axis — reweight it from the ask box</p></div><div class="cabinet-card"><h3>Quality</h3><div class="num">Σ</div><p>Third axis — Six Sigma triad</p></div></div><p class="caveat">Short form: question → decision → action. Full honest-boundary text lives on <a href="/method/">/method/</a>.</p>',
      panels: '<table class="cabinet-table"><thead><tr><th>Panel</th><th>Kind</th><th>Status</th></tr></thead><tbody><tr><td>Projects</td><td>Build lanes</td><td><a href="/projects/">open</a></td></tr><tr><td>Voice</td><td>First-party talk</td><td><a href="/voice/">open</a></td></tr><tr><td>Pipeline desk</td><td>Demo-data snapshot</td><td><a href="/org/">open</a></td></tr><tr><td>Agents</td><td>DoL roster</td><td><a href="/agents/">open</a></td></tr></tbody></table>',
      privacy: '<div class="cabinet-dash"><div class="cabinet-card"><h3>Session inferences</h3><p>Stored locally for this visit. Default: no cross-session persist.</p></div><div class="cabinet-card"><h3>Cached schema</h3><p>Versioned site payloads held in sessionStorage with a 6-hour expiry, then discarded.</p></div><div class="cabinet-card"><h3>Ask text</h3><p>Handled by the gate in-browser when possible.</p></div><div class="cabinet-card"><h3>Full policy</h3><p><a href="/privacy/">Open Privacy</a></p></div></div>',
      terms: '<div class="cabinet-dash"><div class="cabinet-card"><h3>Use</h3><p>Interactive research-stage surface. Not a live customer org; desk numbers are demo data.</p></div><div class="cabinet-card"><h3>Decisions</h3><p>Recommendations are closeable suggestions, not legal advice.</p></div><div class="cabinet-card"><h3>Full terms</h3><p><a href="/terms/">Open Terms</a></p></div></div>'
    };
    Object.keys(panels).forEach(function (name) {
      var sec = document.createElement("section");
      sec.className = "cabinet-panel"; sec.setAttribute("data-cabinet-panel", name);
      sec.id = "cabinet-" + name; sec.hidden = true; sec.innerHTML = panels[name];
      nav.parentNode.insertBefore(sec, nav.nextSibling);
    });
    ["#liveflow", "#dol", "#console"].forEach(function (sel) {
      var el = $(sel);
      if (el) { el.setAttribute("data-cabinet-board", "1"); el.classList.add("cabinet-board"); }
    });
  }

  function closestTab(node) {
    if (node && node.closest) return node.closest("[data-cabinet]");
    while (node && node !== document) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-cabinet")) return node;
      node = node.parentNode;
    }
    return null;
  }

  function bootCabinet() {
    injectCabinetChrome();
    var nav = $("#cabinetTabs");
    if (!nav) return;
    nav.addEventListener("click", function (e) {
      var btn = closestTab(e.target);
      if (!btn) return;
      show(btn.getAttribute("data-cabinet"));
    });
    $all("[data-cabinet-link]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        show(a.getAttribute("data-cabinet-link"));
      });
    });
    var hash = (location.hash || "").replace(/^#cabinet-/, "").replace(/^#/, "");
    if (hash && VIEWS.indexOf(hash) >= 0) show(hash); else show("board");
  }

  function bindAskWarm() {
    var box = document.getElementById("box");
    if (!box) return;
    var fired = false;
    function warm() { if (fired) return; fired = true; try { PRELOAD.warm(); } catch (e) {} }
    box.addEventListener("focus", warm);
    box.addEventListener("pointerdown", warm);
  }

  function boot() {
    bootCabinet(); bindAskWarm();
    try { PRELOAD.hot(); } catch (e) {}
    try { PRELOAD.scheduleCold(); } catch (e2) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
