/* Homepage cabinet + ask prefetch. Loaded as external script so the chat
   inline block stays last (homepage_recovery.cjs). */
(function () {
  "use strict";
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function show(name) {
    $all("#cabinetTabs [data-cabinet]").forEach(function (btn) {
      var on = btn.getAttribute("data-cabinet") === name;
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    $all("[data-cabinet-panel]").forEach(function (p) {
      var on = p.getAttribute("data-cabinet-panel") === name;
      p.classList.toggle("is-on", on);
      p.hidden = !on;
    });
    $all("[data-cabinet-board]").forEach(function (el) {
      el.hidden = name !== "board";
      el.classList.toggle("is-on", name === "board");
    });
    try {
      history.replaceState(null, "", name === "board" ? "#" : "#cabinet-" + name);
    } catch (e) {}
    var spd = $("#cabSpeed");
    if (spd && name === "method") {
      spd.textContent = (performance && performance.now)
        ? Math.round(performance.now()) + " ms"
        : "fast";
    }
  }

  function injectCabinetChrome() {
    if ($("#cabinetTabs")) return;
    var mount = $("#dol") || $("#liveflow") || $("#console") || document.body;
    if (!mount || !mount.parentNode) return;
    var nav = document.createElement("nav");
    nav.className = "cabinet-tabs";
    nav.id = "cabinetTabs";
    nav.setAttribute("aria-label", "Cabinet views");
    ["board","method","panels","privacy","terms"].forEach(function(name){
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-cabinet", name);
      b.setAttribute("aria-selected", name === "board" ? "true" : "false");
      b.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      nav.appendChild(b);
    });
    mount.parentNode.insertBefore(nav, mount);
    var panels = {
      method: '<div class="cabinet-ill" role="img" aria-label="Method loop"><div class="step"><b>1 · Ask</b><span>Visitor names a gap</span></div><div class="step"><b>2 · Infer</b><span>Signals weight speed/cost/quality</span></div><div class="step"><b>3 · Decide</b><span>Closeable recommendation</span></div><div class="step"><b>4 · Act</b><span>Buy, schedule, or walk away</span></div></div><div class="cabinet-dash"><div class="cabinet-card"><h3>Speed</h3><div class="num" id="cabSpeed">—</div><p>First-class arrival / setup / time-to-value</p></div><div class="cabinet-card"><h3>Cost</h3><div class="num">$</div><p>Second axis — visitor can reweight</p></div><div class="cabinet-card"><h3>Quality</h3><div class="num">Σ</div><p>Third axis — Six Sigma triad</p></div></div><p class="caveat">Short form: question → decision → action. Full honest-boundary text lives on <a href="/method/">/method/</a>.</p>',
      panels: '<table class="cabinet-table"><thead><tr><th>Panel</th><th>Kind</th><th>Status</th></tr></thead><tbody><tr><td>Projects</td><td>Build lanes</td><td><a href="/projects/">open</a></td></tr><tr><td>Voice</td><td>First-party talk</td><td><a href="/voice/">open</a></td></tr><tr><td>Pipeline desk</td><td>Org snapshot</td><td><a href="/org/">open</a></td></tr><tr><td>Agents</td><td>DoL roster</td><td><a href="/agents/">open</a></td></tr></tbody></table>',
      privacy: '<div class="cabinet-dash"><div class="cabinet-card"><h3>Session inferences</h3><p>Stored locally for this visit. Default: no cross-session persist.</p></div><div class="cabinet-card"><h3>Ask text</h3><p>Handled by the gate in-browser when possible.</p></div><div class="cabinet-card"><h3>Full policy</h3><p><a href="/privacy/">Open Privacy</a></p></div></div>',
      terms: '<div class="cabinet-dash"><div class="cabinet-card"><h3>Use</h3><p>Interactive research-stage surface. Not a live customer org.</p></div><div class="cabinet-card"><h3>Decisions</h3><p>Recommendations are closeable suggestions, not legal advice.</p></div><div class="cabinet-card"><h3>Full terms</h3><p><a href="/terms/">Open Terms</a></p></div></div>'
    };
    Object.keys(panels).forEach(function(name){
      var sec = document.createElement("section");
      sec.className = "cabinet-panel";
      sec.setAttribute("data-cabinet-panel", name);
      sec.id = "cabinet-" + name;
      sec.hidden = true;
      sec.innerHTML = panels[name];
      nav.parentNode.insertBefore(sec, nav.nextSibling);
    });
    ["#liveflow", "#dol", "#console"].forEach(function(sel){
      var el = $(sel);
      if (el) { el.setAttribute("data-cabinet-board", "1"); el.classList.add("cabinet-board"); }
    });
  }

  function bootCabinet() {
    injectCabinetChrome();
    var nav = $("#cabinetTabs");
    if (!nav) return;
    nav.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cabinet]");
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
    if (hash && ["board", "method", "panels", "privacy", "terms"].indexOf(hash) >= 0) show(hash);
    else show("board");
  }
  function prefetchAsk() {
    var box = document.getElementById("box");
    if (!box) return;
    var done = false;
    function warm() {
      if (done) return;
      done = true;
      try {
        var u = "/data/site-manifest.json";
        if (window.fetch) fetch(u, { credentials: "same-origin", cache: "force-cache" }).catch(function () {});
        var l = document.createElement("link");
        l.rel = "prefetch";
        l.href = u;
        document.head.appendChild(l);
      } catch (e) {}
      try {
        if (window.__TRIAGE && typeof window.__TRIAGE.warm === "function") window.__TRIAGE.warm();
      } catch (e2) {}
    }
    box.addEventListener("focus", warm);
    box.addEventListener("pointerdown", warm);
  }
  function boot() { bootCabinet(); prefetchAsk(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
