(function () {
  var root = document.getElementById("conference-faq");
  if (!root) return;
  var buttons = root.querySelectorAll(".faq-btn");
  if (!buttons.length) return;

  function itemOf(btn) {
    var node = btn;
    while (node && node !== root) {
      if (node.classList && node.classList.contains("faq-item")) return node;
      node = node.parentNode;
    }
    return null;
  }

  function panelOf(btn) {
    var id = btn.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }

  function setOpen(btn, open) {
    var item = itemOf(btn);
    var panel = panelOf(btn);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (item) item.classList.toggle("is-open", open);
    if (!panel) return;
    if (open) {
      panel.removeAttribute("aria-hidden");
      panel.removeAttribute("inert");
    } else {
      panel.setAttribute("aria-hidden", "true");
      panel.setAttribute("inert", "");
    }
  }

  function toggle(btn) {
    var open = btn.getAttribute("aria-expanded") === "true";
    if (!open) {
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i] !== btn) setOpen(buttons[i], false);
      }
    }
    setOpen(btn, !open);
  }

  function onKey(event) {
    var key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    var idx = -1;
    for (var i = 0; i < buttons.length; i++) if (buttons[i] === event.currentTarget) idx = i;
    if (idx < 0) return;
    var next = idx;
    if (key === "ArrowDown") next = Math.min(buttons.length - 1, idx + 1);
    else if (key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (key === "Home") next = 0;
    else if (key === "End") next = buttons.length - 1;
    if (next !== idx) buttons[next].focus();
  }

  var known = false;
  var seen = false;
  var on = false;

  function syncMotion() {
    var pause = document.hidden || (known && seen && !on);
    root.classList.toggle("is-held", pause);
    var nodes = root.querySelectorAll(".faq-panel, .faq-chev, .faq-panel-in");
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].getAnimations) continue;
      var anims = nodes[i].getAnimations();
      for (var a = 0; a < anims.length; a++) {
        if (pause && anims[a].playState === "running") anims[a].pause();
        else if (!pause && anims[a].playState === "paused") anims[a].play();
      }
    }
  }

  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(function (entries) {
      var last = entries[entries.length - 1];
      on = !!(last && last.isIntersecting && last.intersectionRatio >= 0.35);
      if (on) seen = true;
      known = true;
      syncMotion();
    }, { threshold: [0, 0.35] }).observe(root);
  }
  document.addEventListener("visibilitychange", syncMotion);

  for (var j = 0; j < buttons.length; j++) {
    setOpen(buttons[j], false);
    buttons[j].addEventListener("click", function (event) {
      toggle(event.currentTarget);
      syncMotion();
    });
    buttons[j].addEventListener("keydown", onKey);
  }
})();
