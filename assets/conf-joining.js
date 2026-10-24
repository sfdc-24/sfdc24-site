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
  // The room sits behind Google sign-in, and Google's sign-in page will not open inside a frame. So the
  // sign-in is refreshed in a small window that closes itself: the room page, opened with ?signin=1, tells
  // this page {auth: "ok"} and shuts. The framed room says {auth: "ok"} when it loads signed in, and
  // {auth: "expired"} when a request comes back 401. If the frame has not said ok within PROBE_MS of the
  // press (still inside the browser's 5 s allowance for opening a window), the refresh window opens by
  // itself; later, a Reconnect button does the same. Nothing here ever sends the owner to another tab.
  var PROBE_MS = Number(box.getAttribute("data-signin-probe-ms")) || 3500;
  var HINT_MS = 20000;
  var origin = "";
  try { origin = new URL(frame.getAttribute("data-src")).origin; } catch (err) {}
  var stage = null, started = 0, timer = 0, joined = {}, state = "", attempted = false;
  var signin = null, frameOk = false, probe = 0;

  function reloadFrame() {
    var src = frame.getAttribute("data-src");
    frame.setAttribute("src", src + (src.indexOf("?") === -1 ? "?" : "&") + "r=" + Date.now());
  }
  function dropReconnect() {
    if (!stage) return;
    var hintEl = stage.querySelector(".cj-hint");
    if (hintEl) hintEl.parentNode.removeChild(hintEl);
  }
  function offerReconnect(text) {
    if (!stage) return;
    dropReconnect();
    var hint = el("p", "cj-hint", text + " ");
    var b = el("button", "cj-reconnect", "Reconnect");
    b.type = "button";
    b.addEventListener("click", signIn);
    hint.appendChild(b);
    stage.appendChild(hint);
  }
  function signIn() {
    clearTimeout(probe);
    probe = 0;
    try {
      signin = window.open(origin + "/?signin=1", "sfdc24-signin", "popup=yes,width=460,height=620");
    } catch (err) { signin = null; }
    if (signin) {
      // Closed without a word (the owner shut it, or the browser cut it off from this page): load the
      // room again anyway; if it is still signed out, Reconnect is offered.
      var mine = signin;
      var watch = setInterval(function () {
        if (signin !== mine) { clearInterval(watch); return; }
        var gone = true;
        try { gone = mine.closed; } catch (err) {}
        if (!gone) return;
        clearInterval(watch);
        signin = null;
        reloadFrame();
        offerReconnect("Still not in?");
      }, 500);
    }
    if (!stage) return;
    if (signin) { dropReconnect(); say("Refreshing your sign-in\u2026"); }
    else offerReconnect("Your browser blocked the sign-in window. Allow pop-ups for sfdc24.com, then");
  }

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
  function clearReady(next, message) {
    clearInterval(timer);
    timer = 0;
    joined = {};
    stage.querySelectorAll(".cj-chip").forEach(function (chip) { chip.setAttribute("data-on", "0"); });
    stage.querySelector(".cj-chips").hidden = true;
    state = next;
    stage.setAttribute("data-state", next);
    say(message);
  }
  function resume() {
    joined = {};
    stage.querySelectorAll(".cj-chip").forEach(function (chip) { chip.setAttribute("data-on", "0"); });
    stage.querySelector(".cj-chips").hidden = false;
    started = Date.now();
    stage.querySelector(".cj-clock").textContent = clock(0);
    if (!timer) timer = setInterval(tick, 100);
  }
  function tick() {
    if (!stage) return;
    var ms = Date.now() - started;
    stage.querySelector(".cj-clock").textContent = clock(ms);
    if (state === "" && !frameOk && ms >= HINT_MS && !stage.querySelector(".cj-hint")) {
      offerReconnect("Pane blank?");
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
    attempted = false;
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
    if (!origin || event.origin !== origin) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== "sfdc24-room") return;
    if (signin && event.source === signin) {
      if (data.auth !== "ok") return;
      try { signin.close(); } catch (err) {}
      signin = null;
      frameOk = false;
      reloadFrame();
      if (stage) { dropReconnect(); say("Signed in. Connecting\u2026"); }
      return;
    }
    if (event.source !== frame.contentWindow) return;
    if (data.auth === "ok") {
      frameOk = true;
      clearTimeout(probe);
      probe = 0;
      dropReconnect();
      if (stage && state === "") say("Agents joining");
      return;
    }
    if (data.auth === "expired") {
      frameOk = false;
      offerReconnect("Your sign-in to the room lapsed.");
      if (stage) clearReady("auth-required", "Sign-in lapsed");
      return;
    }
    var connection = data.connection;
    if (connection !== undefined && ["joining", "auth-required", "failed", "connected", "disconnected"].indexOf(connection) === -1) return;
    if (connection === undefined) {
      frameOk = true;             // preserve the existing chair-message sign-in behavior
      clearTimeout(probe);
      probe = 0;
    }
    if (!stage) return;
    if (connection === "disconnected" && (state === "auth-required" || state === "failed")) return;
    if (connection === "disconnected" && !attempted) {
      clearReady("not-connected", "Not connected. Choose a mode in the room, then Join.");
      return;
    }
    if (connection === "auth-required" || connection === "failed" || connection === "disconnected" || data.chair === "down") {
      var next = connection === "auth-required" || connection === "failed" || connection === "disconnected" ? connection : "down";
      var message = next === "auth-required" ? "Room sign-in required. Reconnect to the room." :
        next === "failed" ? "Could not join the room. Retry Join the room." :
        next === "disconnected" ? "Room disconnected. Retry Join the room." :
        "The chair is down. The agents are not in the room.";
      clearReady(next, message);
      if (next === "auth-required") offerReconnect("Room sign-in required.");
      return;
    }
    var terminal = state === "auth-required" || state === "failed" || state === "disconnected" || state === "down";
    if (terminal && connection !== "joining" && connection !== "connected") return;
    if (data.chair !== "ready" && connection !== "joining" && connection !== "connected") return;
    if (terminal || state === "not-connected") resume();
    if (connection === "joining" || connection === "connected" || data.chair === "ready") attempted = true;
    dropReconnect();
    if (connection === "joining" && data.chair !== "ready") {
      joined = {};
      stage.querySelectorAll(".cj-chip").forEach(function (chip) { chip.setAttribute("data-on", "0"); });
      state = "joining";
      stage.setAttribute("data-state", "joining");
      say("Connecting to the room.");
      return;
    }
    if (connection === "connected" && data.chair !== "ready") {
      joined = {};
      stage.querySelectorAll(".cj-chip").forEach(function (chip) { chip.setAttribute("data-on", "0"); });
      state = "connected";
      stage.setAttribute("data-state", "connected");
      say("Room connected. Waiting for chair readiness.");
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
    setTimeout(function () { if (stage === mine && state === "in") stop(); }, 2500);
  });
  btn.addEventListener("click", function () {
    clearTimeout(probe);
    probe = 0;
    if (box.hidden) { stop(); return; }
    start();
    if (!frameOk) probe = setTimeout(function () { probe = 0; if (stage && !frameOk) signIn(); }, PROBE_MS);
  });
})();
