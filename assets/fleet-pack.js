/* Optional fleet pack. Nothing here is invented.
 * data/fleet-pack/manifest.json, milestones.json, and totals.json are read
 * when present. The source field is never returned (it names internal
 * threads). board_rows_by_phase and per-agent board-row counts are dropped.
 * A missing file is unavailable, not a zero.
 */
(function (root) {
  "use strict";
  var MILESTONES_URL = "/data/fleet-pack/milestones.json";
  var TOTALS_URL = "/data/fleet-pack/totals.json";
  var MANIFEST_URL = "/data/fleet-pack/manifest.json";

  function strip(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(strip);
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (key === "source" || key === "board_rows_by_phase" || key === "board_rows_by_agent") return;
      if (/board_row/i.test(key)) return;
      out[key] = strip(value[key]);
    });
    return out;
  }

  function loadUrl(url, fetchFn) {
    var fetchImpl = fetchFn || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) return Promise.resolve({ available: false, reason: "unavailable" });
    return fetchImpl(url, { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res || !res.ok) return { available: false, reason: "unavailable" };
      return res.json().then(function (body) {
        if (!body || typeof body !== "object") return { available: false, reason: "unavailable" };
        return { available: true, body: strip(body) };
      });
    }).catch(function () {
      return { available: false, reason: "unavailable" };
    });
  }

  function load(fetchFn) { return loadUrl(MANIFEST_URL, fetchFn); }
  function loadMilestones(fetchFn) { return loadUrl(MILESTONES_URL, fetchFn); }
  function loadTotals(fetchFn) { return loadUrl(TOTALS_URL, fetchFn); }

  var api = {
    url: MANIFEST_URL,
    milestonesUrl: MILESTONES_URL,
    totalsUrl: TOTALS_URL,
    strip: strip,
    load: load,
    loadMilestones: loadMilestones,
    loadTotals: loadTotals
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SFDC24FleetPack = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
