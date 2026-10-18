/* Invite a guest on /conferences/. Writes one fixed room link to the
   clipboard. The chip fades in and out. If that write is missing or
   refused, the link is shown and selected so it can be copied by hand.
   No microphone, no call, no socket, no fetch, no error popup. */
(function () {
  var ROOM = "https://converspan.com/room";
  var button = document.getElementById("conference-invite");
  var toast = document.getElementById("conference-invite-toast");
  var chip = toast ? toast.querySelector(".invite-chip") : null;
  var field = document.getElementById("conference-invite-link");
  if (!button || !toast || !chip || !field) return;

  function showCopied() {
    toast.classList.remove("is-on");
    void toast.offsetWidth;
    chip.textContent = "Copied";
    toast.classList.add("is-on");
  }

  toast.addEventListener("animationend", function (event) {
    if (event.target !== chip || event.animationName !== "invite-chip") return;
    toast.classList.remove("is-on");
    chip.textContent = "";
  });

  function selectField() {
    try {
      var range = document.createRange();
      range.selectNodeContents(field);
      var sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {}
  }

  function showField() {
    toast.classList.remove("is-on");
    chip.textContent = "";
    field.removeAttribute("hidden");
    try { field.focus(); } catch (err) {}
    selectField();
  }

  field.addEventListener("focus", selectField);
  field.addEventListener("keydown", function (event) {
    if (event.key !== "a" && event.key !== "A") return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    selectField();
  });

  function copy() {
    var clip = null;
    try { clip = navigator.clipboard; } catch (err) { clip = null; }
    var write = clip && clip.writeText;
    if (typeof write !== "function") {
      showField();
      return;
    }
    var pending;
    try { pending = write.call(clip, ROOM); } catch (err) {
      showField();
      return;
    }
    if (!pending || typeof pending.then !== "function") {
      showField();
      return;
    }
    pending.then(showCopied, showField);
  }

  var known = false;
  var seen = false;
  var on = false;

  function syncMotion() {
    if (typeof IntersectionObserver !== "function") {
      toast.classList.add("is-still");
      toast.classList.remove("is-held");
      return;
    }
    var pause = document.hidden || (known && seen && !on);
    toast.classList.toggle("is-held", pause);
    if (!toast.getAnimations) return;
    var anims = toast.getAnimations({ subtree: true });
    for (var i = 0; i < anims.length; i++) {
      if (pause && anims[i].playState === "running") anims[i].pause();
      else if (!pause && anims[i].playState === "paused") anims[i].play();
    }
  }

  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(function (entries) {
      var last = entries[entries.length - 1];
      on = !!(last && last.isIntersecting);
      if (on) seen = true;
      known = true;
      syncMotion();
    }, { threshold: [0, 0.01] }).observe(button);
  } else {
    toast.classList.add("is-still");
  }
  document.addEventListener("visibilitychange", syncMotion);

  button.addEventListener("click", function () {
    copy();
    syncMotion();
  });
})();
