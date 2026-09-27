/* Visual storybook for /history/ — reads data/history-timeline.json. */
(function () {
  "use strict";
  var TZ = "America/Toronto";
  var host = document.getElementById("history-mount");
  if (!host) return;

  function pad(n) { n = Number(n); return (n < 10 ? "0" : "") + n; }
  function partsFor(iso) {
    var parts = {};
    try {
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(new Date(iso)).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) {
      var d = new Date(iso);
      parts.day = String(d.getDate());
      parts.month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      parts.year = String(d.getFullYear());
      parts.hour = String(d.getHours());
      parts.minute = String(d.getMinutes());
      parts.weekday = "";
    }
    return {
      dayKey: (parts.year || "") + "-" + (parts.month || "") + "-" + (parts.day || ""),
      dayLabel: (parts.weekday || "") + " " + (parts.day || "") + " " + (parts.month || "") + " " + (parts.year || ""),
      clock: pad(parts.hour) + ":" + pad(parts.minute)
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
      host.innerHTML = "<p class=\"hist-meta\">Timeline data is not on this copy of the tree. The page still stands: 24 hour clock, started 25 Aug 2026.</p>";
    });
})();
