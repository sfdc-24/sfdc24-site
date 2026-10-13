/* Visual storybook for /history/ — reads data/history-timeline.json. */
(function () {
  "use strict";
  var host = document.getElementById("history-mount");
  if (!host) return;

  function partsFor(iso) {
    var when = "";
    var dayLabel = "";
    var parts = {};
    try {
      if (window.SFDC24LocalTime) when = window.SFDC24LocalTime.formatWhen(iso);
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZoneName: "short"
      }).formatToParts(new Date(iso)).forEach(function (p) { parts[p.type] = p.value; });
      dayLabel = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZoneName: "short"
      }).format(new Date(iso)).replace(/\u202f|\u00a0/g, " ");
      if (!when) when = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
        timeZone: "UTC"
      }).format(new Date(iso)).replace(/\u202f|\u00a0/g, " ");
    } catch (e) {
      var d = new Date(iso);
      parts.year = String(d.getUTCFullYear());
      parts.month = String(d.getUTCMonth() + 1);
      parts.day = String(d.getUTCDate());
      when = d.toISOString().replace(".000Z", "Z") + " UTC";
      dayLabel = when;
    }
    return {
      dayKey: (parts.year || "") + "-" + (parts.month || "") + "-" + (parts.day || ""),
      dayLabel: dayLabel,
      clock: when
    };
  }

  function render(data) {
    var events = (data && data.events) || [];
    var groups = [];
    var map = {};
    events.forEach(function (ev) {
      var p = partsFor(ev.ts);
      if (!map[p.dayKey]) {
        map[p.dayKey] = { key: p.dayKey, label: p.dayLabel, items: [] };
        groups.push(map[p.dayKey]);
      }
      map[p.dayKey].items.push({ ev: ev, clock: p.clock });
    });

    host.innerHTML = "";
    var meta = document.createElement("p");
    meta.className = "hist-meta";
    /* "commits" was wrong the moment the timeline stopped being only commits. */
    var offsite = 0;
    events.forEach(function (e) { if (!e.sha) offsite++; });
    meta.textContent = (data.count || events.length) + " events since " + (data.since || "2026-08-25")
      + " · " + groups.length + " days"
      + (offsite ? " · " + offsite + " from before this repository existed, cited rather than linked" : "");
    host.appendChild(meta);

    groups.forEach(function (g) {
      var day = document.createElement("section");
      day.className = "hist-day";
      var h = document.createElement("h2");
      h.textContent = g.label.trim();
      day.appendChild(h);
      g.items.forEach(function (item) {
        /* Owner: retain Python-generated provenance, but History entries are
           readable text, never navigation into a repository or console. */
        var hasCommit = !!item.ev.sha;
        var row = document.createElement("div");
        row.className = "hist-row" + (hasCommit ? "" : " hist-offsite");
        var t = document.createElement("span");
        t.className = "hist-time";
        t.textContent = item.clock;
        var tag = document.createElement("code");
        tag.textContent = hasCommit ? item.ev.sha : (item.ev.source || "off-repo");
        var sub = document.createElement("span");
        sub.className = "hist-sub";
        sub.textContent = item.ev.subject || "";
        row.appendChild(t);
        row.appendChild(tag);
        row.appendChild(sub);
        day.appendChild(row);
      });
      host.appendChild(day);
    });
  }

  fetch("/data/history-timeline.json", { cache: "no-store" })
    .then(function (res) { if (!res.ok) throw new Error("missing timeline"); return res.json(); })
    .then(render)
    .catch(function () {
      host.innerHTML = "<p class=\"hist-meta\">Timeline data is not on this copy of the tree. The page still stands: started 25 Aug 2026. Times stay in UTC until script can read this browser's zone.</p>";
    });
})();
