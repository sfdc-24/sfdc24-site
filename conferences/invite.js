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

  function showField() {
    toast.classList.remove("is-on");
    chip.textContent = "";
    field.removeAttribute("hidden");
    try { field.focus(); } catch (err) {}
    try {
      var range = document.createRange();
      range.selectNodeContents(field);
      var sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {}
  }

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

  button.addEventListener("click", copy);
})();
