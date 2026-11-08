/* System architecture showcase slides (2026-11-08).
   Plain JS, no external libraries. Synchronizes the four architecture layer
   tabs, the animated SVG slide stage, and the bottom pause/dot controls.
   Respects prefers-reduced-motion: reduce (no auto-rotation when reduced
   motion is requested). Without script, the first slide stands on its own. */
(function () {
  "use strict";

  var INTERVAL = 5500;

  function init() {
    var section = document.getElementById("system-architecture");
    if (!section) return;
    var slides = Array.prototype.slice.call(section.querySelectorAll(".arch-slide"));
    if (slides.length < 2) return;
    var stage = section.querySelector(".arch-stage");
    var ctl = section.querySelector(".arch-ctl");
    var tabsWrap = section.querySelector(".arch-tabs");
    var tabs = Array.prototype.slice.call(section.querySelectorAll(".arch-tab"));
    if (!stage || !ctl) return;
    if (tabsWrap) tabsWrap.hidden = false;
    section.classList.add("is-ready");

    var reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}

    var current = 0;
    var paused = false;
    var resting = false;
    var dots = [];

    function labelOf(slide) {
      var h = slide.querySelector("h3");
      return h ? h.textContent.replace(/\s+/g, " ").trim() : "";
    }

    function show(i) {
      current = (i + slides.length) % slides.length;
      for (var s = 0; s < slides.length; s++) {
        var on = s === current;
        slides[s].setAttribute("aria-hidden", on ? "false" : "true");
        slides[s].classList.toggle("is-on", on);
        if (dots[s]) {
          if (on) dots[s].setAttribute("aria-current", "true");
          else dots[s].removeAttribute("aria-current");
        }
        if (tabs[s]) {
          tabs[s].setAttribute("aria-selected", on ? "true" : "false");
          tabs[s].setAttribute("tabindex", on ? "0" : "-1");
        }
      }
    }

    var pauseBtn = null;
    if (!reduce) {
      pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "arch-pause";
      pauseBtn.setAttribute("aria-pressed", "false");
      pauseBtn.setAttribute("aria-label", "Pause architecture slides");
      ctl.appendChild(pauseBtn);
    }

    var dotsWrap = document.createElement("div");
    dotsWrap.setAttribute("role", "group");
    dotsWrap.setAttribute("aria-label", "Choose an architecture layer");
    dotsWrap.style.display = "contents";
    ctl.appendChild(dotsWrap);

    slides.forEach(function (slide, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "arch-dot";
      b.setAttribute("aria-label", "Layer " + (i + 1) + " of " + slides.length + ": " + labelOf(slide));
      b.addEventListener("click", function () {
        setPaused(true);
        show(i);
      });
      b.addEventListener("keydown", function (ev) {
        var step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        var next = (i + step + slides.length) % slides.length;
        dots[next].focus();
        setPaused(true);
        show(next);
      });
      dots.push(b);
      dotsWrap.appendChild(b);
    });

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        setPaused(true);
        show(i);
      });
      tab.addEventListener("keydown", function (ev) {
        var step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        var next = (i + step + slides.length) % slides.length;
        tabs[next].focus();
        setPaused(true);
        show(next);
      });
    });

    ctl.hidden = false;

    function drawPause() {
      if (!pauseBtn) return;
      pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
      pauseBtn.setAttribute("aria-label", paused ? "Play architecture slides" : "Pause architecture slides");
      pauseBtn.innerHTML = paused
        ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>';
      stage.setAttribute("aria-live", paused || reduce ? "polite" : "off");
    }

    function setPaused(v) {
      paused = !!v;
      drawPause();
    }

    if (pauseBtn) {
      pauseBtn.addEventListener("click", function () { setPaused(!paused); });
      drawPause();
    }

    show(0);

    if (reduce) {
      stage.setAttribute("aria-live", "polite");
      return;
    }

    stage.addEventListener("mouseenter", function () { resting = true; });
    stage.addEventListener("mouseleave", function () { resting = false; });
    section.addEventListener("focusin", function () { resting = true; });
    section.addEventListener("focusout", function (ev) {
      if (!section.contains(ev.relatedTarget)) resting = false;
    });

    window.setInterval(function () {
      if (paused || resting) return;
      if (typeof document.visibilityState === "string" && document.visibilityState !== "visible") return;
      show(current + 1);
    }, INTERVAL);
  }

  function initAgentModel() {
    var model = document.getElementById("agent-model");
    if (!model) return;
    var cards = Array.prototype.slice.call(model.querySelectorAll(".am-card[data-seat]"));
    function highlight(seat, cardEl) {
      model.setAttribute("data-active-seat", seat || "");
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle("is-focused", cards[i] === cardEl);
      }
    }
    cards.forEach(function (c) {
      var seat = c.getAttribute("data-seat");
      c.addEventListener("mouseenter", function () { highlight(seat, c); });
      c.addEventListener("mouseleave", function () { highlight("", null); });
      c.addEventListener("focusin", function () { highlight(seat, c); });
      c.addEventListener("focusout", function () { highlight("", null); });
      c.addEventListener("click", function () { highlight(seat, c); });
    });
  }

  function boot() {
    init();
    initAgentModel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
