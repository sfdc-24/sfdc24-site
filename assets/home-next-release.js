/* Homepage "Next release" block.
 * The time comes from /data/next-release.json ("at", an ISO time or null),
 * the file the header clock and /ops/ use. The header clock (next-deploy.js)
 * reads it and shares the value through the "sfdc24:next-release" event, so
 * the page reads the file once and the two clocks always agree.
 * No time in the data, or a time already passed, means no countdown: the block
 * keeps "Next release: being scheduled". Never invent or guess a date here.
 */
(function () {
  "use strict";
  var TZ = "America/Toronto";
  var timer = null;
  var shown = null;

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

  function render(at) {
    var when = document.getElementById("nr-when");
    var box = document.getElementById("nr-count");
    if (!when || !box) return;
    var t = Date.parse(at || "");
    if (!isFinite(t)) t = NaN;
    if (t === shown || (isNaN(t) && isNaN(shown) && shown !== null)) return;
    shown = t;
    if (timer) { clearInterval(timer); timer = null; }
    if (isNaN(t) || t <= Date.now()) {
      box.hidden = true;
      when.textContent = "Next release: being scheduled";
      return;
    }
    when.textContent = "Next release: " + label(t);
    var u = {};
    ["d", "h", "m", "s"].forEach(function (k) {
      u[k] = box.querySelector('[data-unit="' + k + '"]');
    });
    box.hidden = false;
    function tick() {
      var left = Math.floor((t - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer); timer = null;
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

  document.addEventListener("sfdc24:next-release", function (e) {
    render(e && e.detail ? e.detail.at : "");
  });
  function boot() {
    if (typeof window.__SFDC24_NEXT_RELEASE_AT === "string") render(window.__SFDC24_NEXT_RELEASE_AT);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
