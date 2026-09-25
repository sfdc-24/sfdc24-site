/* Release countdown. Homepage only.
 * A browser timer cannot observe a deployment. Never manufacture a deadline,
 * and never call a release early, on time, or delayed from visitor elapsed time.
 * Count down only when an explicit ISO is set via window.__SFDC24_NEXT_DEPLOY,
 * data-next-deploy, or /data/next-release.json. With no promise, the stopwatch
 * stays on screen and the remaining time reads --:--.
 * Note order: window.__SFDC24_NEXT_NOTE, data-next-note, the JSON note, DEFAULT_NOTE.
 */
(function () {
  "use strict";
  var CONFIG_URL = "/data/next-release.json";
  var DEFAULT_NOTE = "Next release time is not set";
  var configNote = "";
  var configAt = "";
  var configStart = "";
  var configLoading = false;

  function isHome() {
    var path = (location.pathname || "/").replace(/\/+$/, "") || "/";
    return path === "/" || path === "/index.html";
  }

  function isIso(v) {
    if (v == null) return false;
    var s = String(v).trim();
    if (!s || s === "null") return false;
    return isFinite(Date.parse(s));
  }

  function css() {
    if (document.getElementById("nd-style")) return;
    var style = document.createElement("style");
    style.id = "nd-style";
    style.textContent =
      "#nextDeploy{margin-left:auto;max-width:100%;min-width:0;color:#FFFFFF;pointer-events:none}" +
      "#nextDeploy .nd-sum{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;font:500 12px/1.5 system-ui,sans-serif}" +
      "#nextDeploy .nd-sum b{flex:none;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF}" +
      "#nextDeploy .s{color:#8FC7FF;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#nextDeploy .rem{flex:none;color:#FFFFFF;font:600 12px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:.02em}" +
      "#nextDeploy .viz{display:flex;align-items:center;flex:none}" +
      "#nextDeploy .viz svg{display:block;width:22px;height:22px}" +
      "@media(max-width:720px){#nextDeploy{flex-basis:100%;margin-left:0}}";
    (document.head || document.documentElement).appendChild(style);
  }

  /* Stopwatch: crown, face, one hand. Not a pie of lesson counts. */
  function watchSvg(frac) {
    var f = Number(frac);
    if (!isFinite(f) || f < 0) f = 0;
    if (f > 1) f = 1;
    var ang = (f * 2 * Math.PI) - Math.PI / 2;
    var cx = 12, cy = 13.2, r = 6.2;
    var hx = (cx + r * Math.cos(ang)).toFixed(2);
    var hy = (cy + r * Math.sin(ang)).toFixed(2);
    return '<svg class="watch" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<rect x="10" y="1.2" width="4" height="2.6" rx="0.5" fill="#FFFFFF"/>' +
      '<path d="M8.2 3.6 L9.4 5.1" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="#191919" stroke="#8FC7FF" stroke-width="1.6"/>' +
      '<line x1="12" y1="6.4" x2="12" y2="8.2" stroke="#0A66C2" stroke-width="1.1" stroke-linecap="round"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + hx + '" y2="' + hy + '" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="1.15" fill="#FFFFFF"/>' +
      "</svg>";
  }

  function place(el) {
    var header = document.querySelector("header.chrome-bar, header.masthead, header.bar, .chrome-bar");
    if (!header) return false;
    if (el.parentNode !== header) header.appendChild(el);
    return true;
  }

  function ensure(el) {
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Release");
    if (el.querySelector("#ndRem") && el.querySelector("#ndSentence") && el.querySelector("#ndViz")) return el;
    el.innerHTML =
      '<div class="nd-sum">' +
      "<b>Release</b>" +
      '<span class="s" id="ndSentence"></span>' +
      '<span class="rem" id="ndRem" role="timer" aria-atomic="true">--:--</span>' +
      '<span class="viz" id="ndViz"></span>' +
      "</div>";
    return el;
  }

  function bar() {
    var el = document.getElementById("nextDeploy");
    if (!el) {
      el = document.createElement("aside");
      el.id = "nextDeploy";
    }
    ensure(el);
    if (!place(el)) {
      if (!el.parentNode) document.body.appendChild(el);
    }
    return el;
  }

  function pad(n) {
    n = Math.floor(Math.abs(Number(n)) || 0);
    return (n < 10 ? "0" : "") + n;
  }

  function fmtRemaining(ms) {
    if (!isFinite(ms)) return "--:--";
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  function phase(root, rem, name, label) {
    root.setAttribute("data-release-phase", name);
    rem.setAttribute("aria-label", label);
    rem.setAttribute("title", label);
  }

  function shortNote(s) {
    if (s == null) return "";
    var words = String(s).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) return "";
    if (words.length > 9) words = words.slice(0, 9);
    return words.join(" ");
  }

  function noteText(root) {
    var candidates = [
      window.__SFDC24_NEXT_NOTE,
      root.getAttribute("data-next-note"),
      configNote,
      DEFAULT_NOTE
    ];
    for (var i = 0; i < candidates.length; i++) {
      var note = shortNote(candidates[i]);
      if (note) return note;
    }
    return DEFAULT_NOTE;
  }

  function promisedIso(root) {
    if (isIso(window.__SFDC24_NEXT_DEPLOY)) return String(window.__SFDC24_NEXT_DEPLOY).trim();
    var attr = root.getAttribute("data-next-deploy");
    if (isIso(attr)) return String(attr).trim();
    if (isIso(configAt)) return configAt;
    return "";
  }

  function startMs(root, end) {
    var raw = window.__SFDC24_DEPLOY_START || root.getAttribute("data-deploy-start") || configStart || "";
    var t = Date.parse(String(raw));
    if (isFinite(t) && isFinite(end) && t < end) return t;
    return NaN;
  }

  function handFrac(start, end, now) {
    if (now > end) return (Math.floor((now - end) / 1000) % 60) / 60;
    if (isFinite(start) && end > start) {
      var span = (now - start) / (end - start);
      if (span < 0) return 0;
      if (span > 1) return 1;
      return span;
    }
    var left = end - now;
    if (left < 0) left = 0;
    return (Math.floor(left / 1000) % 60) / 60;
  }

  function paintWatch(frac) {
    var host = document.getElementById("ndViz");
    if (!host) return;
    host.innerHTML = watchSvg(frac);
  }

  function boot() {
    if (!isHome()) return;
    if (window.__SFDC24_RELEASE_BOOTED) return;
    window.__SFDC24_RELEASE_BOOTED = 1;
    css();
    var root = bar();
    var rem = document.getElementById("ndRem");
    var sent = document.getElementById("ndSentence");
    if (!rem || !sent) return;

    function tick() {
      sent.textContent = noteText(root);
      var iso = promisedIso(root);
      var end = Date.parse(iso);
      if (!iso || !isFinite(end)) {
        rem.textContent = "--:--";
        phase(root, rem, "unset", "Next release time is not set");
        paintWatch(0);
        return;
      }
      var now = Date.now();
      if (now > end) {
        // The browser cannot claim whether a deployment happened. It can show
        // that the stated checkpoint passed, and keep the rail visibly alive,
        // instead of freezing forever at 00:00:00.
        rem.textContent = "+" + fmtRemaining(now - end);
        phase(root, rem, "elapsed", "Time since the stated release checkpoint");
      } else {
        rem.textContent = fmtRemaining(end - now);
        phase(root, rem, "countdown", "Time remaining until the stated release checkpoint");
      }
      paintWatch(handFrac(startMs(root, end), end, now));
    }

    function takeConfig(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (Object.prototype.hasOwnProperty.call(data, "note")) {
        configNote = typeof data.note === "string" ? data.note.trim() : "";
      }
      if (Object.prototype.hasOwnProperty.call(data, "at")) {
        configAt = isIso(data.at) ? String(data.at).trim() : "";
      }
      if (Object.prototype.hasOwnProperty.call(data, "start")) {
        configStart = isIso(data.start) ? String(data.start).trim() : "";
      }
    }

    function refreshConfig() {
      if (configLoading) return;
      configLoading = true;
      fetch(CONFIG_URL, { cache: "no-store" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (data) {
        takeConfig(data);
        tick();
      }).catch(function () {}).then(function () {
        configLoading = false;
      });
    }

    tick();
    place(root);
    setTimeout(function () { place(root); }, 400);
    setInterval(tick, 1000);
    refreshConfig();
    setInterval(refreshConfig, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
