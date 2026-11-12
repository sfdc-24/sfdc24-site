/* Homepage header release line.
 * Reads /data/release-milestones.json at load and again each minute.
 * Shows the first milestone that is not passed: a few words, plus a countdown
 * when "at" is set. No date means the words only. At the instant, the line
 * says "Releasing now" and does not mark the milestone passed.
 * The ticking digits are aria-hidden. aria-live="polite" updates only when
 * the phase changes.
 */
(function () {
  "use strict";
  var CONFIG_URL = "/data/release-milestones.json";
  var loading = false;
  var doc = null;
  var announced = "";

  function logic() {
    return window.SFDC24ReleaseMilestones || null;
  }

  function slot() {
    var el = document.querySelector("header .header-calendar");
    if (!el) return null;
    el.setAttribute("data-release-clock", "1");
    el.classList.add("is-release");
    el.title = "Next site release";
    return el;
  }

  function fail(el) {
    el.dateTime = "";
    el.removeAttribute("datetime");
    while (el.firstChild) el.removeChild(el.firstChild);
    el.textContent = "Release record did not load.";
    announced = "";
  }

  function ensure(el) {
    var line = el.querySelector(".rel-milestone");
    var live = el.querySelector(".rel-live");
    if (line && live) return { line: line, live: live };
    while (el.firstChild) el.removeChild(el.firstChild);
    line = document.createElement("span");
    line.className = "rel-milestone";
    var label = document.createElement("span");
    label.className = "rel-label";
    var count = document.createElement("span");
    count.className = "rel-count";
    count.setAttribute("aria-hidden", "true");
    line.appendChild(label);
    line.appendChild(count);
    live = document.createElement("span");
    live.className = "rel-live";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    el.appendChild(line);
    el.appendChild(live);
    return { line: line, live: live };
  }

  function paint(el) {
    var api = logic();
    if (!api || !doc) return fail(el);
    var state = api.displayState(api.selectCurrent(doc), Date.now());
    var parts = ensure(el);
    var label = parts.line.querySelector(".rel-label");
    var count = parts.line.querySelector(".rel-count");
    label.textContent = state.label;
    if (state.showCount) {
      count.hidden = false;
      count.textContent = api.formatRemaining(state.remainingMs);
    } else {
      count.hidden = true;
      count.textContent = "";
    }
    if (state.at) el.setAttribute("datetime", String(state.at).trim());
    else el.removeAttribute("datetime");
    if (state.announce !== announced) {
      announced = state.announce;
      parts.live.textContent = state.announce;
    }
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
      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.milestones)) {
        if (!doc) fail(el);
        return;
      }
      doc = data;
      paint(el);
    }).catch(function () {
      if (!doc) fail(el);
    }).then(function () {
      loading = false;
    });
  }

  function boot() {
    if (window.__SFDC24_MILESTONE_CLOCK) return;
    window.__SFDC24_MILESTONE_CLOCK = 1;
    refresh();
    setInterval(function () {
      var el = slot();
      if (el && doc) paint(el);
    }, 1000);
    setInterval(refresh, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
