/* Header release milestones. Pure selector plus the words the header may say.
 * data/release-milestones.json is the only source. Time running out does not
 * pass a milestone; only the refresh script can set status to "passed", and
 * only from an annotated tag or GitHub release named milestone/<id>-passed.
 * A ticking clock is aria-hidden. The polite live region changes only when
 * the phase changes (label, releasing, or the next milestone).
 */
(function (root) {
  "use strict";

  function listOf(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
    return Array.isArray(doc.milestones) ? doc.milestones : [];
  }

  function selectCurrent(doc) {
    var rows = listOf(doc);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== "object") continue;
      if (row.status !== "passed") return row;
    }
    return null;
  }

  function shortLabel(value) {
    var words = String(value == null ? "" : value).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) return "";
    if (words.length > 6) words = words.slice(0, 6);
    return words.join(" ");
  }

  function parseAt(value) {
    if (typeof value !== "string" || !value.trim()) return NaN;
    var t = Date.parse(value.trim());
    return isFinite(t) ? t : NaN;
  }

  /* nowMs is the clock the caller trusts. Missing or null "at" is label only. */
  function displayState(milestone, nowMs) {
    if (!milestone) {
      return { mode: "none", label: "No release scheduled", announce: "No release scheduled", showCount: false };
    }
    var label = shortLabel(milestone.label) || shortLabel(milestone.id) || "Next release";
    var at = parseAt(milestone.at);
    if (!isFinite(at)) {
      return { mode: "label", label: label, announce: label, showCount: false };
    }
    var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
    if (now >= at) {
      return { mode: "releasing", label: "Releasing now", announce: "Releasing now", showCount: false, at: milestone.at };
    }
    return {
      mode: "countdown",
      label: label,
      announce: label,
      showCount: true,
      remainingMs: at - now,
      at: milestone.at
    };
  }

  function formatRemaining(ms) {
    var left = Number(ms);
    if (!isFinite(left) || left < 0) left = 0;
    var s = Math.floor(left / 1000);
    var d = Math.floor(s / 86400);
    s -= d * 86400;
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  var api = {
    selectCurrent: selectCurrent,
    displayState: displayState,
    formatRemaining: formatRemaining
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SFDC24ReleaseMilestones = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
