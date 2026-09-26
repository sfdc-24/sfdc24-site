/* /ops/ functional-build storyboard. Reads a baked JSON file. Never calls a bus.
 *
 * Entries are date + title + caption + optional illustration. `grain` is
 * "week" or "month". Grouping lives here, so a later bake can summarize to
 * months without a page change.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) api.boot(root);
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SAME = "/data/ops-storyboard.json";
  var GRAINS = { week: 1, month: 1 };
  var ARTS = { clock: 1, intake: 1, site: 1, voice: 1, honesty: 1, bus: 1, gate: 1, fleet: 1 };
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  var TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9 .,'’+\-—]{0,179}$/;
  var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  var RETIRED_RE = /foundry|azure/i;
  var BUS_RE = new RegExp(["script" + ".google", "spread" + "sheets", "/" + "macros/", "alpha" + "-db"].join("|"), "i");
  var SECRET_VALUE_RE = new RegExp(
    ["gh" + "p_", "github_" + "pat_", "gho" + "_", "glpat-", "xox[baprs]-", "sk-", "ya29\\.", "AKIA[0-9A-Z]{16}", "-----BEGIN "].join("|"),
    "i"
  );
  var FORBIDDEN = {
    email: 1, "e-mail": 1, mail: 1, token: 1, access_token: 1, refresh_token: 1, id_token: 1,
    secret: 1, password: 1, passwd: 1, credential: 1, credentials: 1, api_key: 1, apikey: 1,
    authorization: 1, auth: 1, transcript: 1, payload: 1, raw: 1, body: 1, cookie: 1,
    cookies: 1, session: 1, private_key: 1, bearer: 1, sha: 1, url: 1
  };
  var CAP = 36;
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var SCENES = {
    clock: '<circle cx="80" cy="46" r="22"/><path d="M80 46 V30 M80 46 L94 54"/>',
    intake: '<rect x="46" y="28" width="68" height="40" rx="4"/><path d="M46 36 L80 54 L114 36"/>',
    site: '<rect x="38" y="20" width="84" height="52" rx="4"/><path d="M38 34 H122"/><circle cx="46" cy="27" r="2" fill="currentColor" stroke="none"/>',
    voice: '<path d="M58 28 h40 a8 8 0 0 1 8 8 v14 a8 8 0 0 1-8 8 H70 l-12 10 v-10 H58 a8 8 0 0 1-8-8 V36 a8 8 0 0 1 8-8z"/>',
    honesty: '<rect x="50" y="16" width="60" height="58" rx="4"/><path d="M66 46 l8 8 18-20"/>',
    bus: '<circle cx="46" cy="48" r="8"/><circle cx="80" cy="28" r="8"/><circle cx="114" cy="48" r="8"/><path d="M54 44 L74 32 M86 32 L106 44"/>',
    gate: '<path d="M48 62 V28 h64 v34"/><path d="M80 40 v10"/><circle cx="80" cy="36" r="3"/>',
    fleet: '<circle cx="58" cy="40" r="10"/><circle cx="80" cy="52" r="10"/><circle cx="102" cy="40" r="10"/>',
    mark: '<circle cx="80" cy="46" r="6"/>'
  };

  function forbiddenKey(key) {
    if (typeof key !== "string") return true;
    var norm = key.replace(/-/g, "_").toLowerCase();
    return !!FORBIDDEN[norm] || /_token$/.test(norm) || /_secret$/.test(norm);
  }

  function secretish(value) {
    return typeof value === "string" && (EMAIL_RE.test(value) || SECRET_VALUE_RE.test(value) || BUS_RE.test(value));
  }

  function text(value, limit) {
    if (typeof value !== "string") return null;
    var clean = value.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > limit || !TEXT_RE.test(clean) || secretish(clean) || RETIRED_RE.test(clean)) return null;
    return clean;
  }

  function cleanEntry(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    var src = {};
    for (var key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key) && !forbiddenKey(key)) src[key] = row[key];
    }
    if (typeof src.date !== "string" || !DATE_RE.test(src.date)) return null;
    var parts = src.date.split("-");
    var probe = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    if (probe.getUTCFullYear() !== +parts[0] || probe.getUTCMonth() !== +parts[1] - 1 || probe.getUTCDate() !== +parts[2]) return null;
    var title = text(src.title, 72);
    var caption = text(src.caption, 180);
    if (!title || !caption) return null;
    var out = { date: src.date, title: title, caption: caption };
    if (ARTS[src.illustration]) out.illustration = src.illustration;
    return out;
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return null;
    if (typeof raw.baked_at !== "string" || !TS_RE.test(raw.baked_at)) return null;
    var grain = GRAINS[raw.grain] ? raw.grain : "week";
    var source = raw.source === "sample" || raw.source === "bake" ? raw.source : "bake";
    var rows = Array.isArray(raw.entries) ? raw.entries : [];
    var entries = [];
    var seen = {};
    for (var i = 0; i < rows.length && entries.length < CAP; i++) {
      var clean = cleanEntry(rows[i]);
      if (!clean) continue;
      var key = clean.date + "\n" + clean.title;
      if (seen[key]) continue;
      seen[key] = 1;
      entries.push(clean);
    }
    entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return { v: 1, grain: grain, baked_at: raw.baked_at, source: source, entries: entries };
  }

  function utcDate(iso) {
    var p = iso.split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  function groupKey(iso, grain) {
    if (grain === "month") return iso.slice(0, 7);
    var d = utcDate(iso);
    var day = d.getUTCDay() || 7;
    var thursday = new Date(d.getTime());
    thursday.setUTCDate(d.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    var week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
    var y = thursday.getUTCFullYear();
    var w = week < 10 ? "0" + week : String(week);
    return y + "-W" + w;
  }

  function groupLabel(iso, grain) {
    var d = utcDate(iso);
    if (grain === "month") return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
    var day = d.getUTCDay() || 7;
    var monday = new Date(d.getTime());
    monday.setUTCDate(d.getUTCDate() - (day - 1));
    return "Week of " + monday.getUTCDate() + " " + MONTHS_SHORT[monday.getUTCMonth()];
  }

  function groupEntries(entries, grain) {
    var use = grain === "month" ? "month" : "week";
    var groups = [];
    var index = {};
    for (var i = 0; i < entries.length; i++) {
      var row = entries[i];
      var key = groupKey(row.date, use);
      if (!index[key]) {
        index[key] = { key: key, label: groupLabel(row.date, use), entries: [] };
        groups.push(index[key]);
      }
      index[key].entries.push(row);
    }
    return groups;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function frameDate(iso) {
    var d = utcDate(iso);
    return d.getUTCDate() + " " + MONTHS_SHORT[d.getUTCMonth()];
  }

  function frameSvg(key) {
    var scene = SCENES[key] || SCENES.mark;
    return '<svg viewBox="0 0 160 90" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + scene + "</svg>";
  }

  function paint(snap) {
    if (!snap || !snap.entries || !snap.entries.length) {
      return '<p class="empty">No frames in this storyboard.</p>';
    }
    var grain = snap.grain === "month" ? "month" : "week";
    var groups = groupEntries(snap.entries, grain);
    var html = '<p class="story-meta">' + (grain === "month" ? "Grouped by month" : "Grouped by week") + "</p>";
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      html += '<section class="story-week"><h3>' + esc(group.label) + "</h3>";
      for (var i = 0; i < group.entries.length; i++) {
        var row = group.entries[i];
        html += '<article class="story-frame">' +
          '<div class="frame-art">' + frameSvg(row.illustration) + "</div>" +
          "<div><p class=\"story-kicker\">" + esc(frameDate(row.date)) + "</p>" +
          "<h4>" + esc(row.title) + "</h4>" +
          "<p>" + esc(row.caption) + "</p></div></article>";
      }
      html += "</section>";
    }
    return html;
  }

  function emptyPaint() {
    return '<p class="empty">Storyboard unavailable.</p>';
  }

  return {
    sanitize: sanitize,
    groupEntries: groupEntries,
    groupKey: groupKey,
    paint: paint,
    emptyPaint: emptyPaint,
    esc: esc,
    SAME: SAME,
    boot: boot
  };

  function boot(win) {
    var host = win.document.getElementById("ops-story-mount");
    if (!host) return;

    function show(html) {
      host.innerHTML = html;
    }

    function load() {
      return win.fetch(SAME + "?t=" + Math.floor(Date.now() / 86400000), { cache: "no-store", credentials: "omit" })
        .then(function (res) {
          if (!res.ok) throw new Error("status");
          return res.json();
        })
        .then(function (raw) {
          var snap = sanitize(raw);
          show(snap ? paint(snap) : emptyPaint());
        })
        .catch(function () {
          show(emptyPaint());
        });
    }

    try { load(); } catch (err) { show(emptyPaint()); }
  }
});
