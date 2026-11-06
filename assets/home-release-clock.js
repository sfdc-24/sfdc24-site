/* Homepage release clock. The SFDC mark stays the live America/Toronto clock.
 * This paints the other header clock (the date stamp) from /data/latest-release.json.
 * Do not type release facts into HTML.
 * After a site PR merges, set latest.pr, latest.title, latest.merged_at (UTC), and latest.sha.
 * To change what the next release lists, edit next.contains. One string per item, in order.
 */
(function () {
  "use strict";
  var CONFIG_URL = "/data/latest-release.json";
  var TZ = "America/Toronto";
  var REPO = "https://github.com/sfdc-24/sfdc24-site";
  var loading = false;
  var painted = "";

  function isHome() {
    var path = (location.pathname || "/").replace(/\/+$/, "") || "/";
    return path === "/" || path === "/index.html";
  }

  function pad(n) {
    n = String(n == null ? "" : n);
    return n.length >= 2 ? n : ("0" + n).slice(-2);
  }

  function formatReleased(iso) {
    var date = new Date(iso);
    if (!isFinite(date.getTime())) return "";
    var parts = {};
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short"
      }).formatToParts(date).forEach(function (p) {
        if (p.type !== "literal") parts[p.type] = p.value;
      });
    } catch (e) {
      return "";
    }
    if (!parts.month || !parts.day || !parts.year || parts.hour == null || parts.minute == null) return "";
    return parts.month + " " + parts.day + ", " + parts.year + ", " +
      pad(parts.hour) + ":" + pad(parts.minute) + " " + (parts.timeZoneName || "ET");
  }

  function cleanItem(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function prHref(latest) {
    if (!latest || latest.repo !== "sfdc24-site") return "";
    var pr = latest.pr;
    if (typeof pr !== "number" || !isFinite(pr) || pr <= 0 || Math.floor(pr) !== pr) return "";
    return REPO + "/pull/" + pr;
  }

  function slot() {
    var el = document.querySelector("header .header-calendar");
    if (!el) return null;
    el.setAttribute("data-release-clock", "1");
    el.classList.add("is-release");
    el.title = "Latest site release, America/Toronto";
    return el;
  }

  function fail(el) {
    el.dateTime = "";
    el.removeAttribute("datetime");
    while (el.firstChild) el.removeChild(el.firstChild);
    el.textContent = "Release record did not load.";
    painted = "";
  }

  function paint(el, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail(el);
    var latest = data.latest;
    var next = data.next;
    var when = latest && formatReleased(latest.merged_at);
    var title = latest && cleanItem(latest.title);
    var items = next && Array.isArray(next.contains) ? next.contains.map(cleanItem).filter(Boolean) : [];
    if (!when || !title || !items.length) return fail(el);
    if (data.timezone && data.timezone !== TZ) return fail(el);

    var signature = when + "\n" + title + "\n" + items.join("\n");
    if (signature === painted && el.querySelector(".rel-shipped")) return;
    painted = signature;

    while (el.firstChild) el.removeChild(el.firstChild);
    el.setAttribute("datetime", String(latest.merged_at).trim());

    var shipped = document.createElement("span");
    shipped.className = "rel-shipped";
    var href = prHref(latest);
    var whenEl = document.createElement(href ? "a" : "span");
    whenEl.className = "rel-when";
    whenEl.textContent = when;
    if (href) {
      whenEl.href = href;
      whenEl.target = "_blank";
      whenEl.rel = "noopener noreferrer";
      whenEl.setAttribute("aria-label", "Latest site release, " + when + ", pull request " + latest.pr);
    }
    var what = document.createElement("span");
    what.className = "rel-what";
    what.textContent = title;
    shipped.appendChild(document.createTextNode("Latest "));
    shipped.appendChild(whenEl);
    shipped.appendChild(document.createTextNode(" · "));
    shipped.appendChild(what);

    var coming = document.createElement("span");
    coming.className = "rel-next";
    coming.textContent = "Next: " + items.join(" · ");

    el.appendChild(shipped);
    el.appendChild(coming);
  }

  function refresh() {
    if (loading) return;
    var el = slot();
    if (!el) return;
    loading = true;
    fetch(CONFIG_URL, { cache: "no-store" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data) {
        if (!painted) fail(el);
        return;
      }
      paint(el, data);
    }).catch(function () {
      if (!painted) fail(el);
    }).then(function () {
      loading = false;
    });
  }

  function boot() {
    if (!isHome()) return;
    refresh();
    setInterval(refresh, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
