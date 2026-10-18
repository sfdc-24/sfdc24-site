/* Feature detect only. Reads APIs the browser already exposes.
   Does not call getUserMedia, construct a peer connection or an audio
   context, open a socket, or send anything. */
(function () {
  var root = document.getElementById("conference-ready");
  if (!root) return;
  var list = root.querySelector(".ready-list");
  if (!list) return;

  var TYPE_LABELS = { wifi: "Wi-Fi", ethernet: "Ethernet", cellular: "Cellular", bluetooth: "Bluetooth", wimax: "WiMAX" };
  var RATE_LABELS = { "slow-2g": "Slow 2G", "2g": "2G", "3g": "3G", "4g": "4G" };
  var CHECKS = [
    { id: "https", pass: "Secure", fail: "Use HTTPS" },
    { id: "webrtc", pass: "Calls", fail: "No call support" },
    { id: "mic", pass: "Mic API", fail: "No mic API" },
    { id: "audio", pass: "Audio", fail: "No audio support" },
    { id: "link", pass: "", fail: "" }
  ];

  var io = null;
  var hold = null;
  var seen = false;
  var armed = false;
  var onScreen = false;
  var placed = false;

  function present(fn) {
    return typeof fn === "function";
  }

  function linkLabel() {
    var online = true;
    try { online = navigator.onLine !== false; } catch (err) { online = true; }
    var conn = null;
    try { conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null; } catch (err) { conn = null; }
    var type = "";
    var rate = "";
    if (conn) {
      try { type = String(conn.type || ""); } catch (err) { type = ""; }
      try { rate = String(conn.effectiveType || ""); } catch (err) { rate = ""; }
    }
    if (!online || type === "none") return { ok: false, text: "You look offline" };
    if (TYPE_LABELS[type]) return { ok: true, text: TYPE_LABELS[type] };
    if (RATE_LABELS[rate]) return { ok: true, text: RATE_LABELS[rate] };
    return { ok: true, text: "Online" };
  }

  function read() {
    var secure = false;
    var calls = false;
    var mic = false;
    var sound = false;
    try { secure = window.isSecureContext === true; } catch (err) { secure = false; }
    try {
      calls = present(window.RTCPeerConnection) || present(window.webkitRTCPeerConnection);
    } catch (err) { calls = false; }
    try {
      var devices = navigator.mediaDevices;
      mic = !!devices && present(devices.getUserMedia);
    } catch (err) { mic = false; }
    try {
      sound = present(window.AudioContext) || present(window.webkitAudioContext);
    } catch (err) { sound = false; }
    var link = linkLabel();
    return {
      https: { ok: secure },
      webrtc: { ok: calls },
      mic: { ok: mic },
      audio: { ok: sound },
      link: link
    };
  }

  function paint() {
    var found = read();
    for (var i = 0; i < CHECKS.length; i++) {
      var spec = CHECKS[i];
      var chip = list.querySelector('[data-check="' + spec.id + '"]');
      var row = found[spec.id];
      if (!chip || !row) continue;
      var label = chip.querySelector(".ready-label");
      var text = row.text || (row.ok ? spec.pass : spec.fail);
      chip.setAttribute("data-state", row.ok ? "pass" : "fail");
      if (label) label.textContent = text;
    }
    list.setAttribute("aria-busy", "false");
    seen = true;
    root.classList.add("is-in");
    stop();
    armHold();
    syncHold();
  }

  function syncHold() {
    if (!seen || root.classList.contains("is-still")) {
      root.classList.remove("is-held");
      return;
    }
    root.classList.toggle("is-held", document.hidden || (placed && !onScreen));
  }

  function armHold() {
    if (hold || typeof IntersectionObserver !== "function") return;
    hold = new IntersectionObserver(function (entries) {
      var last = entries[entries.length - 1];
      onScreen = !!(last && last.isIntersecting && last.intersectionRatio >= 0.35);
      placed = true;
      syncHold();
    }, { threshold: [0, 0.35] });
    hold.observe(root);
  }

  function dropHold() {
    if (hold) {
      hold.disconnect();
      hold = null;
    }
    placed = false;
    onScreen = false;
  }

  function stop() {
    if (io) {
      io.disconnect();
      io = null;
    }
    root.setAttribute("data-watching", "0");
  }

  function arm() {
    if (armed) return;
    armed = true;
    root.classList.add("is-armed");
    if (typeof IntersectionObserver !== "function") {
      root.classList.add("is-still");
      root.setAttribute("data-watching", "0");
      paint();
      return;
    }
    io = new IntersectionObserver(function (entries) {
      var last = entries[entries.length - 1];
      if (!last || !last.isIntersecting || last.intersectionRatio < 0.35) return;
      paint();
    }, { threshold: [0, 0.35] });
    io.observe(root);
    root.setAttribute("data-watching", "1");
  }

  function onHide() {
    root.classList.add("is-held");
    dropHold();
    stop();
    armed = false;
  }

  function onShow(event) {
    if (!event || !event.persisted) return;
    if (seen) {
      paint();
      return;
    }
    arm();
  }

  document.addEventListener("visibilitychange", syncHold);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  arm();
})();
