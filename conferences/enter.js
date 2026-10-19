(function () {
  var ROOM = "https://converspan.com/room";
  var CAP = 450;
  var reduce = false;
  var forced = false;
  var gone = false;
  var timer = 0;
  var reduceQuery = null;
  var forcedQuery = null;

  try {
    reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
    reduce = !!reduceQuery.matches;
  } catch (err) {}
  try {
    forcedQuery = matchMedia("(forced-colors: active)");
    forced = !!forcedQuery.matches;
  } catch (err) {}

  function watch(query, apply) {
    if (!query) return;
    var onchange = function () { apply(!!query.matches); };
    if (query.addEventListener) query.addEventListener("change", onchange);
    else if (query.addListener) query.addListener(onchange);
  }
  watch(reduceQuery, function (value) { reduce = value; });
  watch(forcedQuery, function (value) { forced = value; });

  function still() {
    return reduce || forced;
  }

  function roomLink(node) {
    var link = node && node.closest ? node.closest("a") : null;
    if (!link || link.getAttribute("href") !== ROOM) return null;
    if (link.hasAttribute("download")) return null;
    var target = link.getAttribute("target");
    if (target && target.toLowerCase() !== "_self") return null;
    return link;
  }

  function plainClick(event) {
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    return true;
  }

  function layer() {
    return document.getElementById("conference-enter");
  }

  function ready(node) {
    try {
      return getComputedStyle(node).getPropertyValue("--enter-ready").trim() === "1";
    } catch (err) {
      return false;
    }
  }

  function reset() {
    gone = false;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    var node = layer();
    if (node) node.classList.remove("is-on");
  }

  function go(href) {
    if (gone) return;
    var node = layer();
    if (!node || !ready(node)) {
      location.assign(href);
      return;
    }
    gone = true;
    var done = false;
    function nav() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = 0;
      location.assign(href);
    }
    node.classList.add("is-on");
    timer = setTimeout(nav, CAP);
    node.addEventListener("animationend", function (event) {
      if (event.animationName !== "enter-sweep") return;
      nav();
    });
  }

  document.addEventListener("click", function (event) {
    var link = roomLink(event.target);
    if (!link || !plainClick(event) || still()) return;
    event.preventDefault();
    if (!gone) go(link.href);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = roomLink(event.target);
    if (!link || still()) return;
    event.preventDefault();
    if (event.repeat || gone) return;
    go(link.href);
  }, true);

  window.addEventListener("pageshow", reset);
})();
