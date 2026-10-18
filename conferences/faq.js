/* Questions on /conferences/. One panel open at a time.
   Click, Enter, and Space toggle. Arrow keys, Home, and End move
   between the labels. No timers, no network, no microphone. */
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

  for (var j = 0; j < buttons.length; j++) {
    setOpen(buttons[j], false);
    buttons[j].addEventListener("click", function (event) { toggle(event.currentTarget); });
    buttons[j].addEventListener("keydown", onKey);
  }
})();
