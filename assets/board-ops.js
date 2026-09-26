/* /ops/ engine. Polls a baked JSON snap. Never calls the Blackboard bus.
 *
 * Same-origin file first (the sample committed with the page, or a snap a
 * reviewed change put on main). Then the board-ops-snap branch, which the
 * bake workflow updates and which Pages does not rebuild. Whichever sanitized
 * snap is newer wins. A missing file leaves the last good picture, or the
 * empty state when there has not been one.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) api.boot(root);
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SAME = "/data/board-ops-snap.json";
  var BRANCH = "https://raw.githubusercontent.com/sfdc-24/sfdc24-site/board-ops-snap/data/board-ops-snap.json";
  var REFRESH_MIN = 60;
  var REFRESH_MAX = 120;
  var ID_PREFIX = 16;
  var STATUSES = { hot: 1, warm: 1, cool: 1, quiet: 1 };
  var PHASES = { DISPATCH: 1, REVIEW: 1, RESULT: 1, NOGO: 1, ACK: 1 };
  var HEALTHS = { ok: 1, degraded: 1, unknown: 1 };
  var CONCLUSIONS = { success: 1, failure: 1, cancelled: 1, skipped: 1, unknown: 1 };
  var REPOS = { "sfdc24-site": 1, Blackboard: 1 };
  var TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  var IDENT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  var WORK_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
  var LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .,:/+-]{0,63}$/;
  var URL_RE = /^https:\/\/github\.com\/sfdc-24\/(?:sfdc24-site|Blackboard)\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{0,160}$/;
  var RETIRED_RE = /foundry|azure/i;
  var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  var SECRET_VALUE_RE = new RegExp(
    ["gh" + "p_", "github_" + "pat_", "gho" + "_", "glpat-", "xox[baprs]-", "sk-", "ya29\\.", "AKIA[0-9A-Z]{16}", "-----BEGIN "].join("|"),
    "i"
  );
  var FORBIDDEN = {
    email: 1, "e-mail": 1, mail: 1, token: 1, access_token: 1, refresh_token: 1, id_token: 1,
    secret: 1, password: 1, passwd: 1, credential: 1, credentials: 1, api_key: 1, apikey: 1,
    authorization: 1, auth: 1, transcript: 1, payload: 1, raw: 1, body: 1, cookie: 1,
    cookies: 1, session: 1, private_key: 1, bearer: 1
  };
  var CAPS = { agents: 12, open_work: 16, edges: 24, envs: 6, ci: 8 };
  var PHASE_COLOR = {
    DISPATCH: "#3DDC97", REVIEW: "#E8A317", RESULT: "#8FC7FF", NOGO: "#E85D4C", ACK: "#C6E06A"
  };
  var STATUS_COLOR = { hot: "#3DDC97", warm: "#C6E06A", cool: "#6d8f86", quiet: "#3d4f48" };
  var SLOTS = [
    { x: 148, y: 168 }, { x: 852, y: 168 }, { x: 148, y: 392 }, { x: 852, y: 392 },
    { x: 500, y: 78 }, { x: 500, y: 470 }
  ];

  function forbiddenKey(key) {
    if (typeof key !== "string") return true;
    var norm = key.replace(/-/g, "_").toLowerCase();
    return !!FORBIDDEN[norm] || /_token$/.test(norm) || /_secret$/.test(norm);
  }

  function secretish(value) {
    return typeof value === "string" && (EMAIL_RE.test(value) || SECRET_VALUE_RE.test(value));
  }

  function retired(value) {
    return typeof value === "string" && RETIRED_RE.test(value);
  }

  function isTs(value) {
    return typeof value === "string" && TS_RE.test(value);
  }

  function ident(value) {
    if (typeof value !== "string") return null;
    var text = value.trim().toLowerCase();
    if (!IDENT_RE.test(text) || retired(text) || secretish(text)) return null;
    return text.slice(0, ID_PREFIX);
  }

  function prefixId(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (!text || text.length > 80 || retired(text) || secretish(text) || !WORK_RE.test(text)) return null;
    return text.slice(0, ID_PREFIX);
  }

  function count(value, limit) {
    limit = limit || 100000;
    if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value || value < 0) return 0;
    return value > limit ? limit : value;
  }

  function label(value, limit) {
    limit = limit || 64;
    if (typeof value !== "string") return null;
    var text = value.replace(/\s+/g, " ").trim();
    if (!text || text.length > limit || !LABEL_RE.test(text) || retired(text) || secretish(text)) return null;
    return text;
  }

  function phaseOf(value) {
    if (typeof value !== "string") return null;
    var phase = value.trim().toUpperCase();
    return PHASES[phase] ? phase : null;
  }

  function stripKeys(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    var out = {};
    for (var key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key) && !forbiddenKey(key)) out[key] = row[key];
    }
    return out;
  }

  function cleanAgent(row) {
    row = stripKeys(row);
    if (!row) return null;
    var id = ident(row.id);
    if (!id) return null;
    return {
      id: id,
      last_seen: isTs(row.last_seen) ? row.last_seen : null,
      writes_1h: count(row.writes_1h),
      open_dispatch: count(row.open_dispatch),
      status: STATUSES[row.status] ? row.status : "quiet"
    };
  }

  function cleanWork(row) {
    row = stripKeys(row);
    if (!row) return null;
    var id = prefixId(row.id);
    var from = ident(row.from);
    var phase = phaseOf(row.phase);
    if (!id || !from || !phase) return null;
    var tos = [];
    var list = Array.isArray(row.to) ? row.to : [];
    for (var i = 0; i < list.length && tos.length < 6; i++) {
      var dest = ident(list[i]);
      if (dest && tos.indexOf(dest) < 0) tos.push(dest);
    }
    var out = { id: id, from: from, to: tos, phase: phase, age_min: count(row.age_min, 10080) };
    if (typeof row.pr === "number" && row.pr === Math.floor(row.pr) && row.pr >= 1 && row.pr <= 1000000) out.pr = row.pr;
    return out;
  }

  function cleanEdge(row) {
    row = stripKeys(row);
    if (!row) return null;
    var from = ident(row.from);
    var to = ident(row.to);
    var phase = phaseOf(row.phase);
    if (!from || !to || !phase || !isTs(row.ts)) return null;
    return { from: from, to: to, phase: phase, ts: row.ts };
  }

  function cleanEnv(row) {
    row = stripKeys(row);
    if (!row) return null;
    var id = ident(row.id);
    var name = label(row.label);
    if (!id || !name || !HEALTHS[row.health]) return null;
    var out = { id: id, label: name, health: row.health };
    var note = label(row.note, 80);
    if (note) out.note = note;
    if (typeof row.traffic_pct === "number" && row.traffic_pct === Math.floor(row.traffic_pct) && row.traffic_pct >= 0 && row.traffic_pct <= 100) {
      out.traffic_pct = row.traffic_pct;
    }
    return out;
  }

  function cleanCi(row) {
    row = stripKeys(row);
    if (!row) return null;
    var name = label(row.name);
    if (!REPOS[row.repo] || !CONCLUSIONS[row.conclusion] || !name || !isTs(row.ts) || retired(name)) return null;
    var out = { repo: row.repo, conclusion: row.conclusion, name: name, ts: row.ts };
    if (typeof row.url === "string" && URL_RE.test(row.url) && !secretish(row.url)) out.url = row.url;
    return out;
  }

  function take(list, cap) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, cap);
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1 || !isTs(raw.baked_at)) return null;
    var refresh = 120;
    if (typeof raw.refresh_sec === "number" && raw.refresh_sec === Math.floor(raw.refresh_sec)) {
      refresh = Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, raw.refresh_sec));
    }
    var every = (typeof raw.bake_every_min === "number" && raw.bake_every_min === Math.floor(raw.bake_every_min) && raw.bake_every_min >= 1 && raw.bake_every_min <= 30)
      ? raw.bake_every_min : 5;
    var source = raw.source === "sample" || raw.source === "bake" ? raw.source : "bake";
    var agents = take(raw.agents, CAPS.agents).map(cleanAgent).filter(Boolean);
    var work = take(raw.open_work, CAPS.open_work).map(cleanWork).filter(Boolean);
    var edges = take(raw.edges, CAPS.edges).map(cleanEdge).filter(Boolean);
    var envs = take(raw.envs, CAPS.envs).map(cleanEnv).filter(Boolean);
    var ci = take(raw.ci, CAPS.ci).map(cleanCi).filter(Boolean);
    var statsIn = stripKeys(raw.stats) || {};
    var median = statsIn.median_ack_min;
    var medianOut = (typeof median === "number" && isFinite(median) && median >= 0) ? Math.round(median * 10) / 10 : null;
    return {
      v: 1,
      baked_at: raw.baked_at,
      refresh_sec: refresh,
      bake_every_min: every,
      source: source,
      agents: agents,
      open_work: work,
      edges: edges,
      envs: envs,
      ci: ci,
      stats: {
        rows_sampled: count(statsIn.rows_sampled) || (agents.length + work.length + edges.length + ci.length),
        dispatch_open: count(statsIn.dispatch_open),
        result_1h: count(statsIn.result_1h),
        nogo_1h: count(statsIn.nogo_1h),
        median_ack_min: medianOut
      }
    };
  }

  function pick(local, remote) {
    if (!local) return remote || null;
    if (!remote) return local;
    if (local.source !== "bake" && remote.source === "bake") return remote;
    if (remote.source !== "bake" && local.source === "bake") return local;
    return String(local.baked_at) >= String(remote.baked_at) ? local : remote;
  }

  function resolve(local, remote, had) {
    var snap = pick(local, remote);
    if (snap) return { snap: snap, had: true, empty: false };
    if (had) return { snap: null, had: true, empty: false };
    return { snap: null, had: false, empty: true };
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ageLabel(iso, now) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "unknown";
    var min = Math.max(0, Math.round((now - t) / 60000));
    if (min < 1) return "<1m";
    if (min < 90) return min + "m";
    return Math.round(min / 60) + "h";
  }

  function noteText(snap) {
    var n = snap && snap.bake_every_min ? snap.bake_every_min : 5;
    return "Snapshot baked every " + n + " minutes — not a live bus.";
  }

  function liveEdge(edge, baked) {
    var a = Date.parse(edge.ts);
    var b = Date.parse(baked);
    if (!isFinite(a) || !isFinite(b)) return false;
    var min = (b - a) / 60000;
    return min >= 0 && min <= 45;
  }

  function slotFor(index) {
    return SLOTS[index] || SLOTS[SLOTS.length - 1];
  }

  function engineSvg(snap) {
    var agents = snap.agents || [];
    var edges = snap.edges || [];
    var envs = snap.envs || [];
    var work = snap.open_work || [];
    var byPhase = { DISPATCH: 0, REVIEW: 0, RESULT: 0, NOGO: 0, ACK: 0 };
    for (var w = 0; w < work.length; w++) byPhase[work[w].phase] = (byPhase[work[w].phase] || 0) + 1;
    var pos = {};
    for (var i = 0; i < agents.length && i < SLOTS.length; i++) pos[agents[i].id] = slotFor(i);

    var runners = [];
    for (var e = 0; e < edges.length; e++) {
      var edge = edges[e];
      var from = pos[edge.from];
      if (!from) continue;
      var color = PHASE_COLOR[edge.phase] || "#8aa396";
      var live = liveEdge(edge, snap.baked_at) ? " live" : "";
      runners.push(
        '<path class="runner' + live + '" d="M' + from.x + " " + from.y + ' L500 280" stroke="' + color + '" />'
      );
    }

    var nodes = [];
    for (var n = 0; n < agents.length && n < SLOTS.length; n++) {
      var agent = agents[n];
      var at = slotFor(n);
      var color = STATUS_COLOR[agent.status] || STATUS_COLOR.quiet;
      var halo = agent.status === "hot" ? '<circle class="halo" cx="' + at.x + '" cy="' + at.y + '" r="34" stroke="' + color + '" />' : "";
      nodes.push(
        '<g class="port">' + halo +
        '<circle cx="' + at.x + '" cy="' + at.y + '" r="22" fill="#101814" stroke="' + color + '" stroke-width="3" />' +
        '<text x="' + at.x + '" y="' + (at.y + 40) + '" text-anchor="middle" class="port-name">' + esc(agent.id) + "</text>" +
        '<text x="' + at.x + '" y="' + (at.y + 54) + '" text-anchor="middle" class="port-meta">' + esc(agent.status) + " · " + agent.writes_1h + " in 1h</text>" +
        "</g>"
      );
    }

    var bores = [];
    var phases = ["DISPATCH", "REVIEW", "RESULT", "NOGO"];
    for (var p = 0; p < phases.length; p++) {
      var countN = byPhase[phases[p]] || 0;
      var cx = 430 + p * 46;
      var depth = 8 + Math.min(countN, 6) * 6;
      bores.push(
        '<g class="bore">' +
        '<ellipse cx="' + cx + '" cy="250" rx="16" ry="' + depth + '" fill="#0c1411" stroke="' + (PHASE_COLOR[phases[p]]) + '" />' +
        '<text x="' + cx + '" y="292" text-anchor="middle" class="bore-n">' + countN + '</text>' +
        '<text x="' + cx + '" y="308" text-anchor="middle" class="bore-l">' + phases[p].slice(0, 3) + '</text>' +
        "</g>"
      );
    }

    var envNodes = [];
    var envXs = [180, 500, 820];
    for (var v = 0; v < envs.length && v < 3; v++) {
      var env = envs[v];
      var ex = envXs[v];
      var hc = env.health === "ok" ? "#3DDC97" : (env.health === "degraded" ? "#E85D4C" : "#8aa396");
      var pct = typeof env.traffic_pct === "number" ? " · " + env.traffic_pct + "%" : "";
      envNodes.push(
        '<g class="can">' +
        '<rect x="' + (ex - 78) + '" y="518" width="156" height="52" rx="8" fill="#141c18" stroke="' + hc + '" />' +
        '<text x="' + ex + '" y="540" text-anchor="middle" class="can-name">' + esc(env.label) + '</text>' +
        '<text x="' + ex + '" y="556" text-anchor="middle" class="can-meta">' + esc(env.health) + pct + "</text>" +
        "</g>"
      );
    }

    return '' +
      '<svg class="bay" viewBox="0 0 1000 600" role="img" aria-label="Blackboard at the center, agents around it, environments along the manifold">' +
      '<defs><pattern id="fins" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8 L8 0" stroke="#1d2b24" stroke-width="1"/></pattern></defs>' +
      '<rect x="40" y="40" width="920" height="540" rx="18" fill="#101714" stroke="#24362c" />' +
      '<rect x="40" y="40" width="920" height="540" rx="18" fill="url(#fins)" opacity="0.45" />' +
      '<path class="manifold" d="M500 400 L500 500 L180 500 L180 518 M500 500 L500 518 M500 500 L820 500 L820 518" />' +
      runners.join("") +
      '<g class="block">' +
      '<path d="M390 150 H610 L640 400 H360 Z" fill="#1a2620" stroke="#3d5c4a" stroke-width="2" />' +
      '<circle cx="404" cy="168" r="4" fill="#8aa396" /><circle cx="596" cy="168" r="4" fill="#8aa396" />' +
      '<circle cx="378" cy="384" r="4" fill="#8aa396" /><circle cx="622" cy="384" r="4" fill="#8aa396" />' +
      '<text x="500" y="196" text-anchor="middle" class="block-kicker">motherboard</text>' +
      '<text x="500" y="220" text-anchor="middle" class="block-title">BLACKBOARD</text>' +
      bores.join("") +
      "</g>" +
      nodes.join("") +
      envNodes.join("") +
      "</svg>";
  }

  function stripHtml(snap, now) {
    var stats = snap.stats || {};
    var fails = 0;
    var ci = snap.ci || [];
    for (var i = 0; i < ci.length; i++) if (ci[i].conclusion === "failure") fails += 1;
    var ack = stats.median_ack_min;
    var ackText = ack == null ? "—" : (ack + "m");
    var source = snap.source === "sample" ? "Sample" : "Baked";
    return '' +
      '<div class="stat"><span>Bake age</span><strong>' + esc(ageLabel(snap.baked_at, now)) + "</strong></div>" +
      '<div class="stat"><span>Open dispatch</span><strong>' + esc(stats.dispatch_open) + "</strong></div>" +
      '<div class="stat"><span>CI failures</span><strong class="' + (fails ? "bad" : "ok") + '">' + fails + "</strong></div>" +
      '<div class="stat"><span>Median ack</span><strong>' + esc(ackText) + "</strong></div>" +
      '<p class="source-pill ' + esc(snap.source) + '">' + source + " · " + esc(stats.rows_sampled) + " rows in the window</p>";
  }

  function listsHtml(snap) {
    var work = snap.open_work || [];
    var ci = snap.ci || [];
    var chips = [];
    for (var i = 0; i < work.length && i < 6; i++) {
      var row = work[i];
      var dest = row.to && row.to.length ? " → " + row.to.join(", ") : "";
      var pr = row.pr ? " · #" + row.pr : "";
      chips.push("<li><b>" + esc(row.phase) + "</b> " + esc(row.from) + esc(dest) + " · " + row.age_min + "m · " + esc(row.id) + esc(pr) + "</li>");
    }
    var badges = [];
    for (var c = 0; c < ci.length; c++) {
      var item = ci[c];
      var inner = esc(item.repo) + " · " + esc(item.name) + " · " + esc(item.conclusion);
      if (item.url) {
        badges.push('<li class="' + esc(item.conclusion) + '"><a href="' + esc(item.url) + '" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">' + inner + "</a></li>");
      } else {
        badges.push('<li class="' + esc(item.conclusion) + '">' + inner + "</li>");
      }
    }
    return '' +
      '<ul class="work">' + (chips.join("") || "<li>No open rows in this snap.</li>") + "</ul>" +
      '<ul class="ci">' + (badges.join("") || "<li>No recent workflow rows in this snap.</li>") + "</ul>";
  }

  function emptyPaint() {
    return {
      strip: '<p class="empty">Snapshot unavailable.</p>',
      engine: '<svg class="bay dim" viewBox="0 0 1000 600" role="img" aria-label="Snapshot unavailable"><rect x="40" y="40" width="920" height="540" rx="18" fill="#101714" stroke="#24362c"/><text x="500" y="300" text-anchor="middle" class="block-title">SNAPSHOT UNAVAILABLE</text></svg>',
      lists: "",
      note: noteText(null)
    };
  }

  function paint(snap, now) {
    if (!snap) return emptyPaint();
    return {
      strip: stripHtml(snap, now || Date.parse(snap.baked_at)),
      engine: engineSvg(snap),
      lists: listsHtml(snap),
      note: noteText(snap)
    };
  }

  function urls() {
    return [SAME, BRANCH];
  }

  return {
    sanitize: sanitize,
    pick: pick,
    resolve: resolve,
    paint: paint,
    emptyPaint: emptyPaint,
    noteText: noteText,
    urls: urls,
    esc: esc,
    SAME: SAME,
    BRANCH: BRANCH,
    boot: boot
  };

  function boot(win) {
    var doc = win.document;
    var strip = doc.getElementById("engine-strip");
    var engine = doc.getElementById("engine");
    var lists = doc.getElementById("engine-lists");
    var note = doc.getElementById("engine-note");
    if (!engine) return;
    var had = false;
    var timer = null;

    function render(view) {
      if (strip) strip.innerHTML = view.strip;
      engine.innerHTML = view.engine;
      if (lists) lists.innerHTML = view.lists;
      if (note) note.textContent = view.note;
    }

    function schedule(sec) {
      if (timer) win.clearTimeout(timer);
      var wait = sec * 1000;
      if (!(wait >= 60000 && wait <= 120000)) wait = 120000;
      timer = win.setTimeout(tick, wait);
    }

    function getJson(url) {
      return win.fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Math.floor(Date.now() / 60000), {
        cache: "no-store",
        credentials: "omit"
      }).then(function (res) {
        if (!res.ok) throw new Error("status");
        return res.json();
      }).then(function (raw) {
        return sanitize(raw);
      }).catch(function () {
        return null;
      });
    }

    function tick() {
      win.Promise.all([getJson(SAME), getJson(BRANCH)]).then(function (pair) {
        var decision = resolve(pair[0], pair[1], had);
        had = decision.had;
        if (decision.empty) render(emptyPaint());
        else if (decision.snap) render(paint(decision.snap, Date.now()));
        schedule(decision.snap ? decision.snap.refresh_sec : 120);
      }).catch(function () {
        if (!had) render(emptyPaint());
        schedule(120);
      });
    }

    try { tick(); } catch (err) { render(emptyPaint()); }
  }
});
