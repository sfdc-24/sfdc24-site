/* /ops/ diagram. Polls a baked JSON snap. Never calls the live bus.
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
  var CAPS = { agents: 12, open_work: 16, edges: 24, envs: 6, ci: 8, branches: 8 };
  var BRANCH_KINDS = { feature: 1, fix: 1, chore: 1 };
  var BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
  var ROLES = [
    { id: "claude-code-cli", name: "Claude", role: "Implement", icon: "code" },
    { id: "codex", name: "Codex", role: "Strategy", icon: "bulb" },
    { id: "cursor", name: "Cursor", role: "Review", icon: "eye" },
    { id: "gemini", name: "Gemini", role: "Adversarial", icon: "shield" },
    { id: "grok", name: "Grok", role: "Positioning", icon: "target" }
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

  function metric(value, lo, hi) {
    if (typeof value !== "number" || !isFinite(value) || value < lo || value > hi) return null;
    var rounded = Math.round(value * 10) / 10;
    if (rounded === Math.round(rounded)) return Math.round(rounded);
    return rounded;
  }

  function cleanBranch(row) {
    row = stripKeys(row);
    if (!row) return null;
    var name = typeof row.name === "string" ? row.name : "";
    if (!BRANCH_RE.test(name) || retired(name) || secretish(name) || !BRANCH_KINDS[row.kind]) return null;
    return { name: name, kind: row.kind, merged: row.merged === true };
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
    var branches = take(raw.branches, CAPS.branches).map(cleanBranch).filter(Boolean);
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
      branches: branches,
      stats: {
        rows_sampled: count(statsIn.rows_sampled) || (agents.length + work.length + edges.length + ci.length),
        dispatch_open: count(statsIn.dispatch_open),
        result_1h: count(statsIn.result_1h),
        nogo_1h: count(statsIn.nogo_1h),
        median_ack_min: medianOut,
        deploy_lead_min: metric(statsIn.deploy_lead_min, 0, 10080),
        success_7d_pct: metric(statsIn.success_7d_pct, 0, 100),
        error_rate_pct: metric(statsIn.error_rate_pct, 0, 100)
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
    var poll = snap && snap.refresh_sec ? snap.refresh_sec : 120;
    return "Snapshot baked every " + n + " minutes. This page polls that file every " + poll + "s — not a live bus.";
  }

  function icon(name) {
    var paths = {
      code: '<path d="M8 9l-4 3 4 3M16 9l4 3-4 3"/>',
      bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11c.4.6.8 1.3.9 2h4.2c.1-.7.5-1.4.9-2A6 6 0 0 0 12 3z"/>',
      eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
      shield: '<path d="M12 3l7 3v6c0 4.2-2.8 7.2-7 8.8C7.8 19.2 5 16.2 5 12V6l7-3z"/>',
      target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
      nodes: '<circle cx="7" cy="8" r="2"/><circle cx="17" cy="8" r="2"/><circle cx="12" cy="16" r="2"/><path d="M8.7 9.2l2.2 5M15.3 9.2l-2.2 5"/>',
      headset: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M4 13v5a2 2 0 0 0 2 2h1v-7H6a2 2 0 0 0-2 2zM20 13v5a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z"/>',
      cloud: '<path d="M7 18h10a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.6 1.6A3.4 3.4 0 0 0 7 18z"/>',
      globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.4 3.4 5.2 3.4 8s-1.2 5.6-3.4 8c-2.2-2.4-3.4-5.2-3.4-8s1.2-5.6 3.4-8z"/>',
      chat: '<path d="M6 17l-2 4 4.2-2H17a4 4 0 0 0 4-4V8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v7a2 2 0 0 0 2 2z"/>',
      branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 12h8"/>',
      lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
      clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/>',
      trend: '<path d="M4 16l5-5 3 3 8-8"/><path d="M14 6h6v6"/>',
      warn: '<path d="M12 4l8 14H4L12 4z"/><path d="M12 10v3.5M12 16.5h.01"/>',
      pulse: '<path d="M3 12h4l2.2-5 3.6 10L15 12h6"/>',
      flask: '<path d="M9 3h6M10 3v5.5L5.2 19a2.6 2.6 0 0 0 2.3 3.8h9a2.6 2.6 0 0 0 2.3-3.8L14 8.5V3"/>',
      cube: '<path d="M12 3l8 4.2v8.2L12 20l-8-4.6V7.2L12 3z"/><path d="M12 11.2l8-4.2M12 11.2v8.6M12 11.2L4 7"/>',
      check: '<path d="M5 12.5l4.2 4.2L19 7.5"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || "") + "</svg>";
  }

  function agentById(snap) {
    var map = {};
    var list = (snap && snap.agents) || [];
    for (var i = 0; i < list.length; i++) map[list[i].id] = list[i];
    return map;
  }

  function envById(snap, id) {
    var list = (snap && snap.envs) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function firstPr(snap) {
    var work = (snap && snap.open_work) || [];
    for (var i = 0; i < work.length; i++) {
      if (work[i].pr) return work[i].pr;
    }
    return null;
  }

  function measure(value, suffix, places) {
    if (value == null) return "—";
    var text = (places && value % 1) ? Number(value).toFixed(places) : String(value);
    return esc(text) + suffix;
  }

  function statCard(kind, name, value, ico) {
    return '<div class="stat ' + kind + '"><span>' + esc(name) + "</span><strong>" + value + '</strong><i class="stat-ico" aria-hidden="true">' + icon(ico) + "</i></div>";
  }

  function stripHtml(snap, now) {
    var stats = snap.stats || {};
    var source = snap.source === "sample" ? "Sample" : "Baked";
    return "" +
      statCard("lead", "Deploy lead", measure(stats.deploy_lead_min, "m"), "clock") +
      statCard("ok", "7d success", measure(stats.success_7d_pct, "%"), "trend") +
      statCard("bad", "Error rate", measure(stats.error_rate_pct, "%", 1), "warn") +
      statCard("ack", "Median ack", measure(stats.median_ack_min, "m"), "pulse") +
      '<p class="source-pill ' + esc(snap.source) + '">' + source + " · " + esc(ageLabel(snap.baked_at, now)) + " · polls every " + snap.refresh_sec + "s</p>";
  }

  function sideNode(ico, text) {
    return '<div class="side-node"><span class="side-ico">' + icon(ico) + "</span><span>" + text + "</span></div>";
  }

  function agentCard(role, agent) {
    var status = agent ? agent.status : "missing";
    return '<article class="agent is-' + esc(status) + '"><i class="status-pip" aria-hidden="true"></i><span class="agent-ico">' + icon(role.icon) + "</span><b>" + esc(role.name) + "</b><span>" + esc(role.role) + "</span></article>";
  }

  function healthOf(snap) {
    var ci = snap.ci || [];
    var siteFail = false;
    var anyFail = false;
    for (var i = 0; i < ci.length; i++) {
      if (ci[i].conclusion === "failure") {
        anyFail = true;
        if (ci[i].repo === "sfdc24-site") siteFail = true;
      }
    }
    var agents = snap.agents || [];
    var alive = false;
    for (var a = 0; a < agents.length; a++) {
      if (agents[a].status === "hot" || agents[a].status === "warm") alive = true;
    }
    var err = snap.stats && snap.stats.error_rate_pct;
    var nogo = snap.stats && snap.stats.nogo_1h;
    var delivery = (anyFail || (typeof err === "number" && err >= 1) || nogo > 0) ? "at-risk" : "healthy";
    return {
      pipeline: !ci.length ? "unknown" : (siteFail ? "at-risk" : "healthy"),
      agents: !agents.length ? "unknown" : (alive ? "healthy" : "at-risk"),
      bus: "healthy",
      delivery: delivery
    };
  }

  function meter(name, state) {
    var word = state === "at-risk" ? "At risk" : (state === "healthy" ? "Healthy" : "Unknown");
    var cls = state === "at-risk" ? "risk" : (state === "healthy" ? "healthy" : "unknown");
    return '<div class="meter"><span>' + esc(name) + '</span><i class="bar ' + cls + '"></i><b class="' + cls + '">' + word + "</b></div>";
  }

  function healthInner(snap) {
    if (!snap) return '<h2>Delivery health</h2><p class="empty">Snapshot unavailable.</p>';
    var h = healthOf(snap);
    return "<h2>Delivery health</h2>" +
      meter("Pipeline", h.pipeline) +
      meter("Agents", h.agents) +
      meter("Bus", h.bus) +
      meter("Delivery", h.delivery);
  }

  function stageCard(kind, title, hint, badge, cls) {
    return '<article class="stage ' + kind + cls + '"><b>' + title + "</b><span>" + hint + "</span><em>" + esc(badge) + "</em></article>";
  }

  function rail(moving, delay) {
    var cls = "rail " + (moving ? "is-moving" : "is-held") + (delay && moving ? " delay" : "");
    return '<div class="' + cls + '" aria-hidden="true"><span class="track"><i></i><b class="runner"></b></span></div>';
  }

  function pipelineHtml(snap) {
    if (!snap) {
      return stageCard("dev", "DEV", "branch / PR", "—", "") +
        rail(false, false) +
        stageCard("staging", "Staging", "preview gate", "—", "") +
        rail(false, true) +
        stageCard("prod", "Production", "www", "www.sfdc24.com", "");
    }
    var pr = firstPr(snap);
    var prBadge = pr ? "PR #" + pr : "branch/PR";
    var pages = envById(snap, "pages");
    var staging = "Preview ready";
    if (pages && pages.health === "degraded") staging = "Gate blocked";
    else if (pages && pages.health === "unknown") staging = "Gate unknown";
    else if (!pages) staging = "Preview gate";
    var www = envById(snap, "www");
    var prod = www && www.label ? www.label : "www.sfdc24.com";
    if (snap.envs && snap.envs[0] && snap.envs[0].label && (!www || snap.envs[0] === www)) prod = snap.envs[0].label;
    var devCls = pr ? " is-live" : "";
    var stageCls = pages && pages.health ? " is-" + pages.health : "";
    var prodCls = www && www.health ? " is-" + www.health : "";
    var towardStaging = !!(pr || (pages && pages.health !== "degraded"));
    var towardProd = !!(pages && pages.health === "ok" && (!www || www.health === "ok"));
    return stageCard("dev", "DEV", "branch / PR", prBadge, devCls) +
      rail(towardStaging, false) +
      stageCard("staging", "Staging", "preview gate", staging, stageCls) +
      rail(towardProd, true) +
      stageCard("prod", "Production", "www", prod, prodCls);
  }

  function engineHtml(snap) {
    var known = agentById(snap);
    var cards = [];
    for (var i = 0; i < ROLES.length; i++) cards.push(agentCard(ROLES[i], known[ROLES[i].id]));
    return '' +
      '<div class="orch" role="img" aria-label="Communication and Control BUS and specialized agents">' +
      '<div class="orch-left">' +
      sideNode("headset", "Headless<br>360") +
      sideNode("cloud", "Salesforce<br>DEV org") +
      "</div>" +
      '<div class="orch-center">' +
      '<div class="bus"><span class="bus-ico">' + icon("nodes") + "</span><span>Communication &amp; Control BUS</span></div>" +
      '<div class="bus-drop" aria-hidden="true"></div>' +
      '<div class="agents">' + cards.join("") + "</div>" +
      "</div>" +
      '<div class="orch-right">' +
      sideNode("globe", "Site") +
      sideNode("chat", "Messaging") +
      "</div></div>";
  }

  function branchGraph(branches) {
    var rows = (branches || []).slice(0, 4);
    if (!rows.length) return '<p class="empty">No branch rows in this snap.</p>';
    var n = rows.length;
    var gap = 52;
    var top = 22;
    var mainY = top + n * gap + 8;
    var vbW = 680;
    var vbH = mainY + 40;
    var colors = { feature: "#0A66C2", fix: "#0A66C2", chore: "#6D28D9" };
    var parts = ['<svg class="graph-svg" viewBox="0 0 ' + vbW + " " + vbH + '" role="img" aria-label="Feature, fix, and chore branches merging into main">'];
    parts.push('<line x1="16" y1="' + mainY + '" x2="' + (vbW - 8) + '" y2="' + mainY + '" class="spine-line"/>');
    parts.push('<circle cx="16" cy="' + mainY + '" r="5.5" class="spine-dot"/>');
    parts.push('<text x="2" y="' + (mainY + 18) + '" class="spine-label">main</text>');
    for (var i = 0; i < n; i++) {
      var row = rows[i];
      var y = top + i * gap;
      var color = colors[row.kind] || "#0A66C2";
      var dash = row.kind === "chore" ? ' stroke-dasharray="6 5"' : "";
      var label = row.name;
      var pillW = Math.max(128, Math.min(196, 24 + label.length * 6.5));
      var merge = Math.round(240 + (n === 1 ? 80 : i * ((vbW - 300) / (n - 1))));
      var pillX = 28 + i * 92;
      if (pillX + pillW + 28 > merge) pillX = Math.max(16, merge - pillW - 40);
      var lineStart = pillX + pillW + 6;
      var lineEnd = merge - 8;
      parts.push('<rect x="' + pillX + '" y="' + (y - 13) + '" width="' + pillW + '" height="26" rx="13" fill="#ffffff" stroke="' + color + '" stroke-width="1.4"/>');
      parts.push('<text x="' + (pillX + 12) + '" y="' + (y + 4) + '" fill="' + color + '" class="pill-text">' + esc(label) + "</text>");
      var pathD;
      if (lineEnd > lineStart + 6) {
        parts.push('<line x1="' + lineStart + '" y1="' + y + '" x2="' + lineEnd + '" y2="' + y + '" stroke="' + color + '" stroke-width="2.2"' + dash + "/>");
        parts.push('<circle cx="' + (lineStart + 10) + '" cy="' + y + '" r="4.5" fill="' + color + '"/>');
        pathD = "M" + lineStart + " " + y + " L" + lineEnd + " " + y + " C" + (merge + 12) + " " + y + "," + merge + " " + (mainY - 40) + "," + merge + " " + (mainY - 12);
      } else {
        pathD = "M" + merge + " " + y + " C" + (merge + 12) + " " + y + "," + merge + " " + (mainY - 40) + "," + merge + " " + (mainY - 12);
      }
      parts.push('<path d="M' + Math.max(lineStart, lineEnd) + " " + y + " C " + (merge + 12) + " " + y + ", " + merge + " " + (mainY - 40) + ", " + merge + " " + (mainY - 12) + '" fill="none" stroke="' + color + '" stroke-width="2.2"' + dash + "/>");
      parts.push('<circle class="branch-runner" r="5" cx="' + lineStart + '" cy="' + y + '" fill="' + color + '" style="offset-path:path(\'' + pathD + '\');animation-delay:-' + (i * 0.7) + 's"/>');
      if (row.merged) {
        parts.push('<circle cx="' + merge + '" cy="' + mainY + '" r="11" fill="#057642"/>');
        parts.push('<path d="M' + (merge - 5) + " " + (mainY + 1) + " l3.2 3.2 6.4-6.6" + '" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
        var tagX = Math.max(lineStart, lineEnd - 54);
        parts.push('<text x="' + tagX + '" y="' + (y + 16) + '" class="merged-text" fill="' + color + '">merged</text>');
      } else {
        parts.push('<circle cx="' + merge + '" cy="' + mainY + '" r="7" fill="#ffffff" stroke="#191919" stroke-width="2"/>');
      }
    }
    parts.push("</svg>");
    return parts.join("");
  }

  function callouts() {
    return '' +
      '<article class="callout"><span class="callout-ico">' + icon("branch") + '</span><div><h3>Exact-SHA review</h3><p>Review the exact merge commit SHA on the merge node.</p></div></article>' +
      '<article class="callout"><span class="callout-ico">' + icon("cloud") + '</span><div><h3>Staging preview</h3><p>After merge to staging ref, share a preview for validation.</p></div></article>' +
      '<article class="callout"><span class="callout-ico">' + icon("shield") + '</span><div><h3>Promote to production only after gate</h3><p>Gate must pass before promoting to production.</p></div></article>';
  }

  function miniLane() {
    return '' +
      '<div class="mini-lane" aria-hidden="true">' +
      '<span class="chip">' + icon("code") + " DEV</span><span class=\"mini-arrow\">→</span>" +
      '<span class="chip">' + icon("flask") + " STAGING</span><span class=\"mini-arrow\">→</span>" +
      '<span class="chip">' + icon("cube") + " PRODUCTION</span><span class=\"mini-arrow\">→</span>" +
      '<span class="chip prod">' + icon("globe") + "<span>Production<small>www</small></span></span>" +
      "</div>";
  }

  function listsHtml(snap) {
    var branches = (snap && snap.branches) || [];
    return '' +
      '<section class="flow" aria-label="Branch flow">' +
      "<h2>Branch flow</h2>" +
      '<div class="flow-grid"><div class="graph">' + branchGraph(branches) + miniLane() + "</div>" +
      '<div class="callouts">' + callouts() + "</div></div></section>";
  }

  function emptyPaint() {
    return {
      strip: '<p class="empty">Snapshot unavailable.</p>',
      pipeline: pipelineHtml(null),
      engine: '<div class="orch dim" role="img" aria-label="Snapshot unavailable"><p class="block-title">SNAPSHOT UNAVAILABLE</p></div>',
      lists: listsHtml(null),
      side: healthInner(null),
      note: noteText(null)
    };
  }

  function paint(snap, now) {
    if (!snap) return emptyPaint();
    return {
      strip: stripHtml(snap, now || Date.parse(snap.baked_at)),
      pipeline: pipelineHtml(snap),
      engine: engineHtml(snap),
      lists: listsHtml(snap),
      side: healthInner(snap),
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
    var release = doc.getElementById("release-mount");
    var engine = doc.getElementById("engine");
    var lists = doc.getElementById("engine-lists");
    var side = doc.getElementById("delivery-health");
    var note = doc.getElementById("engine-note");
    if (!engine) return;
    var had = false;
    var timer = null;
    var lastSig = "";

    function render(view, sig) {
      var changed = !!(sig && lastSig && sig !== lastSig);
      if (sig) lastSig = sig;
      if (strip) {
        strip.classList.remove("is-fresh");
        strip.innerHTML = view.strip;
        if (changed) {
          void strip.offsetWidth;
          strip.classList.add("is-fresh");
        }
      }
      if (release) release.innerHTML = view.pipeline || "";
      engine.innerHTML = view.engine;
      if (lists) lists.innerHTML = view.lists;
      if (side) side.innerHTML = view.side || "";
      if (note) note.textContent = view.note;
    }

    function sigOf(snap) {
      if (!snap) return "";
      var stats = snap.stats || {};
      var agents = (snap.agents || []).map(function (row) { return row.id + ":" + row.status; }).join(",");
      var branches = (snap.branches || []).map(function (row) { return row.name + (row.merged ? "=1" : "=0"); }).join(",");
      var envs = (snap.envs || []).map(function (row) { return row.id + ":" + row.health; }).join(",");
      return [snap.baked_at, snap.source, stats.deploy_lead_min, stats.success_7d_pct, stats.error_rate_pct, stats.median_ack_min, agents, branches, envs].join("|");
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
        if (decision.empty) render(emptyPaint(), "");
        else if (decision.snap) render(paint(decision.snap, Date.now()), sigOf(decision.snap));
        schedule(decision.snap ? decision.snap.refresh_sec : 120);
      }).catch(function () {
        if (!had) render(emptyPaint());
        schedule(120);
      });
    }

    try { tick(); } catch (err) { render(emptyPaint()); }
  }
});
