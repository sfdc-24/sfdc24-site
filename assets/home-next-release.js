/* Homepage "Next release" block.
 * Reads the committed release time from /data/next-release.json ("at", an ISO
 * time or null). That is the same file the header clock and /ops/ use.
 * No time in the data, or a time already passed, means no countdown: the block
 * keeps "Next release: being scheduled". Never invent or guess a date here.
 */
(function () {
  "use strict";
  var URL = "/data/next-release.json";
  var TZ = "America/Toronto";

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function label(t) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: TZ, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(t)) + " ET";
    } catch (e) {
      return new Date(t).toISOString() + " UTC";
    }
  }

  function start(at) {
    var when = document.getElementById("nr-when");
    var box = document.getElementById("nr-count");
    if (!when || !box) return;
    var t = Date.parse(at);
    if (!isFinite(t) || t <= Date.now()) return;
    when.textContent = "Next release: " + label(t);
    var u = {};
    ["d", "h", "m", "s"].forEach(function (k) {
      u[k] = box.querySelector('[data-unit="' + k + '"]');
    });
    box.hidden = false;
    var timer;
    function tick() {
      var left = Math.floor((t - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        box.hidden = true;
        when.textContent = "Next release: time reached. Status is on the Ops page.";
        return;
      }
      u.d.textContent = String(Math.floor(left / 86400));
      u.h.textContent = pad(Math.floor(left % 86400 / 3600));
      u.m.textContent = pad(Math.floor(left % 3600 / 60));
      u.s.textContent = pad(left % 60);
    }
    tick();
    timer = setInterval(tick, 1000);
  }

  function load() {
    if (!window.fetch) return;
    fetch(URL, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && typeof data.at === "string" && data.at) start(data.at);
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
