/* Mobile guide for /conferences/. IntersectionObserver only: the bar
   appears after the hero and leaves when Start and Join reaches the
   reading area, when those buttons would sit under the bar, when the
   footer disclaimer would, or when a focused control would. The button
   is an in-page anchor. No timers, no network, no room or session call. */
(function () {
  var bar = document.getElementById("conference-flow");
  if (!bar) return;

  var ZONE = 96;
  var observers = [];
  var cleanups = [];
  var armed = false;
  var onReady = null;
  var mobile = false;
  var pastHero = false;
  var joinInBand = false;
  var joinInZone = false;
  var footerOn = false;
  var focusCovered = false;
  var heroEls = [];
  var heroSeen = [];
  var sections = [];
  var focusEls = [];

  function textOf(sel) {
    var el = document.querySelector(sel);
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function build() {
    var list = bar.querySelector(".flowbar-dots");
    if (!list || list.childElementCount) return;
    var heading = textOf("main h1");
    if (heading) bar.setAttribute("aria-label", heading);
    var specs = [
      { id: "conference-how", label: textOf("#conference-how .label") },
      { id: "conference-stage", label: textOf("#conference-stage .stage-name") },
      { id: "conference-recap", label: textOf("#conference-recap .kicker") },
      { id: "conference-actions", label: textOf("#conference-start") },
      { id: "conference-ready", label: textOf("#conference-ready-title") }
    ];
    sections = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      if (!spec.label || !document.getElementById(spec.id)) continue;
      sections.push(spec);
      var li = document.createElement("li");
      li.className = "flowbar-dot";
      li.setAttribute("data-state", "todo");
      li.setAttribute("data-for", spec.id);
      var mark = document.createElement("span");
      mark.className = "flowbar-mark";
      mark.setAttribute("aria-hidden", "true");
      var name = document.createElement("span");
      name.className = "flowbar-name";
      name.textContent = spec.label;
      li.appendChild(mark);
      li.appendChild(name);
      list.appendChild(li);
    }
  }

  function setCurrent(id) {
    if (!id || bar.getAttribute("data-flow-current") === id) return;
    bar.setAttribute("data-flow-current", id);
    var idx = -1;
    for (var i = 0; i < sections.length; i++) if (sections[i].id === id) idx = i;
    var dots = bar.querySelectorAll(".flowbar-dot");
    for (var j = 0; j < dots.length; j++) {
      var state = j < idx ? "done" : (j === idx ? "current" : "todo");
      dots[j].setAttribute("data-state", state);
      if (j === idx) dots[j].setAttribute("aria-current", "step");
      else dots[j].removeAttribute("aria-current");
    }
    var list = bar.querySelector(".flowbar-dots");
    if (list && sections.length > 1 && idx >= 0) {
      list.style.setProperty("--flow-progress", String(idx / (sections.length - 1)));
    }
  }

  function pickCurrent() {
    var line = window.innerHeight * 0.36;
    var best = "";
    for (var i = 0; i < sections.length; i++) {
      var el = document.getElementById(sections[i].id);
      if (!el) continue;
      var rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.top <= line && rect.bottom > 0) best = sections[i].id;
    }
    if (best) setCurrent(best);
  }

  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function overlaps(el, top, bottom) {
    var rect = rectOf(el);
    return !!rect && rect.bottom > top && rect.top < bottom;
  }

  function joinReached(el) {
    var height = window.innerHeight;
    joinInBand = overlaps(el, height * 0.2, height * 0.45);
    joinInZone = overlaps(el, height - ZONE, height);
    return joinInBand || joinInZone;
  }

  function disclaimerHit(el) {
    var height = window.innerHeight;
    return overlaps(el, height - ZONE, height + 8);
  }

  function covers(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (bar.contains(el)) return false;
    return overlaps(el, window.innerHeight - ZONE, window.innerHeight);
  }

  function readNow() {
    var off = heroEls.length > 0;
    for (var i = 0; i < heroEls.length; i++) {
      var rect = rectOf(heroEls[i]);
      var gone = !!rect && (rect.bottom <= 0 || rect.top >= window.innerHeight);
      heroSeen[i] = !gone;
      if (!gone) off = false;
    }
    pastHero = off;
    joinReached(document.getElementById("conference-actions"));
    footerOn = disclaimerHit(document.querySelector(".chrome-disclaimer"));
    focusCovered = covers(document.activeElement);
    pickCurrent();
  }

  function sync() {
    var joinOn = joinInBand || joinInZone;
    var instant = footerOn || focusCovered || joinInZone;
    var show = mobile && pastHero && !joinOn && !footerOn && !focusCovered;
    if (!show && document.activeElement && bar.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch (err) {}
    }
    bar.classList.toggle("is-instant", !show && instant);
    bar.classList.toggle("is-on", show);
    bar.classList.toggle("is-held", document.hidden);
    if (document.hidden) settleMotion();
    if (show) {
      bar.removeAttribute("aria-hidden");
      bar.removeAttribute("inert");
    } else {
      bar.setAttribute("aria-hidden", "true");
      bar.setAttribute("inert", "");
    }
  }

  function eachMotion(fn) {
    var nodes = [bar, bar.querySelector(".flowbar-in")];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i] || !nodes[i].getAnimations) continue;
      var anims = nodes[i].getAnimations();
      for (var a = 0; a < anims.length; a++) fn(anims[a]);
    }
  }

  function settleMotion() {
    eachMotion(function (anim) {
      if (anim.playState === "running") anim.pause();
    });
  }

  function disarm() {
    for (var i = 0; i < observers.length; i++) observers[i].disconnect();
    observers = [];
    for (var j = 0; j < cleanups.length; j++) cleanups[j]();
    cleanups = [];
    if (onReady) {
      document.removeEventListener("DOMContentLoaded", onReady);
      onReady = null;
    }
    armed = false;
    bar.setAttribute("data-watching", "0");
  }

  function watch(el, margin, fn) {
    if (!el) return;
    var io = new IntersectionObserver(fn, { root: null, rootMargin: margin, threshold: [0, 0.01, 0.5, 1] });
    io.observe(el);
    observers.push(io);
  }

  function arm() {
    if (armed) return;
    if (typeof IntersectionObserver !== "function") {
      bar.setAttribute("data-watching", "0");
      return;
    }
    armed = true;
    build();
    bar.setAttribute("data-watching", "1");

    var mq = null;
    try { mq = window.matchMedia("(max-width: 720px)"); } catch (err) { mq = null; }
    mobile = mq ? !!mq.matches : window.innerWidth <= 720;
    if (mq) {
      var onMq = function () {
        mobile = !!mq.matches;
        readNow();
        sync();
      };
      if (mq.addEventListener) {
        mq.addEventListener("change", onMq);
        cleanups.push(function () { mq.removeEventListener("change", onMq); });
      } else if (mq.addListener) {
        mq.addListener(onMq);
        cleanups.push(function () { mq.removeListener(onMq); });
      }
    }

    heroEls = [];
    var h1 = document.querySelector("main h1");
    var lede = document.querySelector("main .lede");
    if (h1) heroEls.push(h1);
    if (lede) heroEls.push(lede);
    heroSeen = [];
    for (var h = 0; h < heroEls.length; h++) heroSeen[h] = true;
    var heroIo = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var idx = heroEls.indexOf(entries[i].target);
        if (idx >= 0) heroSeen[idx] = !!entries[i].isIntersecting;
      }
      pastHero = heroEls.length > 0;
      for (var k = 0; k < heroSeen.length; k++) if (heroSeen[k]) pastHero = false;
      pickCurrent();
      sync();
    }, { threshold: [0, 0.01] });
    for (var hi = 0; hi < heroEls.length; hi++) heroIo.observe(heroEls[hi]);
    observers.push(heroIo);

    var joinEl = document.getElementById("conference-actions");
    watch(joinEl, "-20% 0px -55% 0px", function (entries) {
      var last = entries[entries.length - 1];
      joinInBand = !!(last && last.isIntersecting);
      pickCurrent();
      sync();
    });
    var zoneTop = Math.max(0, window.innerHeight - ZONE);
    watch(joinEl, "-" + zoneTop + "px 0px 0px 0px", function (entries) {
      var last = entries[entries.length - 1];
      joinInZone = !!(last && last.isIntersecting);
      sync();
    });

    var disc = document.querySelector(".chrome-disclaimer");
    watch(disc, "-" + zoneTop + "px 0px 8px 0px", function (entries) {
      var last = entries[entries.length - 1];
      footerOn = !!(last && last.isIntersecting);
      sync();
    });

    var sectionIo = new IntersectionObserver(function () {
      pickCurrent();
    }, { rootMargin: "-28% 0px -52% 0px", threshold: [0, 0.25, 0.5, 1] });
    for (var s = 0; s < sections.length; s++) {
      var node = document.getElementById(sections[s].id);
      if (node) sectionIo.observe(node);
    }
    observers.push(sectionIo);

    focusEls = [];
    var candidates = document.querySelectorAll("a[href], button, [tabindex]");
    for (var c = 0; c < candidates.length; c++) {
      if (!bar.contains(candidates[c])) focusEls.push(candidates[c]);
    }
    var focusIo = new IntersectionObserver(function () {
      focusCovered = covers(document.activeElement);
      sync();
    }, { rootMargin: "-" + zoneTop + "px 0px 0px 0px", threshold: [0, 0.01] });
    for (var f = 0; f < focusEls.length; f++) focusIo.observe(focusEls[f]);
    observers.push(focusIo);

    listen(document, "focusin", function (event) {
      focusCovered = covers(event.target);
      sync();
    });
    listen(document, "focusout", function (event) {
      focusCovered = covers(event.relatedTarget);
      sync();
    });

    readNow();
    sync();
  }

  function listen(target, type, fn) {
    target.addEventListener(type, fn);
    cleanups.push(function () { target.removeEventListener(type, fn); });
  }

  document.addEventListener("visibilitychange", function () {
    bar.classList.toggle("is-held", document.hidden);
    if (document.hidden) settleMotion();
    else eachMotion(function (anim) {
      if (anim.playState === "paused") anim.play();
    });
  });
  window.addEventListener("pagehide", disarm);
  window.addEventListener("pageshow", function (event) {
    if (!event || !event.persisted) return;
    arm();
  });

  if (document.readyState === "loading") {
    onReady = function () {
      onReady = null;
      arm();
    };
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    arm();
  }
})();
