// "Agents joining": a short stage at the top of the room pane, shown when the owner presses Join the room.
// The stopwatch counts from the press. A chip lights only on a real signal: a message from the room's own
// frame, from its own origin (room.sfdc24.com). Nothing here guesses that an agent has joined.
// Message the room sends: {source: "sfdc24-room", chair: "ready" | "down", agents: ["claude", "grok", ...]}.
(function () {
  var btn = document.getElementById("conf-room-toggle");
  var box = document.getElementById("conf-room");
  var frame = document.getElementById("conf-room-frame");
  if (!btn || !box || !frame) return;
  var AGENTS = [["claude", "Claude"], ["grok", "Grok"], ["codex", "Codex"], ["gemini", "Gemini"]];
  var WAIT_MS = Number(box.getAttribute("data-join-wait-ms")) || 90000;
  // The room sits behind Google sign-in, and Google's sign-in page will not open inside a frame.
  // If nothing is heard after HINT_MS, offer the one-time sign-in in its own tab.
  var HINT_MS = 20000;
  var origin = "";
  try { origin = new URL(frame.getAttribute("data-src")).origin; } catch (err) {}
  var stage = null, started = 0, timer = 0, joined = {}, state = "";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function clock(ms) {
    var s = Math.max(0, ms) / 1000;
    return Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2) + "." + Math.floor((s * 10) % 10);
  }
  function say(text) { stage.querySelector(".cj-say").textContent = text; }
  function tick() {
    if (!stage) return;
    var ms = Date.now() - started;
    stage.querySelector(".cj-clock").textContent = clock(ms);
    if (state === "" && ms >= HINT_MS && !stage.querySelector(".cj-hint")) {
      var hint = el("p", "cj-hint", "Pane blank? ");
      var a = el("a", "", "Sign in to the room once in a new tab");
      a.href = frame.getAttribute("data-src");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      hint.appendChild(a);
      hint.appendChild(document.createTextNode(", then press Join the room again."));
      stage.appendChild(hint);
    }
    if ((state === "" || state === "heard") && ms >= WAIT_MS) {
      var waiting = AGENTS.filter(function (a) { return !joined[a[0]]; }).map(function (a) { return a[1]; });
      say(state === "" ? "Agents still joining. No word from the room yet." : "Still waiting on " + waiting.join(", "));
      state = "slow";
      stage.setAttribute("data-state", "slow");
    }
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
    if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
    stage = null;
  }
  function start() {
    stop();
    joined = {};
    state = "";
    started = Date.now();
    stage = el("div", "cj");
    stage.id = "conf-joining";
    stage.setAttribute("role", "status");
    stage.setAttribute("data-keep-names", "");
    stage.setAttribute("data-state", "");
    var top = el("p", "cj-top");
    top.appendChild(el("span", "cj-clock", "0:00.0"));
    top.appendChild(el("span", "cj-say", "Agents joining"));
    var close = el("button", "cj-x", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Hide the joining timer");
    close.addEventListener("click", stop);
    top.appendChild(close);
    var chips = el("p", "cj-chips");
    AGENTS.forEach(function (a) {
      var chip = el("span", "cj-chip", a[1]);
      chip.setAttribute("data-agent", a[0]);
      chip.setAttribute("data-on", "0");
      chips.appendChild(chip);
    });
    stage.appendChild(top);
    stage.appendChild(chips);
    box.insertBefore(stage, box.firstChild);
    timer = setInterval(tick, 100);
  }
  function light(list) {
    var n = 0;
    AGENTS.forEach(function (a) {
      if (list.indexOf(a[0]) !== -1) joined[a[0]] = true;
      if (joined[a[0]]) { n++; stage.querySelector('[data-agent="' + a[0] + '"]').setAttribute("data-on", "1"); }
    });
    return n;
  }
  window.addEventListener("message", function (event) {
    if (!stage || !origin || event.origin !== origin || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== "sfdc24-room") return;
    var hintEl = stage.querySelector(".cj-hint");
    if (hintEl) hintEl.parentNode.removeChild(hintEl);
    if (data.chair === "down") {
      state = "down";
      stage.setAttribute("data-state", "down");
      say("The chair is down. The agents are not in the room.");
      return;
    }
    if (data.chair !== "ready") return;
    var list = Array.isArray(data.agents) ? data.agents.map(String) : [];
    var n = light(list);
    if (n < AGENTS.length) {
      if (n && state !== "slow") { state = "heard"; say(n + " of " + AGENTS.length + " in"); }
      return;
    }
    clearInterval(timer);
    timer = 0;
    state = "in";
    stage.setAttribute("data-state", "in");
    say("Everyone\u2019s in");
    var mine = stage;
    setTimeout(function () { if (stage === mine) stop(); }, 2500);
  });
  btn.addEventListener("click", function () {
    if (box.hidden) stop(); else start();
  });
})();
