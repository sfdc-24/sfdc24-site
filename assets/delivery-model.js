/* Delivery model slides (owner, 2026-11-04). Plain JS, no frameworks, same as
   the rest of assets/: five slides rotate on a fixed cadence, pause on hover,
   focus, the pause button, or a hidden tab, and never rotate at all when the
   visitor asked for reduced motion. Without this file the first slide shows
   and the copy still reads top to bottom. */
(function () {
  "use strict";

  var INTERVAL = 4500;

  function init() {
    var section = document.getElementById("delivery-model");
    if (!section) return;
    var slides = Array.prototype.slice.call(section.querySelectorAll(".dm-slide"));
    if (slides.length < 2) return;
    var stage = section.querySelector(".dm-stage");
    var ctl = section.querySelector(".dm-ctl");
    if (!stage || !ctl) return;

    var reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { /* no matchMedia: treat as full motion */ }

    var current = 0;
    var paused = false;   // the visitor pressed pause, or picked a slide
    var resting = false;  // pointer or keyboard focus is on the piece
    var timer = null;

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
      }
    }

    /* Controls are built here so a page without script shows no dead buttons. */
    var pauseBtn = null;
    if (!reduce) {
      pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "dm-pause";
      pauseBtn.setAttribute("aria-pressed", "false");
      pauseBtn.setAttribute("aria-label", "Pause the slides");
      ctl.appendChild(pauseBtn);
    }
    var dots = [];
    var dotsWrap = document.createElement("div");
    dotsWrap.setAttribute("role", "group");
    dotsWrap.setAttribute("aria-label", "Choose a slide");
    dotsWrap.style.display = "contents";
    ctl.appendChild(dotsWrap);
    slides.forEach(function (slide, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "dm-dot";
      b.setAttribute("aria-label", "Slide " + (i + 1) + " of " + slides.length + ": " + labelOf(slide));
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
    ctl.hidden = false;

    function drawPause() {
      if (!pauseBtn) return;
      pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
      pauseBtn.setAttribute("aria-label", paused ? "Play the slides" : "Pause the slides");
      pauseBtn.innerHTML = paused
        ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>';
      /* Announce the slide change only when rotation has stopped. */
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
      return; // no auto-advance, ever; the dots still work by hand
    }

    stage.addEventListener("mouseenter", function () { resting = true; });
    stage.addEventListener("mouseleave", function () { resting = false; });
    section.addEventListener("focusin", function () { resting = true; });
    section.addEventListener("focusout", function (ev) {
      if (!section.contains(ev.relatedTarget)) resting = false;
    });

    timer = window.setInterval(function () {
      if (paused || resting) return;
      if (typeof document.visibilityState === "string" && document.visibilityState !== "visible") return;
      show(current + 1);
    }, INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
