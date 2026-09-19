/* Homepage cabinet + tiered asset preload + schema cache.
   Loaded as an external script so the chat inline block stays last
   (homepage_recovery.cjs depends on that ordering).

   Doctrine notes:
   - Mid-page Board/Method/Panels tab row is gone (Mr Salam 2026-09-19).
     Those views live in the footer only; footer clicks go to real pages.
   - Schema payloads are cached locally with TTL + version stamps.
   - Preload work is bucketed hot / warm / cold with hard budgets.
   - Copy stays second-person; no claims of a live customer org. */
(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var VIEWS = ["board", "method", "panels"];
  var ICONS = {
    board: '<svg class="cab-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2" width="4" height="12" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="6" y="2" width="4" height="8" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="10.5" y="2" width="4" height="10" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    method: '<svg class="cab-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.6 8A4.6 4.6 0 1 1 8 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 1.6l2.4 1.8L8 5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    panels: '<svg class="cab-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="2" width="12" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="12" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  };
  var LEGAL_PAGES = { privacy: "/privacy/", terms: "/terms/" };
  var PAGE_FOR = {
    board: "/",
    method: "/method/",
    speed: "/method/#speed",
    panels: "/panels/",
    privacy: "/privacy/",
    terms: "/terms/"
  };

  /* ------------------------------------------------------------------
     1. Versioned schema cache (sessionStorage, TTL-guarded)
     ------------------------------------------------------------------ */
  var SCHEMA_CACHE = (function () {
    var STORE_KEY = "sfdc24.schemaCache.v1";
    var VERSION = "v1";
    var DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; /* 6 hours */
    var memory = null; /* fallback when sessionStorage is unavailable */

    function store() {
      try {
        if (window.sessionStorage) return window.sessionStorage;
      } catch (e) {}
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
      } catch (e) {
        return {};
      }
    }

    function writeAll(map) {
      var s = store();
      if (!s) { memory = map; return false; }
      try {
        s.setItem(STORE_KEY, JSON.stringify(map));
        return true;
      } catch (e) {
        memory = map;
        return false;
      }
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
      var rec = {
        version: VERSION,
        fetchedAt: Date.now(),
        ttlMs: (typeof ttlMs === "number" && ttlMs > 0) ? ttlMs : DEFAULT_TTL_MS,
        data: data
      };
      map[key] = rec;
      writeAll(map);
      return rec;
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
      var map = readAll();
      var now = Date.now();
      var dropped = 0;
      Object.keys(map).forEach(function (k) {
        if (!fresh(map[k], now)) { delete map[k]; dropped++; }
      });
      if (dropped) writeAll(map);
      return dropped;
    }

    function keys() {
      var map = readAll();
      var now = Date.now();
      return Object.keys(map).filter(function (k) { return fresh(map[k], now); });
    }

    return {
      VERSION: VERSION,
      STORE_KEY: STORE_KEY,
      DEFAULT_TTL_MS: DEFAULT_TTL_MS,
      get: get,
      entry: entry,
      set: set,
      purge: purge,
      sweep: sweep,
      keys: keys
    };
  })();

  window.__SFDC24_SCHEMA_CACHE = SCHEMA_CACHE;

  /* ------------------------------------------------------------------
     2. Tiered preload with budgets
     ------------------------------------------------------------------ */
  var PRELOAD = (function () {
    var BUDGET = { hot: 3, warm: 5, cold: 6 };
    var spent = { hot: 0, warm: 0, cold: 0 };
    var ran = { hot: false, warm: false, cold: false };
    var log = [];

    var HOT = ["/data/site-manifest.json"];
    var WARM_JSON = ["/data/org.json", "/data/desk.json"];
    var COLD_PAGES = ["/agents/", "/method/", "/privacy/", "/terms/"];

    function note(lane, url, how) {
      if (log.length < 64) log.push({ lane: lane, url: url, how: how, t: Date.now() });
    }

    function spend(lane) {
      if (spent[lane] >= BUDGET[lane]) return false;
      spent[lane]++;
      return true;
    }

    function linkHint(url, rel) {
      try {
        if ($('link[data-preload-url="' + url + '"]')) return false;
        var l = document.createElement("link");
        l.rel = rel || "prefetch";
        l.href = url;
        l.setAttribute("data-preload-url", url);
        document.head.appendChild(l);
        return true;
      } catch (e) {
        return false;
      }
    }

    /* JSON schema fetch: cache-first, then network into the schema cache. */
    function schema(url, lane, ttlMs) {
      if (SCHEMA_CACHE.get(url) !== null) { note(lane, url, "cache-hit"); return true; }
      if (!spend(lane)) { note(lane, url, "over-budget"); return false; }
      if (!window.fetch) { linkHint(url, "prefetch"); note(lane, url, "link-only"); return true; }
      try {
        fetch(url, { credentials: "same-origin", cache: "force-cache" })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (data) {
            if (data) { SCHEMA_CACHE.set(url, data, ttlMs); note(lane, url, "stored"); }
            else note(lane, url, "empty");
          })
          .catch(function () { note(lane, url, "failed"); });
      } catch (e) {
        note(lane, url, "threw");
      }
      return true;
    }

    function page(url, lane) {
      if (!spend(lane)) { note(lane, url, "over-budget"); return false; }
      linkHint(url, "prefetch");
      note(lane, url, "prefetch");
      return true;
    }

    /* HOT: the one payload the cabinet itself reads on boot. */
    function hot() {
      if (ran.hot) return false;
      ran.hot = true;
      SCHEMA_CACHE.sweep();
      HOT.forEach(function (u) { schema(u, "hot"); });
      return true;
    }

    /* WARM: visitor touched the ask box — desk/org schema + triage warmup. */
    function warm() {
      if (ran.warm) return false;
      ran.warm = true;
      HOT.forEach(function (u) { schema(u, "warm"); });
      WARM_JSON.forEach(function (u) { schema(u, "warm"); });
      try {
        if (window.__TRIAGE && typeof window.__TRIAGE.warm === "function") {
          window.__TRIAGE.warm();
          note("warm", "__TRIAGE.warm", "called");
        }
      } catch (e) {}
      return true;
    }

    /* COLD: idle-time prefetch of the long-form pages behind the panels. */
    function cold() {
      if (ran.cold) return false;
      ran.cold = true;
      COLD_PAGES.forEach(function (u) { page(u, "cold"); });
      return true;
    }

    function scheduleCold() {
      var fire = function () { try { cold(); } catch (e) {} };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(fire, { timeout: 4000 });
      } else {
        setTimeout(fire, 2000);
      }
    }

    function status() {
      return {
        budget: { hot: BUDGET.hot, warm: BUDGET.warm, cold: BUDGET.cold },
        spent: { hot: spent.hot, warm: spent.warm, cold: spent.cold },
        ran: { hot: ran.hot, warm: ran.warm, cold: ran.cold },
        cacheKeys: SCHEMA_CACHE.keys(),
        log: log.slice(0)
      };
    }

    return {
      hot: hot,
      warm: warm,
      cold: cold,
      scheduleCold: scheduleCold,
      status: status
    };
  })();

  window.__SFDC24_PRELOAD = {
    hot: PRELOAD.hot,
    warm: PRELOAD.warm,
    cold: PRELOAD.cold,
    status: PRELOAD.status
  };

  /* ------------------------------------------------------------------
     3. Cabinet view switching
     ------------------------------------------------------------------ */
  function show(name) {
    if (name === "speed") name = "method";
    var href = PAGE_FOR[name];
    if (!href) return;
    if (name === "board") {
      try { history.replaceState(null, "", "#"); } catch (e) {}
      try { window.scrollTo(0, 0); } catch (e2) {}
      return;
    }
    try { PRELOAD.cold(); } catch (e3) {}
    try { location.assign(href); } catch (e4) {}
  }

  function injectCabinetChrome() {
    /* Footer-only: do not insert a mid-page Board/Method/Panels row. */
  }

  function bindCabinetLinks(root) {
    $all("[data-cabinet-link]", root || document).forEach(function (a) {
      if (a.__cabBound) return;
      a.__cabBound = true;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        show(a.getAttribute("data-cabinet-link"));
      });
    });
  }

  function bootCabinet() {
    injectCabinetChrome();
    window.__SFDC24_CABINET = {
      show: show,
      views: VIEWS.slice()
    };
    bindCabinetLinks(document);
    var rawHash = location.hash || "";
    var hash = rawHash.replace(/^#cabinet-/, "").replace(/^#/, "");
    if (hash === "speed") hash = "method";
    var href = PAGE_FOR[hash] || LEGAL_PAGES[hash];
    if (href && hash && hash !== "board") {
      try { location.replace(href); } catch (e0) {}
      return;
    }
    /* Chrome may rebuild the footer after us — rebind shortly. */
    setTimeout(function () { bindCabinetLinks(document); }, 0);
    setTimeout(function () { bindCabinetLinks(document); }, 400);
  }

  function bindAskWarm() {
    var box = document.getElementById("box");
    if (!box) return;
    var fired = false;
    function warm() {
      if (fired) return;
      fired = true;
      try { PRELOAD.warm(); } catch (e) {}
    }
    box.addEventListener("focus", warm);
    box.addEventListener("pointerdown", warm);
  }

  function boot() {
    bootCabinet();
    bindAskWarm();
    try { PRELOAD.hot(); } catch (e) {}
    try { PRELOAD.scheduleCold(); } catch (e2) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
