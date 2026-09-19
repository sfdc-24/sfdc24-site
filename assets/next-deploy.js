/* NEXT DEPLOY — right-rail Release (estimate vs execution).
 * Edit: data-next-deploy on #nextDeploy OR window.__SFDC24_NEXT_DEPLOY
 */
(function () {
  "use strict";
  var PROMISED = "2026-09-19T01:06:00-04:00";
  var STAGING = "https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/";
  var ACC = "__chromeAccuracy";
  var LOG = "sfdc24_eta_feedback";
  var AUTO = "sfdc24_eta_auto_delta";

  function css() {
    if (document.getElementById("nd-style")) return;
    var s = document.createElement("style");
    s.id = "nd-style";
    s.textContent =
      "#nextDeploy{position:fixed;top:72px;right:12px;z-index:40;width:min(220px,calc(100vw - 24px));" +
      "display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:0;" +
      "background:rgba(3,45,96,.97);color:#fff;border:1px solid #14507F;border-radius:8px;" +
      "font:600 11px/1.35 ui-monospace,Menlo,monospace;box-shadow:0 4px 16px rgba(0,0,0,.28)}" +
      "#nextDeploy .k{font:700 9px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#57C1FF}" +
      "#nextDeploy .s{font:500 12px/1.35 system-ui,sans-serif;color:#E3EBF4;margin:0}" +
      "#nextDeploy .r{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}" +
      "#nextDeploy .lbl{letter-spacing:.06em;text-transform:uppercase;color:#9BD4FF;font-size:10px}" +
      "#nextDeploy b{color:#fff;font-size:13px}" +
      "#nextDeploy .rem[data-state=due] b{color:#F0C14A}" +
      "#nextDeploy .rem[data-state=deploying] b,#nextDeploy .rem[data-state=early] b{color:#7FD1A8}" +
      "#nextDeploy .rem[data-state=late] b{color:#F0A070}" +
      "#nextDeploy .delta{font:600 10px/1.2 system-ui,sans-serif;color:#9BD4FF}" +
      "#nextDeploy .links{display:flex;flex-wrap:wrap;gap:6px}" +
      "#nextDeploy a{color:#fff;text-decoration:none;border-bottom:1px solid #57C1FF;font:600 11px/1 system-ui,sans-serif}" +
      "#nextDeploy a:hover,#nextDeploy a:focus-visible{background:#14507F}" +
      "#nextDeploy .fb{display:flex;flex-wrap:wrap;gap:4px;align-items:center}" +
      "#nextDeploy .fb span{font:500 9px/1 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#9BD4FF}" +
      "#nextDeploy .fb button{border:1px solid #2F5075;background:#1B3A5C;border-radius:3px;" +
      "font:600 9px/1 system-ui,sans-serif;padding:5px 7px;cursor:pointer;color:#E3EBF4}" +
      "#nextDeploy .fb button:hover,#nextDeploy .fb button:focus-visible{border-color:#57C1FF;background:#14507F}" +
      "#nextDeploy .fb button[aria-pressed=true]{border-color:#57C1FF;background:#0176D3;color:#fff}" +
      "@media(max-width:720px){#nextDeploy{top:auto;bottom:10px;right:8px;left:8px;width:auto}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function bar() {
    var el = document.getElementById("nextDeploy");
    if (el) return el;
    el = document.createElement("aside");
    el.id = "nextDeploy";
    el.setAttribute("data-next-deploy", window.__SFDC24_NEXT_DEPLOY || PROMISED);
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Release — estimate vs execution");
    el.innerHTML =
      '<div class="k">Release</div>' +
      '<p class="s" id="ndSentence">Next: homepage deploy with live ETA.</p>' +
      '<div class="r"><span class="lbl">NEXT DEPLOY</span><span title="Promised ETA">ETA <b id="ndEst">--:--</b></span></div>' +
      '<div class="r"><span class="rem" id="ndRemWrap" title="Remaining">rem <b id="ndRem">--:--</b></span>' +
      '<span title="Elapsed">run <b id="ndRun">0:00</b></span></div>' +
      '<span class="delta" id="ndDelta" hidden></span>' +
      '<div class="links">' +
      '<a href="' + STAGING + '" target="_blank" rel="noopener noreferrer" title="Preview before production">Staging</a>' +
      '<a href="#chrome-flow" id="ndCycle" title="Build → deploy → feedback → improve">Improve cycle</a></div>' +
      '<div class="fb" role="group" aria-label="Was this ETA honest?">' +
      "<span>beat?</span>" +
      '<button type="button" data-eta="early" title="Beat the ETA">early</button>' +
      '<button type="button" data-eta="on-time" title="On time">on-time</button>' +
      '<button type="button" data-eta="late" title="Delayed">delayed</button></div>';
    document.body.appendChild(el);
    return el;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(ms) {
    var neg = ms < 0; if (neg) ms = -ms;
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    var o = h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
    return neg ? "-" + o : o;
  }
  function shortEt(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return "--:--";
    try {
      return new Date(t).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true });
    } catch (e) { var d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  }
  function pulse(d) { try { if (typeof window[ACC] === "function") window[ACC](d); } catch (e) {} }
  function save(p) { try { sessionStorage.setItem(LOG, JSON.stringify(p)); } catch (e) {} }

  function boot() {
    css();
    var root = bar();
    var est = document.getElementById("ndEst");
    var rem = document.getElementById("ndRem");
    var remW = document.getElementById("ndRemWrap");
    var run = document.getElementById("ndRun");
    var delta = document.getElementById("ndDelta");
    var sent = document.getElementById("ndSentence");
    if (!est || !rem || !run) return;

    var BUILD = document.documentElement.getAttribute("data-build") ||
      (document.querySelector('meta[name="sfdc24-build"]') && document.querySelector('meta[name="sfdc24-build"]').content) || "";

    function promised() {
      if (window.__SFDC24_NEXT_DEPLOY) return String(window.__SFDC24_NEXT_DEPLOY);
      return root.getAttribute("data-next-deploy") || PROMISED;
    }
    function startMs() {
      var raw = window.__SFDC24_DEPLOY_START || root.getAttribute("data-deploy-start") || "";
      var t = Date.parse(raw);
      if (isFinite(t)) return t;
      if (!window.__SFDC24_DEPLOY_START_MS) window.__SFDC24_DEPLOY_START_MS = Date.now();
      return window.__SFDC24_DEPLOY_START_MS;
    }

    var hit0 = false, logged = false;

    function record(kind, sec, src) {
      save({ kind: kind, deltaSec: sec, promised: promised(), at: new Date().toISOString(), source: src || "auto" });
      if (kind === "early" || kind === "on-time") pulse(4);
      else if (kind === "late") pulse(-3);
      else pulse(-1);
      if (delta) { delta.hidden = false; delta.textContent = kind + " " + (sec > 0 ? "+" : "") + sec + "s"; }
      if (sent) {
        if (kind === "early") sent.textContent = "Beat the ETA — deploy landed early.";
        else if (kind === "on-time") sent.textContent = "On time — estimate matched execution.";
        else if (kind === "late") sent.textContent = "Delayed — execution past the estimate.";
      }
    }

    function auto(promisedMs, now) {
      if (logged) return;
      var key = promised();
      try { if (sessionStorage.getItem(AUTO) === key) { logged = true; return; } } catch (e) {}
      var fresh = false;
      try { if (BUILD) { var b = Date.parse(BUILD); if (isFinite(b) && b >= promisedMs) fresh = true; } } catch (e2) {}
      var sec = Math.round((now - promisedMs) / 1000);
      if (fresh && now < promisedMs) {
        logged = true;
        try { sessionStorage.setItem(AUTO, key); } catch (e3) {}
        record("early", sec, "build-stamp");
        rem.textContent = "LIVE"; remW.setAttribute("data-state", "early");
        return;
      }
      if (now >= promisedMs) {
        logged = true;
        try { sessionStorage.setItem(AUTO, key); } catch (e4) {}
        record(Math.abs(sec) <= 15 ? "on-time" : "late", sec, "timer-zero");
      }
    }

    function tick() {
      var iso = promised(), p = Date.parse(iso), now = Date.now();
      est.textContent = shortEt(iso);
      run.textContent = fmt(now - startMs());
      if (!isFinite(p)) { rem.textContent = "--:--"; return; }
      var left = p - now;
      if (left > 0) {
        hit0 = false;
        rem.textContent = fmt(left);
        remW.setAttribute("data-state", "counting");
        auto(p, now);
      } else {
        if (!hit0) {
          hit0 = true;
          rem.textContent = "DEPLOYING…";
          remW.setAttribute("data-state", "deploying");
          setTimeout(function () {
            if (Date.now() < p) return;
            rem.textContent = "DUE — refresh";
            remW.setAttribute("data-state", "due");
          }, 8000);
        } else if (remW.getAttribute("data-state") !== "due") remW.setAttribute("data-state", "late");
        auto(p, now);
      }
    }

    root.querySelectorAll(".fb button[data-eta]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-eta");
        root.querySelectorAll(".fb button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        var p = Date.parse(promised());
        var sec = isFinite(p) ? Math.round((Date.now() - p) / 1000) : 0;
        record(kind, sec, "visitor");
      });
    });

    var cycle = document.getElementById("ndCycle");
    if (cycle) {
      cycle.addEventListener("click", function (e) {
        var flow = document.getElementById("chrome-flow") || document.getElementById("liveflow");
        if (flow) { e.preventDefault(); flow.scrollIntoView({ behavior: "smooth", block: "center" }); pulse(1); }
      });
    }

    window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || promised();
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
