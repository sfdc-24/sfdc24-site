/* Visitor-local instants. Data stays UTC. The short zone label comes from
   Intl (EDT, PDT, GMT+1). If Intl cannot format, the label is UTC. */
(function (root) {
  function formatWhen(value, timeZone) {
    var date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("release date is empty");
    var opts = {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    };
    if (timeZone) opts.timeZone = timeZone;
    try {
      return new Intl.DateTimeFormat("en-US", opts).format(date).replace(/\u202f|\u00a0/g, " ");
    } catch (err) {
      if (timeZone === "UTC") throw err;
      return formatWhen(date, "UTC");
    }
  }

  function formatUtc(value) {
    var text = formatWhen(value, "UTC");
    if (text.indexOf("UTC") < 0) throw new Error("release date is empty");
    return text;
  }

  function applyLocalTimes(doc) {
    var scope = doc || (typeof document !== "undefined" ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll("time[datetime]");
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute("datetime");
      if (!iso) continue;
      try { nodes[i].textContent = formatWhen(iso); } catch (err) {}
    }
  }

  var api = { formatWhen: formatWhen, formatUtc: formatUtc, applyLocalTimes: applyLocalTimes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SFDC24LocalTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
