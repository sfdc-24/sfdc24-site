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
  var stage = null, started = 0, timer = 0, joined = {}, state = "";
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
      if (stage) say("Sign-in lapsed");
      return;
    }
    frameOk = true;               // any word from the framed room means it loaded signed in
    clearTimeout(probe);
    probe = 0;
    if (!stage) return;
    dropReconnect();
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
    clearTimeout(probe);
    probe = 0;
    if (box.hidden) { stop(); return; }
    start();
    if (!frameOk) probe = setTimeout(function () { probe = 0; if (stage && !frameOk) signIn(); }, PROBE_MS);
  });
})();
