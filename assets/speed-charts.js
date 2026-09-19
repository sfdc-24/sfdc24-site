(function () {
  "use strict";
  function mean(xs) {
    if (!xs.length) return 0;
    var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }
  function stdev(xs, m) {
    if (xs.length < 2) return 0;
    var s = 0; for (var i = 0; i < xs.length; i++) { var d = xs[i] - m; s += d * d; }
    return Math.sqrt(s / (xs.length - 1));
  }
  function ctlSvg(values, opts) {
    opts = opts || {};
    var w = 320, h = 88, padX = 10, padY = 12;
    var m = mean(values);
    var sd = stdev(values, m);
    var ucl = opts.ucl != null ? opts.ucl : m + 3 * sd;
    var lcl = opts.lcl != null ? opts.lcl : Math.max(0, m - 3 * sd);
    var lo = Math.min.apply(null, values.concat([lcl]));
    var hi = Math.max.apply(null, values.concat([ucl, m]));
    if (hi <= lo) { hi = lo + 1; }
    function y(v) {
      return padY + (1 - (v - lo) / (hi - lo)) * (h - padY * 2);
    }
    function x(i, n) {
      if (n <= 1) return w / 2;
      return padX + (i / (n - 1)) * (w - padX * 2);
    }
    var n = values.length;
    var pts = [];
    for (var i = 0; i < n; i++) pts.push(x(i, n).toFixed(1) + "," + y(values[i]).toFixed(1));
    var ym = y(m).toFixed(1), yu = y(ucl).toFixed(1), yl = y(lcl).toFixed(1);
    return '<svg class="ctl" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + (opts.label || "control chart") + '">' +
      '<line x1="' + padX + '" y1="' + yu + '" x2="' + (w - padX) + '" y2="' + yu + '" stroke="#fca5a5" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<line x1="' + padX + '" y1="' + yl + '" x2="' + (w - padX) + '" y2="' + yl + '" stroke="#fca5a5" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<line x1="' + padX + '" y1="' + ym + '" x2="' + (w - padX) + '" y2="' + ym + '" stroke="#94a3b8" stroke-width="1"/>' +
      '<polyline fill="none" stroke="#0176D3" stroke-width="2" points="' + pts.join(" ") + '"/>' +
      pts.map(function (p) { var xy = p.split(","); return '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="2.5" fill="#032D60"/>'; }).join("") +
      '</svg>';
  }
  function fmt(v, unit) {
    if (v == null || isNaN(v)) return "—";
    if (unit === "ms") return Math.round(v) + " ms";
    if (unit === "min") return (Math.round(v * 10) / 10) + " min";
    if (unit === "%") return Math.round(v) + "%";
    return String(v);
  }
  function setLimits(el, values, unit) {
    if (!el) return;
    var m = mean(values), sd = stdev(values, m);
    el.textContent = "mean " + fmt(m, unit) + " · UCL " + fmt(m + 3 * sd, unit) + " · LCL " + fmt(Math.max(0, m - 3 * sd), unit);
  }
  function parseLog(text) {
    var rows = [];
    text.split(/\n+/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { rows.push(JSON.parse(line)); } catch (e) {}
    });
    return rows;
  }
  function render(rows) {
    var deploy = [], site = [], progress = [];
    var anyRealDeploy = false, anyRealSite = false, anyRealProgress = false;
    rows.forEach(function (r) {
      var ex = !!r.example;
      if (r.kind === "deploy_minutes" && typeof r.value === "number") {
        deploy.push(r.value); if (!ex) anyRealDeploy = true;
      } else if (r.kind === "site_ttfb_ms" && typeof r.value === "number") {
        site.push(r.value); if (!ex) anyRealSite = true;
      } else if (r.kind === "progress_pct" && typeof r.value === "number") {
        progress.push(r.value); if (!ex) anyRealProgress = true;
      }
    });
    function paint(kind, values, unit, tagId, metricId, chartId, limitsId, anyReal) {
      var tag = document.getElementById(tagId);
      if (tag) {
        if (anyReal) { tag.textContent = "REAL"; tag.className = "tag real"; }
        else { tag.textContent = "EXAMPLE"; tag.className = "tag example"; }
      }
      var last = values.length ? values[values.length - 1] : null;
      var metric = document.getElementById(metricId);
      if (metric) metric.textContent = last == null ? "—" : fmt(last, unit);
      var chart = document.getElementById(chartId);
      if (chart) chart.innerHTML = values.length ? ctlSvg(values, { label: kind }) : '<p class="hint">No points yet.</p>';
      setLimits(document.getElementById(limitsId), values, unit);
    }
    paint("deploy", deploy, "min", "deploy-tag", "deploy-metric", "deploy-chart", "deploy-limits", anyRealDeploy);
    paint("site", site, "ms", "site-tag", "site-metric", "site-chart", "site-limits", anyRealSite);
    paint("progress", progress, "%", "progress-tag", "progress-metric", "progress-chart", "progress-limits", anyRealProgress);
    if (progress.length) {
      var pt = document.getElementById("progress-tag");
      if (pt && anyRealProgress && rows.some(function (r) { return r.kind === "progress_pct" && r.example; })) {
        pt.textContent = "MIXED"; pt.className = "tag";
      }
    }
    var body = document.getElementById("speed-log-body");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5">No rows in speed-test-log.jsonl</td></tr>';
      return;
    }
    body.innerHTML = rows.slice().reverse().map(function (r) {
      var src = r.example ? '<span class="ex">EXAMPLE</span>' : (r.source || "real");
      return '<tr><td class="num">' + (r.ts || "") + '</td><td>' + (r.kind || "") + '</td><td class="num">' +
        (r.value != null ? r.value : "") + (r.unit ? " " + r.unit : "") + '</td><td>' + (r.note || "") +
        '</td><td>' + src + '</td></tr>';
    }).join("");
  }

  function mountFragment(done) {
    var host = document.getElementById("speed-mount");
    if (!host) { done(); return; }
    var url = host.getAttribute("data-fragment") || "/assets/speed-section.fragment.html";
    fetch(url, { credentials: "same-origin", cache: "no-cache" })
      .then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.text(); })
      .then(function (html) {
        var wrap = document.createElement("div");
        wrap.innerHTML = html.trim();
        var sec = wrap.querySelector("section") || wrap.firstElementChild;
        if (sec && host.parentNode) host.parentNode.replaceChild(sec, host);
        done();
      })
      .catch(function () {
        host.textContent = "Could not load SPEED panels fragment.";
        done();
      });
  }
  function boot() {
    mountFragment(function () {
    fetch("/data/speed-test-log.jsonl", { credentials: "same-origin", cache: "no-cache" })
      .then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.text(); })
      .then(parseLog)
      .then(render)
      .catch(function () {
        var body = document.getElementById("speed-log-body");
        if (body) body.innerHTML = '<tr><td colspan="5">Could not load <code>/data/speed-test-log.jsonl</code> — charts stay empty rather than invent silently.</td></tr>';
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
