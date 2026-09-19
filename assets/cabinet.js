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
  function bootCabinet() {
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
