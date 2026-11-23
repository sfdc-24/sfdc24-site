// Agent Demo closes the card canvas. In Agent Demo the presenter's screen share is the stage, so while the room is open
// the canvas beside it starts closed and the room takes the full width. The room frame says which meeting mode the
// chair is in: {source: "sfdc24-room", meeting_mode: "demo" | "brainstorm" | "workshop" | ""}, from its own origin only.
// In Agent Demo, with the room open, the canvas button opens the canvas beside the room and closes it again; it never
// hides the room. Each new Agent Demo starts with the canvas closed. Out of Agent Demo the page is as it was.
(function () {
  var frame = document.getElementById("conf-room-frame");
  var root = document.getElementById("proto-canvas");
  var btn = document.getElementById("conf-canvas-toggle");
  if (!frame || !root || !btn) return;
  var origin = "";
  try { origin = new URL(frame.getAttribute("data-src")).origin; } catch (err) {}
  var body = document.body;
  var demo = false, shown = false;

  function active() { return demo && body.classList.contains("conf-room-open"); }
  function paintButton() {
    var open = active() ? shown : root.getAttribute("data-started") === "1";
    var text = open ? "Close the canvas" : "Open the canvas";
    if (btn.textContent !== text) btn.textContent = text;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function paint(on) {
    if (on && !demo) shown = false;              // a new Agent Demo starts with the canvas closed
    demo = on;
    body.classList.toggle("conf-demo", on);
    body.classList.toggle("conf-demo-canvas", on && shown);
    paintButton();
  }
  // The room opens and closes on the page's own buttons: the canvas button's words follow.
  if (typeof MutationObserver === "function") {
    new MutationObserver(paintButton).observe(body, {attributes: true, attributeFilter: ["class"]});
  }
  // In Agent Demo the button only opens or closes the canvas. Caught before the page's own handler, which would
  // close the room with the canvas.
  document.addEventListener("click", function (event) {
    if (!active() || !(event.target instanceof Node) || !btn.contains(event.target)) return;
    event.stopPropagation();
    shown = !shown;
    paint(true);
  }, true);
  window.addEventListener("message", function (event) {
    if (!origin || event.origin !== origin || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== "sfdc24-room" || typeof data.meeting_mode !== "string") return;
    paint(data.meeting_mode === "demo");
  });
})();
