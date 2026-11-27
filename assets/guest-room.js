/* Guest seat.
   A link puts the code in location.hash (the leading # is stripped) and
   the page joins on its own. With no hash, the page shows one box labeled
   "Enter your code" and a Join button. The offer line stays hidden there.
   The posted code is the hash or exactly what was typed: case, spaces,
   and dashes stay as they are.
   A hash is not trimmed. Only an all-whitespace hash counts as empty.
   The code is never read from the query string, never written to storage,
   and never sent anywhere except the join request body. Nothing here
   writes that code, or the media join token, into a log or into page text
   after Join. Leave clears the hash and keeps the query string.
   The code box is a form. The input has no name. Submit is cancelled in
   script, so the code is not placed on the query string.
   POST {code, device, join_nonce} to an https origin + /api/guest/join.
   serviceUrl lives in /data/guest-join.json and must be an https origin
   with no path, query, or fragment. device is one stable id for this tab.
   If sessionStorage refuses the write, that same id stays in memory and
   every later try, including each 10 second retry, reuses it.
   join_nonce is a fresh url-safe value on every try. Both come from
   crypto.getRandomValues. If that is missing, the join stops.
   200 JSON {livekit_url, room, identity, join_token, join_expires_at, name, deadline, role}.
   A role of presenter is refused. This page is for guests.
   Connect with livekit_url and join_token. Publish a microphone only.
   The signal address must be wss://. https:// is used as wss://.
   ws:// and http:// are refused. An http://localhost, http://127.0.0.1,
   or http://[::1] page may use ws:// to one of those hosts.
   409 whose error is "the call has not started": retry every 10 seconds.
   409 "the call is full", 403 "this invite is not valid", 429 and 503 stop.
   429 says there were too many invalid codes and to wait ten minutes.
   Play remote audio. Show a scr_ or prs_ participant's video large.
   Other video tracks are not drawn. Everyone else is a block in a row.
   An identity that starts with bnd_ is skipped. It gets no tile, no row
   in that list, and it does not add to the people count. Its audio and
   video are not attached.
   When the room disconnects, the seat says the call ended. A connect or
   microphone result that arrives after that does not put the seat back
   in the call, and does not change a room joined afterward.
   While the presenter works on an answer, the chair sends a boolean on
   conf.typing and guest-typing.js plays a soft typing sound in this page
   only, silent while anyone speaks. Nothing of it is published.
   A demo pass: a 200 whose solo block carries a finite deadline (epoch
   seconds) is a demo seat. The page shows one calm line, "Demo session",
   sample data, recording, and the local time it ends, and End Demo in
   place of Leave. End Demo, or the room closing at its deadline,
   disconnects and leaves only a thank-you line. The pass's label (the
   name field) is never shown: the seat is "Guest". A 403 or 503 whose
   error is one of the demo pass notices (a 409 busy box too) is shown
   in those words.
   A demo pass LINK: /guest/?demo=1#CODE (the link a solo pass is given).
   The page then posts nothing on load. It shows a welcome: one line
   about the demo (WELCOME_LINES, picked by WELCOME_PICK, or ?notice=a,
   b or c on the link to compare), three short steps, the recording line
   (RECORD_LINES, picked by RECORD_PICK, or ?rec=team or owner), and two
   buttons: Join, and Join without recording.
   Join posts {code, device, join_nonce, record: true}; Join without
   recording posts record: false, and the guest door turns the call's
   recording off. Either press is the one user gesture the call needs.
   iOS Safari only treats a microphone request as user-initiated when
   that request starts inside the press, before anything is awaited.
   The press asks for the microphone and calls room.startAudio() then,
   and the same track is published once, after the room connects.
   A second track is not created. Rigel and the shared screen start on
   their own; there is no other button. If the microphone is refused,
   a plain panel says how to allow it in the address bar, and Try again
   asks once more inside that tap. If that tap's microphone is allowed
   but publishing it fails, the captured track is stopped, the mic stays
   muted, and the panel says it could not connect to the room.
   A typed code on a demo link shows the same welcome. If the browser
   still blocks sound, one "Tap to hear Rigel" button starts it. In the
   call, Mute and End Demo sit in a bar at the bottom, in thumb reach,
   and Full screen enlarges the shared screen.
*/
(function () {
  "use strict";

  var RETRY_MS = 10000;
  var JOIN_PATH = "/api/guest/join";
  var DEVICE_KEY = "sfdc24-guest-device";
  var ID_OK = /^[A-Za-z0-9_-]{16,128}$/;
  var NOT_STARTED = "the call has not started";
  var CALL_FULL = "the call is full";
  var INVITE_INVALID = "this invite is not valid";
  var DEMO_ENDED = "Thanks \u2014 the demo has ended.";
  var DEMO_MAX_MINUTES = 15;
  // The guest door's own words for a demo pass it refuses, shown as they are. Anything else keeps the plain lines.
  var DEMO_NOTICES = [
    "Solo demos are not open right now. Please try again later.",
    "This demo pass has been withdrawn.",
    "This demo pass has expired.",
    "This demo pass has been used up. Thank you for trying the demo.",
    "Today's demo time is fully booked. Please try again tomorrow.",
    "The demo pass could not be checked just now. Please try again in a minute.",
    "The demo is busy just now. Please try again in a few minutes."
  ];
  // The demo welcome's first line, for the owner to pick: WELCOME_PICK, or ?notice=a|b|c on the link to compare them.
  var WELCOME_LINES = {
    a: "A private demo built around your business. Rigel, our AI consultant, runs it live on a sample " +
      "Salesforce org, so you can try anything.",
    b: "Your private session with Rigel, our AI consultant. Tell Rigel about your business and watch the " +
      "answer take shape on screen.",
    c: "A live, one-to-one demo made for your questions. Rigel listens, asks about your business, and shows " +
      "you the answer in Salesforce."
  };
  var WELCOME_PICK = "a";
  // The recording line above Join: RECORD_PICK, or ?rec=team|owner on the link to compare ("owner" is the owner's own wording).
  var RECORD_LINES = {
    team: "This demo is recorded so our team can review it.",
    owner: "This demo is recorded so the owner can review it."
  };
  var RECORD_PICK = "team";
  var MIC_OFF_DEMO = "Rigel cannot hear you: the microphone is off. Allow it for this page, then tap Unmute.";
  // Shown in place of the small status line when the Join tap's microphone request is refused.
  var MIC_HELP = "Rigel cannot hear you yet. Tap aA in the address bar, then Website Settings, then Microphone, then Allow. Then tap Try again.";
  // Shown instead when capture succeeded and publishing the track failed. Not browser-permission guidance.
  var MIC_CONNECT = "Could not connect your mic to the room. Tap Try again.";
  // The guest tells the room that remote audio is actually playing. An attribute is on the participant
  // (the host reads attributes the same way this page reads chair=ready). A JSON data message is the
  // same shape this page already uses for a topic (conf.typing): one small object, nothing else.
  var HEARING_TOPIC = "guest.hearing";
  var DEMO_IN_CALL = "You're in. Say hello to Rigel whenever you're ready.";
  var TAP_FOR_SOUND = "Tap to hear Rigel";
  var TAP_FOR_SCREEN = "Tap to show the screen";
  var SCREEN_START_MS = 4000;
  var RETRY_SOON_MS = 1500;

  var statusEl, stage, screenVideos, screenEmpty, people, muteBtn, leaveBtn, audioBin;
  var offerEl, roleEl, enterForm, codeInput;
  var demoEl, demoLine, endDemoBtn;
  var welcomeEl, welcomeNotice, consentLine, joinBtn, joinQuietBtn, soundBtn, fullBtn, tipEl, screenBox;
  var micHelp, micHelpCopy, micRetryBtn;
  var demo = null;
  // A demo pass link (?demo=1): the welcome comes first. recordChoice is the guest's answer: true, false, or null (not asked).
  var demoLinkOn = false;
  var recordChoice = null;
  var primedAudio = null;
  var joinUrl = "";
  var activeToken = "";
  var guestLabel = "Guest";
  var room = null;
  var joined = false;
  var left = false;
  var micOn = false;
  // The microphone asked for inside a Join tap. The room is made in that tap so startAudio() runs on the
  // same room that later connects. The track promise starts before any await. It is published once.
  var armedRoom = null;
  var micFromTap = false;
  var micRequest = null;
  var micSerial = 0;
  var micFailed = false;
  var heldMic = null;
  var micTrack = null;
  var micPublished = false;
  var micPublishTask = null;
  var hearingReported = false;
  var generation = 0;
  var retryTimer = 0;
  // The presenter's typing sound (guest-typing.js), made in this page only. Absent script: no sound, and nothing else changes.
  var typingSound = window.SFDC24GuestTyping ? new window.SFDC24GuestTyping.Typing(audioContext) : null;
  // The chair the typing packets are taken from: the first agent seen with chair=ready, pinned for the call (the console's rule).
  var typingChair = window.SFDC24GuestTyping ? new window.SFDC24GuestTyping.Chair() : null;
  var memoryDevice = "";
  var attached = typeof WeakSet === "function" ? new WeakSet() : null;
  var closedRooms = typeof WeakSet === "function" ? new WeakSet() : null;

  function hashToken() {
    var raw = "";
    try { raw = String(location.hash || ""); } catch (err) { return ""; }
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return "";
    try { raw = decodeURIComponent(raw.replace(/\+/g, "%2B")); } catch (err) {}
    if (!raw || !String(raw).replace(/\s+/g, "")) return "";
    return raw;
  }

  function inviteToken() {
    if (activeToken) return activeToken;
    return hashToken();
  }

  function searchText() {
    try { return String(location.search || ""); } catch (err) { return ""; }
  }

  // The one query value this page reads: a plain name=value pair, never a code (a code is only ever in the hash).
  function queryValue(name) {
    var parts = searchText().replace(/^\?/, "").split("&");
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split("=");
      if (pair[0] === name) return pair.length > 1 ? pair[1] : "";
    }
    return null;
  }

  function isDemoLink() {
    return queryValue("demo") === "1";
  }

  function welcomeLine() {
    var pick = String(queryValue("notice") || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(WELCOME_LINES, pick)) pick = WELCOME_PICK;
    return WELCOME_LINES[pick];
  }

  function recordLine() {
    var pick = String(queryValue("rec") || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(RECORD_LINES, pick)) pick = RECORD_PICK;
    return RECORD_LINES[pick];
  }

  // One audio context for the page, made and resumed inside the Join press: iOS Safari only lets sound start from a tap.
  function audioContext() {
    if (primedAudio) return primedAudio;
    var AC = window.AudioContext || window.webkitAudioContext;
    return AC ? new AC() : null;
  }

  function primeAudio() {
    unlockAudio();
    try {
      if (!primedAudio) primedAudio = audioContext();
      if (!primedAudio) return;
      if (primedAudio.resume) primedAudio.resume();
      var source = primedAudio.createBufferSource();
      source.buffer = primedAudio.createBuffer(1, 1, 22050);
      source.connect(primedAudio.destination);
      source.start(0);
    } catch (err) {}
  }

  function urlSafeId(length) {
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return "";
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var size = length || 24;
    var bytes = new Uint8Array(size);
    var i;
    try { window.crypto.getRandomValues(bytes); } catch (err) { return ""; }
    var out = "";
    for (i = 0; i < size; i++) out += alphabet.charAt(bytes[i] & 63);
    return out;
  }

  function deviceId() {
    var token = inviteToken();
    var existing = "";
    try {
      existing = sessionStorage.getItem(DEVICE_KEY) || "";
      // A refused write leaves the key empty. Keep the id already minted
      // for this tab instead of minting another one on the next retry.
      if (!existing) existing = memoryDevice;
    } catch (err) { existing = memoryDevice; }
    if (existing && existing !== token && ID_OK.test(existing)) {
      memoryDevice = existing;
      return existing;
    }
    var created = urlSafeId(24);
    if (!created || !ID_OK.test(created) || created === token) created = urlSafeId(32);
    if (!created || !ID_OK.test(created) || created === token) return "";
    memoryDevice = created;
    try { sessionStorage.setItem(DEVICE_KEY, created); } catch (err) {}
    return created;
  }

  function joinNonce() {
    var token = inviteToken();
    var nonce = urlSafeId(24);
    if (!nonce || nonce === token || !ID_OK.test(nonce)) nonce = urlSafeId(32);
    if (!nonce || nonce === token || !ID_OK.test(nonce)) return "";
    return nonce;
  }

  function silenceMediaLogs() {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.setLogLevel !== "function" || !LK.LogLevel) return;
    try { LK.setLogLevel(LK.LogLevel.silent); } catch (err) {}
  }

  function say(text) {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function clearCodeField() {
    if (codeInput) codeInput.value = "";
  }

  function showCodeStep() {
    clearCodeField();
    if (enterForm) enterForm.hidden = false;
    if (offerEl) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (statusEl) {
      statusEl.hidden = true;
      statusEl.textContent = "";
    }
    if (stage) stage.hidden = true;
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    if (welcomeEl) welcomeEl.hidden = true;
    hideMicPanel();
    hideDemo();
    if (codeInput) {
      try { codeInput.focus(); } catch (err) {}
    }
  }

  function showSession() {
    clearCodeField();
    if (enterForm) enterForm.hidden = true;
    if (welcomeEl) welcomeEl.hidden = true;
    // A demo link's welcome already said what this is: the general offer and role lines stay out of it.
    if (offerEl) offerEl.hidden = demoLinkOn;
    if (roleEl) roleEl.hidden = demoLinkOn;
    if (statusEl) statusEl.hidden = false;
  }

  // A demo link with a code: the welcome, its recording line, and Join / Join without recording. Nothing is posted yet.
  function showWelcome() {
    clearCodeField();
    recordChoice = null;
    if (enterForm) enterForm.hidden = true;
    if (offerEl) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (statusEl) {
      statusEl.hidden = true;
      statusEl.textContent = "";
    }
    hideMicPanel();
    if (welcomeNotice) welcomeNotice.textContent = welcomeLine();
    if (consentLine) consentLine.textContent = recordLine();
    if (welcomeEl) welcomeEl.hidden = false;
    if (joinBtn) {
      try { joinBtn.focus({ preventScroll: true }); } catch (err) {}
    }
  }

  function joinFromWelcome(record) {
    if (joined || !inviteToken()) return;
    // Microphone and startAudio before any await, so iOS counts this press as the user gesture.
    beginGestureMic();
    primeAudio();
    recordChoice = record;
    left = false;
    micOn = false;
    demo = null;
    hideDemo();
    clearRetry();
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    startJoin();
  }

  function offerCodeAgain() {
    // The invite was refused, or the room never connected. Drop the track this tap opened. A later Join is a new tap.
    releaseGestureMic();
    // A demo link keeps its code: the welcome comes back under the notice, so Join can be pressed again.
    if (demoLinkOn && inviteToken() && welcomeEl) {
      recordChoice = null;
      welcomeEl.hidden = false;
      return;
    }
    if (hashToken()) return;
    activeToken = "";
    clearCodeField();
    if (offerEl) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (enterForm) enterForm.hidden = false;
    if (codeInput) {
      try { codeInput.focus(); } catch (err) {}
    }
  }

  function showLeave() {
    if (demo || demoLinkOn) return;
    if (leaveBtn) leaveBtn.hidden = false;
  }

  // The page's look follows the seat: a live demo gets the bottom bar and the large screen (guest-room.css).
  function paintSeat(state) {
    var app = document.getElementById("guest");
    if (!app) return;
    app.setAttribute("data-seat", state || "");
    try { document.body.classList.toggle("guest-demo-live", state === "demo-live"); } catch (err) {}
  }

  // A shared screen the browser would not start on its own (iOS Low Power Mode, or a play() refused without a tap).
  function screenStuck() {
    var video = screenVideo();
    return !!(video && video.paused && video.getAttribute("data-guest-checked") === "1");
  }

  // One tap button for whatever the browser held back: the sound (canPlaybackAudio false), the screen (a paused video), or both.
  function paintSound(current) {
    if (!soundBtn) return;
    var audioHeld = !!(current && current.canPlaybackAudio === false);
    var videoHeld = screenStuck();
    soundBtn.hidden = !(current && activeCall(current) && (audioHeld || videoHeld));
    if (!soundBtn.hidden) soundBtn.textContent = videoHeld ? TAP_FOR_SCREEN : TAP_FOR_SOUND;
  }

  // A screen video gets a few seconds to start by itself; then, if it is still paused, the tap button offers to start it.
  function watchScreen(video, current) {
    function retry() { playEl(video); }
    try {
      video.addEventListener("loadedmetadata", retry);
      video.addEventListener("canplay", retry);
    } catch (err) {}
    setTimeout(function () {
      if (!activeCall(current) || !video.parentNode) return;
      video.setAttribute("data-guest-checked", "1");
      paintSound(current);
    }, SCREEN_START_MS);
  }

  function onSound() {
    var current = room;
    unlockAudio();
    setTimeout(function () { if (current && activeCall(current)) paintSound(current); }, 600);
    if (!current || typeof current.startAudio !== "function") return;
    try {
      var pending = current.startAudio();
      if (pending && typeof pending.then === "function") {
        pending.then(function () { paintSound(current); }, function () { paintSound(current); });
      } else {
        paintSound(current);
      }
    } catch (err) {}
  }

  function screenVideo() {
    return screenVideos ? screenVideos.querySelector("video") : null;
  }

  function paintScreen() {
    if (fullBtn) fullBtn.hidden = !screenVideo();
  }

  // Full screen: the whole shared screen where the browser allows it; on an iPhone only a video can go full screen.
  function onFull() {
    unlockAudio();
    var video = screenVideo();
    try {
      if (screenBox && typeof screenBox.requestFullscreen === "function") {
        var pending = screenBox.requestFullscreen();
        if (pending && typeof pending.catch === "function") pending.catch(function () {});
        return;
      }
      if (screenBox && typeof screenBox.webkitRequestFullscreen === "function") {
        screenBox.webkitRequestFullscreen();
        return;
      }
      if (video && typeof video.webkitEnterFullscreen === "function") video.webkitEnterFullscreen();
    } catch (err) {}
  }

  // The demo seat: the solo block's deadline, or null when this is not a demo pass.
  function demoOf(data) {
    var solo = data && data.solo;
    if (!solo || typeof solo !== "object") return null;
    if (typeof solo.deadline !== "number" || !isFinite(solo.deadline) || solo.deadline <= 0) return null;
    return { deadline: solo.deadline };
  }

  function endsAt(deadline) {
    var when = new Date(deadline * 1000);
    try {
      return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (err) {
      return when.toTimeString().slice(0, 5);
    }
  }

  // What the call line says about the recording: the guest's own answer when the welcome asked, else that it may be.
  function recordingWords() {
    if (recordChoice === false) return "Not recorded.";
    if (recordChoice === true) return "Recorded for review.";
    return "This call may be recorded.";
  }

  function showDemo() {
    if (!demo) return;
    if (demoLine) {
      demoLine.textContent = "Private demo. Ends at " + endsAt(demo.deadline) + " (" + DEMO_MAX_MINUTES +
        " min max). " + recordingWords();
    }
    if (demoEl) demoEl.hidden = false;
    if (leaveBtn) leaveBtn.hidden = true;
    if (endDemoBtn) endDemoBtn.hidden = false;
    if (tipEl) tipEl.hidden = false;
    paintSeat("demo-live");
  }

  function hideDemo() {
    if (demoEl) demoEl.hidden = true;
    if (demoLine) demoLine.textContent = "";
    if (endDemoBtn) endDemoBtn.hidden = true;
    if (tipEl) tipEl.hidden = true;
    if (soundBtn) soundBtn.hidden = true;
    hideMicPanel();
    paintSeat("");
  }

  // The demo is over (End Demo, or the room closed at its deadline): only a thank-you line stays.
  function showDemoEnded() {
    demo = null;
    hideDemo();
    paintSeat("demo-ended");
    if (enterForm) enterForm.hidden = true;
    if (welcomeEl) welcomeEl.hidden = true;
    if (offerEl && demoLinkOn) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    hideMicPanel();
    activeToken = "";
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) {}
    say(DEMO_ENDED);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
  }

  function scheduleRetry() {
    clearRetry();
    retryTimer = setTimeout(attempt, RETRY_MS);
  }

  // A phone that locked its screen, or a tab Safari put to sleep, holds its timers back: when the page is shown again
  // (visibilitychange, pageshow, focus, online), a waiting seat tries again within RETRY_SOON_MS instead of later.
  function onPageBack() {
    if (!retryTimer || joined || left) return;
    try { if (document.visibilityState && document.visibilityState !== "visible") return; } catch (err) {}
    clearRetry();
    retryTimer = setTimeout(attempt, RETRY_SOON_MS);
  }

  function errorText(text) {
    var raw = String(text || "").trim();
    try {
      var data = JSON.parse(raw);
      if (data && typeof data.error === "string") return data.error.trim();
    } catch (err) {}
    return raw;
  }

  function loopbackHost(hostname) {
    var host = String(hostname || "").toLowerCase();
    if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") host = host.slice(1, -1);
    if (host.length && host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  function localDevPage() {
    var protocol = "";
    var host = "";
    try {
      protocol = String(location.protocol || "");
      host = String(location.hostname || "");
    } catch (err) {
      return false;
    }
    return protocol === "http:" && loopbackHost(host);
  }

  function signalUrl(value) {
    var raw = String(value || "").trim();
    if (!raw || /\s/.test(raw)) return "";
    var parsed;
    try { parsed = new URL(raw); } catch (err) { return ""; }
    if (parsed.username || parsed.password) return "";
    var scheme = String(parsed.protocol || "").toLowerCase();
    var secure = scheme === "https:" || scheme === "wss:";
    var plain = scheme === "http:" || scheme === "ws:";
    if (!secure && !plain) return "";
    if (plain && (!localDevPage() || !loopbackHost(parsed.hostname))) return "";
    if (scheme === "https:") parsed.protocol = "wss:";
    else if (scheme === "http:") parsed.protocol = "ws:";
    var out = parsed.href;
    if (/\s/.test(out)) return "";
    if (secure && !/^wss:\/\//i.test(out)) return "";
    if (plain && !/^ws:\/\//i.test(out)) return "";
    return out;
  }

  function safeName(value) {
    var name = typeof value === "string" ? value.trim() : "";
    var token = inviteToken();
    if (!name || (token && name === token)) return "Guest";
    return name;
  }

  function mediaParts(data) {
    if (!data || typeof data !== "object") return null;
    var url = signalUrl(data.livekit_url);
    var token = typeof data.join_token === "string" ? data.join_token.trim() : "";
    if (!url || !token) return null;
    var seat = demoOf(data);
    // A demo pass's name is the host's label for the pass, not the guest's name: the seat stays "Guest".
    return { url: url, token: token, name: seat ? "Guest" : safeName(data.name), demo: seat };
  }

  function isLocalParticipant(participant) {
    if (!participant) return false;
    if (participant.isLocal) return true;
    return !!(room && participant === room.localParticipant);
  }

  function isScreenDevice(participant) {
    var id = participant && participant.identity ? String(participant.identity) : "";
    return id.indexOf("scr_") === 0 || id.indexOf("prs_") === 0;
  }

  function isBinder(participant) {
    var id = participant && participant.identity ? String(participant.identity) : "";
    return id.indexOf("bnd_") === 0;
  }

  function personKey(participant) {
    if (isLocalParticipant(participant)) return "local";
    var id = participant && participant.identity ? String(participant.identity) : "";
    var token = inviteToken();
    if (!id || (token && id === token)) return "guest";
    return id;
  }

  function labelFor(participant) {
    if (isLocalParticipant(participant)) return guestLabel;
    var token = inviteToken();
    var name = participant && participant.name ? String(participant.name).trim() : "";
    if (name && name !== token) return name;
    var id = participant && participant.identity ? String(participant.identity) : "";
    if (id && id !== token) return id;
    return "Guest";
  }

  function safeFrom(participant) {
    var id = participant && participant.identity ? String(participant.identity) : "";
    var token = inviteToken();
    if (!id || (token && id === token)) return "";
    return id;
  }

  function findPerson(key) {
    if (!people) return null;
    var nodes = people.children;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute("data-person") === key) return nodes[i];
    }
    return null;
  }

  function ensurePerson(participant) {
    if (!participant || !people || isScreenDevice(participant) || isBinder(participant)) return null;
    var key = personKey(participant);
    var existing = findPerson(key);
    if (existing) return existing;
    var block = document.createElement("div");
    block.className = "guest-person";
    block.setAttribute("role", "listitem");
    block.setAttribute("data-person", key);
    var slot = document.createElement("div");
    slot.className = "guest-person-video";
    var name = document.createElement("span");
    name.textContent = labelFor(participant);
    block.appendChild(slot);
    block.appendChild(name);
    people.appendChild(block);
    return block;
  }

  function playEl(el) {
    try {
      var pending = el.play();
      if (pending && typeof pending.then === "function") {
        pending.then(function () {
          // play() resolved and the element is not paused: remote audio is actually playing.
          if (!el || !el.getAttribute || el.getAttribute("data-guest-audio") !== "1") return;
          if (el.paused === false && room && activeCall(room)) reportHearing(room);
        }, function () {});
      }
    } catch (err) {}
  }

  function unlockAudio() {
    if (!audioBin && !screenVideos) return;
    var nodes = [];
    if (audioBin) nodes = nodes.concat([].slice.call(audioBin.querySelectorAll("audio")));
    if (screenVideos) nodes = nodes.concat([].slice.call(screenVideos.querySelectorAll("video")));
    for (var i = 0; i < nodes.length; i++) playEl(nodes[i]);
  }

  function markAttached(track) {
    if (!track) return false;
    if (attached && attached.has(track)) return false;
    if (attached) attached.add(track);
    return true;
  }

  function onSubscribed(track, publication, participant) {
    if (!track || isLocalParticipant(participant) || isBinder(participant)) return;
    var kind = String(track.kind || "");
    if (kind === "video" && !isScreenDevice(participant)) return;
    if (!markAttached(track)) return;
    if (kind === "audio") {
      var audio = track.attach();
      audio.autoplay = true;
      audio.setAttribute("data-guest-audio", "1");
      var heardRoom = room;
      try {
        audio.addEventListener("playing", function () {
          if (activeCall(heardRoom)) reportHearing(heardRoom);
        });
      } catch (err) {}
      if (audioBin) audioBin.appendChild(audio);
      playEl(audio);
      if (!isScreenDevice(participant)) ensurePerson(participant);
      return;
    }
    if (kind !== "video") return;
    var video = track.attach();
    // iOS Safari plays a video without a tap only when it is muted and inline, as attributes as well as properties,
    // and only while it is visible: the stage is shown before the room connects (connect), so it never lands hidden.
    video.muted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.autoplay = true;
    video.setAttribute("autoplay", "");
    video.setAttribute("data-guest-video", "1");
    var from = safeFrom(participant);
    if (from) video.setAttribute("data-from", from);
    if (screenVideos) screenVideos.appendChild(video);
    if (screenEmpty) screenEmpty.hidden = true;
    paintScreen();
    playEl(video);
    if (room) watchScreen(video, room);
  }

  function onUnsubscribed(track) {
    if (attached && track) attached.delete(track);
    var els = [];
    try { els = (track && track.detach && track.detach()) || []; } catch (err) { els = []; }
    for (var i = 0; i < els.length; i++) {
      if (els[i] && els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    if (screenVideos && screenEmpty && !screenVideos.querySelector("video")) screenEmpty.hidden = false;
    paintScreen();
  }

  function onParticipant(participant) {
    if (isBinder(participant)) return;
    if (!isScreenDevice(participant)) ensurePerson(participant);
  }

  function onParticipantGone(participant) {
    var block = findPerson(personKey(participant));
    if (block && block.parentNode) block.parentNode.removeChild(block);
    var from = safeFrom(participant);
    if (from && screenVideos) {
      var vids = screenVideos.querySelectorAll("video");
      for (var i = 0; i < vids.length; i++) {
        if (vids[i].getAttribute("data-from") === from && vids[i].parentNode) vids[i].parentNode.removeChild(vids[i]);
      }
    }
    if (screenVideos && screenEmpty && !screenVideos.querySelector("video")) screenEmpty.hidden = false;
    paintScreen();
  }

  function noteClosed(next) {
    if (next && closedRooms) closedRooms.add(next);
  }

  function isClosed(next) {
    return !!(next && closedRooms && closedRooms.has(next));
  }

  function activeCall(next) {
    return !left && room === next && !isClosed(next);
  }

  function onDisconnected() {
    if (left) return;
    var ended = room;
    noteClosed(ended);
    joined = false;
    micOn = false;
    if (room === ended) room = null;
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    releaseGestureMic();
    if (demo) {
      left = true;
      clearRetry();
      showDemoEnded();
      return;
    }
    say("The call ended.");
    showLeave();
  }

  function bind(next) {
    var ev = (window.LivekitClient && window.LivekitClient.RoomEvent) || {};
    function live() { return activeCall(next); }
    next.on(ev.TrackSubscribed || "trackSubscribed", function (track, publication, participant) {
      if (!live()) return;
      onSubscribed(track, publication, participant);
    });
    next.on(ev.TrackUnsubscribed || "trackUnsubscribed", function (track) {
      if (!live()) return;
      onUnsubscribed(track);
    });
    next.on(ev.ParticipantConnected || "participantConnected", function (participant) {
      if (!live()) return;
      if (typingChair) typingChair.see(participant);
      onParticipant(participant);
    });
    next.on(ev.ParticipantAttributesChanged || "participantAttributesChanged", function (changed, participant) {
      if (!live() || !typingChair) return;
      typingChair.see(participant);
    });
    next.on(ev.ParticipantDisconnected || "participantDisconnected", function (participant) {
      if (!live()) return;
      onParticipantGone(participant);
    });
    next.on(ev.Disconnected || "disconnected", function () {
      if (room !== next || left) return;
      onDisconnected();
    });
    // The typing sound while the presenter works (guest-typing.js): a boolean from the chair only, silent while anyone speaks.
    next.on(ev.DataReceived || "dataReceived", function (payload, participant, kind, topic) {
      if (!live() || !typingSound || topic !== window.SFDC24GuestTyping.TOPIC) return;
      if (!typingChair || !typingChair.obeys(participant)) return;
      var on = window.SFDC24GuestTyping.readOn(payload);
      if (on !== null) typingSound.set(on);
    });
    next.on(ev.ActiveSpeakersChanged || "activeSpeakersChanged", function (speakers) {
      if (!live() || !typingSound) return;
      typingSound.duck(!!(speakers && speakers.length));
    });
    // The browser blocked sound (an iPhone without a tap that counts): one button starts it (room.startAudio).
    next.on(ev.AudioPlaybackStatusChanged || "audioPlaybackChanged", function () {
      if (!live()) return;
      paintSound(next);
      reportHearingIfPlaying(next);
    });
  }

  function pullExisting(next) {
    var remotes = next.remoteParticipants;
    if (!remotes || typeof remotes.forEach !== "function") return;
    remotes.forEach(function (participant) {
      if (typingChair) typingChair.see(participant);
      if (isBinder(participant)) return;
      if (!isScreenDevice(participant)) ensurePerson(participant);
      [participant.audioTrackPublications, participant.videoTrackPublications].forEach(function (map) {
        if (!map || typeof map.forEach !== "function") return;
        map.forEach(function (pub) {
          var track = pub && (pub.track || pub.audioTrack || pub.videoTrack);
          if (track) onSubscribed(track, pub, participant);
        });
      });
    });
  }

  function paintMute() {
    if (!muteBtn) return;
    muteBtn.hidden = !joined;
    var live = !!micOn;
    muteBtn.textContent = live ? "Mic live" : "Mic muted";
    muteBtn.setAttribute("data-mic", live ? "live" : "muted");
    muteBtn.setAttribute("aria-pressed", live ? "false" : "true");
    muteBtn.setAttribute("aria-label", live ? "Microphone is live" : "Microphone is muted");
  }

  function clearStage() {
    if (typingSound) typingSound.reset();
    if (typingChair) typingChair.reset();
    if (screenVideos) screenVideos.textContent = "";
    if (people) people.textContent = "";
    if (audioBin) audioBin.textContent = "";
    if (screenEmpty) screenEmpty.hidden = false;
    if (stage) stage.hidden = true;
    paintScreen();
  }

  function inCallWords() {
    return demo ? DEMO_IN_CALL : "In the call.";
  }

  function micOffWords() {
    return demo ? MIC_OFF_DEMO : "In the call. The microphone is off.";
  }

  function hideMicPanel() {
    if (micHelp) micHelp.hidden = true;
  }

  function showMicPanel(copy) {
    if (micHelpCopy) micHelpCopy.textContent = copy || MIC_HELP;
    if (micHelp) micHelp.hidden = false;
    if (statusEl) statusEl.hidden = true;
  }

  function stopTrack(track) {
    if (!track || typeof track.stop !== "function") return;
    try { track.stop(); } catch (err) {}
  }

  // A room made in the tap, with the same capture defaults connect() uses, so startAudio() and the later connect
  // are the same room. No adaptive stream: it would pause the one screen the guest is watching.
  function makeRoom() {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.Room !== "function") return null;
    silenceMediaLogs();
    return new LK.Room({
      adaptiveStream: false,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  function ensureArmedRoom() {
    if (room && !isClosed(room)) return room;
    if (armedRoom && !isClosed(armedRoom)) return armedRoom;
    var next = makeRoom();
    if (!next) return null;
    armedRoom = next;
    bind(next);
    return next;
  }

  // createLocalAudioTrack, or getUserMedia({audio:true}) when that export is missing. Called with no await before it.
  function requestLocalMic() {
    var LK = window.LivekitClient;
    var opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (LK && typeof LK.createLocalAudioTrack === "function") {
      try {
        var created = LK.createLocalAudioTrack(opts);
        if (created && typeof created.then === "function") return created;
        return Promise.resolve(created);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    var devices = navigator.mediaDevices;
    if (devices && typeof devices.getUserMedia === "function") {
      try {
        return devices.getUserMedia({ audio: true }).then(function (stream) {
          var native = stream && typeof stream.getAudioTracks === "function" ? stream.getAudioTracks()[0] : null;
          if (!native) throw new Error("mic");
          if (LK && typeof LK.LocalAudioTrack === "function") {
            try { return new LK.LocalAudioTrack(native, opts); } catch (err) {}
          }
          return {
            kind: "audio",
            mediaStreamTrack: native,
            stop: function () { try { native.stop(); } catch (err) {} }
          };
        });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return Promise.reject(new Error("mic"));
  }

  function beginMicRequest() {
    if (micPublished) return micSerial;
    var serial = ++micSerial;
    var previous = heldMic;
    heldMic = null;
    if (previous) stopTrack(previous);
    micPublishTask = null;
    var pending = requestLocalMic();
    micRequest = pending;
    micFailed = false;
    pending.then(function (track) {
      if (serial !== micSerial) {
        stopTrack(track);
        return;
      }
      heldMic = track;
    }, function () {
      if (serial !== micSerial) return;
      micFailed = true;
      heldMic = null;
    });
    return serial;
  }

  // Join tap, before any await: ask for the microphone, then start audio on the room that will connect.
  function beginGestureMic() {
    micFromTap = true;
    var next = ensureArmedRoom();
    if (!micRequest || micFailed) beginMicRequest();
    if (next && typeof next.startAudio === "function") {
      try {
        var started = next.startAudio();
        if (started && typeof started.catch === "function") started.catch(function () {});
      } catch (err) {}
    }
  }

  function releaseGestureMic() {
    micSerial += 1;
    stopTrack(heldMic);
    stopTrack(micTrack);
    heldMic = null;
    micTrack = null;
    micRequest = null;
    micFailed = false;
    micPublished = false;
    micPublishTask = null;
    micFromTap = false;
    var extra = armedRoom;
    armedRoom = null;
    if (extra && extra !== room) {
      try { if (typeof extra.disconnect === "function") extra.disconnect(); } catch (err) {}
    }
    hideMicPanel();
  }

  function publishOnce(next, track) {
    if (micPublished) return Promise.resolve();
    if (micPublishTask) return micPublishTask;
    if (!track || !next || !next.localParticipant || typeof next.localParticipant.publishTrack !== "function") {
      return Promise.reject(new Error("mic"));
    }
    var pending;
    try { pending = next.localParticipant.publishTrack(track); } catch (err) { return Promise.reject(err); }
    micTrack = track;
    var task = Promise.resolve(pending).then(function () {
      if (!activeCall(next)) return;
      micPublished = true;
      micOn = true;
      paintMute();
    }, function (err) {
      if (micPublishTask === task) micPublishTask = null;
      if (micTrack === track) micTrack = null;
      return Promise.reject(err);
    });
    micPublishTask = task;
    return task;
  }

  function settleTapMic(next) {
    var pending = micRequest;
    var serial = micSerial;
    if (!pending) {
      if (!activeCall(next)) return Promise.resolve();
      micOn = false;
      paintMute();
      showMicPanel();
      return Promise.resolve();
    }
    return pending.then(function (track) {
      if (serial !== micSerial || !activeCall(next)) {
        if (serial !== micSerial) stopTrack(track);
        return;
      }
      return publishOnce(next, track);
    }).then(function () {
      if (!activeCall(next) || !micPublished) return;
      hideMicPanel();
      say(inCallWords());
    }, function () {
      if (serial !== micSerial || !activeCall(next)) return;
      micOn = false;
      paintMute();
      showMicPanel();
    });
  }

  // Try again is its own tap: the microphone request starts here, before any await, then that track is published.
  function onMicRetry() {
    if (micPublished || micPublishTask) return;
    var next = ensureArmedRoom();
    // Ask first. startAudio and play() also touch audio, and this request has to begin in the tap.
    var serial = beginMicRequest();
    if (next && typeof next.startAudio === "function") {
      try {
        var started = next.startAudio();
        if (started && typeof started.catch === "function") started.catch(function () {});
      } catch (err) {}
    }
    unlockAudio();
    var pending = micRequest;
    if (!pending) return;
    pending.then(function (track) {
      if (serial !== micSerial || !next || !activeCall(next)) {
        if (serial !== micSerial) stopTrack(track);
        return;
      }
      return publishOnce(next, track).then(function () {
        if (!activeCall(next) || !micPublished) return;
        hideMicPanel();
        micOn = true;
        paintMute();
        say(inCallWords());
      }).catch(function () {
        if (serial !== micSerial || !next || !activeCall(next) || micPublished) return;
        if (heldMic === track) heldMic = null;
        stopTrack(track);
        micOn = false;
        paintMute();
        showMicPanel(MIC_CONNECT);
      });
    }, function () {
      if (serial !== micSerial || !next || !activeCall(next)) return;
      micOn = false;
      paintMute();
      showMicPanel();
    });
  }

  function reportHearing(current) {
    if (!current || hearingReported || !activeCall(current)) return;
    var local = current.localParticipant;
    if (!local) return;
    hearingReported = true;
    if (typeof local.setAttributes === "function") {
      try {
        var attrs = local.setAttributes({ hearing: "yes" });
        if (attrs && typeof attrs.catch === "function") attrs.catch(function () {});
      } catch (err) {}
    }
    if (typeof local.publishData === "function") {
      try {
        var payload = JSON.stringify({ playing: true });
        var bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(payload) : payload;
        var sent = local.publishData(bytes, { reliable: true, topic: HEARING_TOPIC });
        if (sent && typeof sent.catch === "function") sent.catch(function () {});
      } catch (err) {}
    }
  }

  function reportHearingIfPlaying(current) {
    if (!audioBin || !activeCall(current)) return;
    var nodes = audioBin.querySelectorAll("audio");
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].paused === false) reportHearing(current);
    }
  }

  function connect(media) {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.Room !== "function") {
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
      return;
    }
    silenceMediaLogs();
    joined = true;
    clearRetry();
    hearingReported = false;
    guestLabel = media.name || "Guest";
    demo = media.demo || null;
    var next = null;
    var fresh = false;
    if (armedRoom && !isClosed(armedRoom)) {
      next = armedRoom;
      armedRoom = null;
    } else {
      next = makeRoom();
      fresh = true;
    }
    if (!next) {
      joined = false;
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
      return;
    }
    if (fresh) bind(next);
    room = next;
    // The stage is up while the room connects: a screen that is already shared arrives during connect, and iOS Safari
    // never starts a video that lands in a hidden box. The status says what is happening, not the last wait.
    if (stage) stage.hidden = false;
    say(demo ? "Joining your demo." : "Joining the call.");
    var fromTap = micFromTap;
    return next.connect(media.url, media.token).then(function () {
      if (!activeCall(next)) {
        if (!isClosed(next)) {
          try { next.disconnect(); } catch (err) {}
        }
        return;
      }
      if (stage) stage.hidden = false;
      showLeave();
      showDemo();
      ensurePerson(next.localParticipant);
      pullExisting(next);
      paintSound(next);
      // The tap already asked for one track. Publish that track. setMicrophoneEnabled(true) would open a second one,
      // and it would run outside the tap. A join that had no tap (a link that joins on its own) still enables here.
      if (fromTap) return settleTapMic(next);
      say(inCallWords());
      return next.localParticipant.setMicrophoneEnabled(true).then(function () {
        if (!activeCall(next)) return;
        micOn = true;
        paintMute();
      }, function () {
        if (!activeCall(next)) return;
        micOn = false;
        paintMute();
        say(micOffWords());
      });
    }, function () {
      if (!activeCall(next)) return;
      if (room === next) room = null;
      joined = false;
      demo = null;
      hideDemo();
      clearStage();
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
    });
  }

  function attempt() {
    if (left || joined || !joinUrl) return;
    var code = inviteToken();
    if (!code) {
      showCodeStep();
      return;
    }
    var gen = ++generation;
    var device = deviceId();
    var nonce = joinNonce();
    if (!device || !nonce) {
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
      return;
    }
    var payload = { code: code, device: device, join_nonce: nonce };
    // The demo welcome's answer: false is "Join without recording", and the guest door turns the call's recording off.
    if (recordChoice === true || recordChoice === false) payload.record = recordChoice;
    fetch(joinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      return res.text().then(function (text) {
        if (left || gen !== generation) return;
        var message = errorText(text);
        if ((res.status === 403 || res.status === 409 || res.status === 503) && DEMO_NOTICES.indexOf(message) !== -1) {
          say(message);
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 409 && message === NOT_STARTED) {
          say("The call has not started. Waiting.");
          showLeave();
          scheduleRetry();
          return;
        }
        if (res.status === 409 && message === CALL_FULL) {
          say("The call is full.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 403) {
          say("This invite is not valid.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 429) {
          say("Too many invalid codes. Wait ten minutes.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 503) {
          say("The call could not be reached.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (!res.ok) {
          say("The call could not be joined.");
          showLeave();
          offerCodeAgain();
          return;
        }
        var data = null;
        try { data = JSON.parse(text); } catch (err) { data = null; }
        if (data && typeof data.role === "string" && data.role.trim() === "presenter") {
          say("This page is for guests. A presenter cannot join here.");
          showLeave();
          offerCodeAgain();
          return;
        }
        var media = mediaParts(data);
        if (!media) {
          say("The call could not be joined.");
          showLeave();
          offerCodeAgain();
          return;
        }
        return connect(media);
      });
    }).catch(function () {
      if (left || gen !== generation) return;
      say("The call could not be reached.");
      showLeave();
      offerCodeAgain();
    });
  }

  function onMute() {
    // Nothing is published yet. This press is a user gesture, so it asks again the same way Try again does,
    // before play() or anything else. setMicrophoneEnabled(true) would open a second track.
    if (room && joined && room.localParticipant && micFromTap && !micPublished) {
      onMicRetry();
      return;
    }
    unlockAudio();
    if (!room || !joined || !room.localParticipant) return;
    var next = !micOn;
    var current = room;
    room.localParticipant.setMicrophoneEnabled(next).then(function () {
      if (!activeCall(current)) return;
      micOn = next;
      paintMute();
      if (!joined) return;
      if (micOn) hideMicPanel();
      say(inCallWords());
    }, function () {
      if (!activeCall(current)) return;
      micOn = false;
      paintMute();
      if (micFromTap) showMicPanel();
      else say(micOffWords());
    });
  }

  function leave() {
    if (left) return;
    left = true;
    joined = false;
    micOn = false;
    clearRetry();
    generation += 1;
    var current = room;
    room = null;
    releaseGestureMic();
    if (current && current.localParticipant) {
      try { current.localParticipant.setMicrophoneEnabled(false); } catch (err) {}
    }
    if (current && typeof current.disconnect === "function") {
      try { current.disconnect(); } catch (err) {}
    }
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    demo = null;
    activeToken = "";
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) {}
    showCodeStep();
    say("Left the call.");
  }

  // End Demo: the same clean exit as Leave (microphone off, disconnect), then the thank-you line, not the code box.
  function endDemo() {
    if (left) return;
    left = true;
    joined = false;
    micOn = false;
    clearRetry();
    generation += 1;
    var current = room;
    room = null;
    releaseGestureMic();
    if (current && current.localParticipant) {
      try { current.localParticipant.setMicrophoneEnabled(false); } catch (err) {}
    }
    if (current && typeof current.disconnect === "function") {
      try { current.disconnect(); } catch (err) {}
    }
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    showDemoEnded();
  }

  function loadConfig() {
    return fetch("/data/guest-join.json", { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res.ok) throw new Error("config");
      return res.json();
    }).then(function (data) {
      var raw = data && typeof data.serviceUrl === "string" ? data.serviceUrl.trim() : "";
      var parsed;
      try { parsed = new URL(raw); } catch (err) { throw new Error("config"); }
      if (parsed.protocol !== "https:") throw new Error("config");
      if (parsed.username || parsed.password) throw new Error("config");
      if (parsed.search || parsed.hash) throw new Error("config");
      if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error("config");
      return parsed.origin + JOIN_PATH;
    });
  }

  function startJoin() {
    showSession();
    say("Checking the invite.");
    if (!joinUrl) {
      var gen = ++generation;
      loadConfig().then(function (url) {
        if (left || gen !== generation) return;
        joinUrl = url;
        attempt();
      }, function () {
        if (left || gen !== generation) return;
        say("The call could not be reached.");
        showLeave();
        offerCodeAgain();
      });
      return;
    }
    attempt();
  }

  function onEnter(event) {
    unlockAudio();
    if (event && event.preventDefault) event.preventDefault();
    if (joined) return;
    var typed = codeInput ? String(codeInput.value || "") : "";
    if (!typed.trim()) return;
    left = false;
    joined = false;
    micOn = false;
    demo = null;
    hideDemo();
    clearRetry();
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    activeToken = typed;
    if (demoLinkOn && welcomeEl) {
      showWelcome();
      return;
    }
    // The code box's Join is a tap too. Ask before startJoin awaits the invite.
    beginGestureMic();
    startJoin();
  }

  function followHash() {
    var fromHash = hashToken();
    if (!fromHash || joined || fromHash === activeToken) return;
    left = false;
    micOn = false;
    demo = null;
    hideDemo();
    clearRetry();
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    activeToken = fromHash;
    if (demoLinkOn && welcomeEl) {
      showWelcome();
      return;
    }
    startJoin();
  }

  function boot() {
    statusEl = document.getElementById("guest-status");
    stage = document.getElementById("guest-stage");
    screenVideos = document.getElementById("guest-screen-videos");
    screenEmpty = document.getElementById("guest-screen-empty");
    people = document.getElementById("guest-people");
    muteBtn = document.getElementById("guest-mute");
    leaveBtn = document.getElementById("guest-leave");
    audioBin = document.getElementById("guest-audio");
    offerEl = document.getElementById("guest-offer");
    roleEl = document.getElementById("guest-role");
    enterForm = document.getElementById("guest-enter");
    codeInput = document.getElementById("guest-code");
    demoEl = document.getElementById("guest-demo");
    demoLine = document.getElementById("guest-demo-line");
    endDemoBtn = document.getElementById("guest-end-demo");
    welcomeEl = document.getElementById("guest-welcome");
    welcomeNotice = document.getElementById("guest-welcome-notice");
    consentLine = document.getElementById("guest-consent-line");
    joinBtn = document.getElementById("guest-join");
    joinQuietBtn = document.getElementById("guest-join-quiet");
    soundBtn = document.getElementById("guest-sound");
    fullBtn = document.getElementById("guest-screen-full");
    tipEl = document.getElementById("guest-screen-tip");
    screenBox = document.getElementById("guest-screen");
    micHelp = document.getElementById("guest-mic-help");
    micHelpCopy = document.getElementById("guest-mic-help-copy");
    micRetryBtn = document.getElementById("guest-mic-retry");
    if (micHelpCopy) micHelpCopy.textContent = MIC_HELP;
    if (!statusEl || !stage || !muteBtn || !leaveBtn || !enterForm || !codeInput) return;
    // The welcome needs both of its buttons; without them a demo link joins as any link does.
    if (!joinBtn || !joinQuietBtn) welcomeEl = null;
    demoLinkOn = isDemoLink() && !!welcomeEl;
    silenceMediaLogs();
    muteBtn.addEventListener("click", onMute);
    if (micRetryBtn) micRetryBtn.addEventListener("click", onMicRetry);
    leaveBtn.addEventListener("click", leave);
    if (endDemoBtn) endDemoBtn.addEventListener("click", endDemo);
    if (joinBtn) joinBtn.addEventListener("click", function () { joinFromWelcome(true); });
    if (joinQuietBtn) joinQuietBtn.addEventListener("click", function () { joinFromWelcome(false); });
    if (soundBtn) soundBtn.addEventListener("click", onSound);
    if (fullBtn) fullBtn.addEventListener("click", onFull);
    enterForm.addEventListener("submit", onEnter);
    window.addEventListener("hashchange", followHash);
    document.addEventListener("click", unlockAudio);
    document.addEventListener("visibilitychange", onPageBack);
    window.addEventListener("pageshow", onPageBack);
    window.addEventListener("focus", onPageBack);
    window.addEventListener("online", onPageBack);
    var fromHash = hashToken();
    if (!fromHash) {
      activeToken = "";
      showCodeStep();
      return;
    }
    activeToken = fromHash;
    if (demoLinkOn) {
      showWelcome();
      return;
    }
    startJoin();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
