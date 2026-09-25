/* Homepage voice conversation.
   A visitor speaks and hears the agent answer. The microphone and the
   realtime call stay up across turns until End conversation.
   The host mounts this next to the ask bar and supplies the operator token.
   This file does not read the ask bar and does not touch studio/studio.js.

   mount(rootElement, {controllerUrl, getOperatorToken, captions})
   captions is optional. When true, the latest line replaces a single caption.
   There is no transcript. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SFDC24VoiceConversation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var globalRef = typeof globalThis !== "undefined" ? globalThis : window;
  var mountCount = 0;

  function randomId() {
    var bytes = new Uint8Array(16);
    if (globalRef.crypto && globalRef.crypto.getRandomValues) globalRef.crypto.getRandomValues(bytes);
    else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = "";
    for (var j = 0; j < bytes.length; j++) {
      var piece = bytes[j].toString(16);
      hex += piece.length === 1 ? "0" + piece : piece;
    }
    return hex;
  }

  function parseJson(text) {
    if (!text) return {};
    try {
      var body = JSON.parse(text);
      return body && typeof body === "object" ? body : {};
    } catch (err) {
      return {};
    }
  }

  function isInt(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0;
  }

  function ensureStyle() {
    if (document.getElementById("voice-conversation-style")) return;
    var style = document.createElement("style");
    style.id = "voice-conversation-style";
    style.textContent = [
      "[data-voice-conversation]{box-sizing:border-box;width:100%;max-width:100%;min-width:0;",
      "margin-top:12px;color:#191919;font-size:16px;line-height:1.4;font-family:inherit}",
      "[data-voice-conversation] *,[data-voice-conversation] *::before,[data-voice-conversation] *::after{box-sizing:border-box}",
      "[data-voice-conversation] [hidden]{display:none !important}",
      "[data-voice-conversation] .voice-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}",
      "[data-voice-conversation] button{margin:0;min-height:44px;max-width:100%;padding:8px 14px;",
      "border:1px solid #767676;border-radius:4px;background:#fff;color:#191919;",
      "font:inherit;font-size:16px;cursor:pointer}",
      "[data-voice-conversation] button:focus-visible{outline:2px solid #191919;outline-offset:2px}",
      "[data-voice-conversation] [data-voice-status]{margin:8px 0 0;min-width:0;overflow-wrap:anywhere;color:#191919}",
      "[data-voice-conversation] [data-voice-caption]{margin:4px 0 0;min-width:0;overflow-wrap:anywhere;color:#666}",
      "[data-voice-conversation] fieldset{margin:0 0 8px;padding:0;border:0;min-width:0}",
      "[data-voice-conversation] .voice-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
      "[data-voice-conversation] label{display:inline-flex;align-items:center;gap:6px;margin-right:12px;color:#191919}",
      "[data-voice-conversation] audio{display:none}"
    ].join("");
    document.head.appendChild(style);
  }

  function mount(rootElement, options) {
    var opts = options || {};
    var controllerUrl = String(opts.controllerUrl || "").replace(/\/+$/, "");
    var showCaptions = opts.captions === true;
    var agentName = "voice-agent-" + (++mountCount);
    var epoch = 0;
    var phase = "idle";
    var session = null;
    var creationId = "";
    var agent = "claude";
    var agents = [];
    var voiceAllowed = false;
    var pc = null;
    var channel = null;
    var stream = null;
    var speaking = null;
    var speech = [];
    var turn = 0;
    var hearing = false;
    var history = [];
    var uttered = {};
    var partials = {};
    var stopSent = false;
    var reconnects = 0;
    var reconnectTimer = null;
    var endTimer = null;
    var offerWait = null;

    ensureStyle();
    rootElement.textContent = "";
    var box = document.createElement("div");
    box.setAttribute("data-voice-conversation", "");
    box.innerHTML = [
      "<fieldset data-voice-agent hidden>",
      "<legend class=\"voice-sr\">Agent</legend>",
      "<label><input type=\"radio\" name=\"" + agentName + "\" value=\"claude\" data-voice-agent-choice checked> Claude</label>",
      "<label><input type=\"radio\" name=\"" + agentName + "\" value=\"openai\" data-voice-agent-choice> OpenAI</label>",
      "</fieldset>",
      "<div class=\"voice-row\">",
      "<button type=\"button\" data-voice-start hidden>Start conversation</button>",
      "<button type=\"button\" data-voice-end hidden>End conversation</button>",
      "</div>",
      "<p data-voice-status role=\"status\"></p>",
      "<p data-voice-caption hidden></p>",
      "<audio data-voice-audio autoplay></audio>"
    ].join("");
    rootElement.appendChild(box);

    var startButton = box.querySelector("[data-voice-start]");
    var endButton = box.querySelector("[data-voice-end]");
    var statusNode = box.querySelector("[data-voice-status]");
    var captionNode = box.querySelector("[data-voice-caption]");
    var agentField = box.querySelector("[data-voice-agent]");
    var audioNode = box.querySelector("[data-voice-audio]");

    function setStatus(message) {
      statusNode.textContent = message || "";
    }

    function setCaption(text) {
      if (!showCaptions) return;
      var words = String(text || "").trim();
      captionNode.textContent = words;
      captionNode.hidden = !words;
    }

    function chosenAgent() {
      if (agents.length === 1) return agents[0];
      var checked = box.querySelector("[data-voice-agent-choice]:checked");
      var value = checked ? String(checked.value) : "";
      if (value === "openai" || value === "claude") {
        if (!agents.length || agents.indexOf(value) >= 0) return value;
      }
      if (agents.indexOf("claude") >= 0) return "claude";
      if (agents.indexOf("openai") >= 0) return "openai";
      return "claude";
    }

    function syncChrome() {
      var calling = phase === "connecting" || phase === "open";
      startButton.hidden = !voiceAllowed || calling;
      endButton.hidden = !session;
      agentField.hidden = agents.length < 2 || (!voiceAllowed && !session);
      var choices = box.querySelectorAll("[data-voice-agent-choice]");
      for (var i = 0; i < choices.length; i++) choices[i].disabled = phase !== "idle";
    }

    function stopTracks(media) {
      if (!media || typeof media.getTracks !== "function") return;
      var tracks = media.getTracks();
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (err) { /* already stopped */ }
      }
    }

    function clearTimers() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (endTimer) clearTimeout(endTimer);
      reconnectTimer = null;
      endTimer = null;
      if (offerWait) offerWait();
      offerWait = null;
    }

    function detachPeer(stopMic) {
      clearTimers();
      speech = [];
      speaking = null;
      hearing = false;
      var oldChannel = channel;
      var oldPc = pc;
      channel = null;
      pc = null;
      if (oldChannel) {
        try { oldChannel.onmessage = null; } catch (err) { /* already dropped */ }
        try { oldChannel.onopen = null; } catch (err) { /* already dropped */ }
        try { oldChannel.onclose = null; } catch (err) { /* already dropped */ }
        try { if (typeof oldChannel.close === "function") oldChannel.close(); } catch (err) { /* already closed */ }
      }
      if (oldPc) {
        try { oldPc.ontrack = null; } catch (err) { /* already dropped */ }
        try { oldPc.onconnectionstatechange = null; } catch (err) { /* already dropped */ }
        try { oldPc.close(); } catch (err) { /* already closed */ }
      }
      var remote = audioNode.srcObject;
      try { audioNode.srcObject = null; } catch (err) { /* unsupported */ }
      stopTracks(remote);
      if (stopMic) {
        stopTracks(stream);
        stream = null;
      }
    }

    function forgetSession() {
      session = null;
      creationId = "";
      stopSent = false;
      turn = 0;
      history = [];
      uttered = {};
      partials = {};
      reconnects = 0;
    }

    function endConversation(message) {
      var had = session;
      var body = null;
      if (had && !stopSent) {
        stopSent = true;
        body = {
          command_id: "cmd-" + randomId(),
          session_id: had.id,
          type: "stop",
          expected_version: had.version
        };
      }
      var token = had ? had.token : "";
      var sessionId = had ? had.id : "";
      epoch += 1;
      phase = "idle";
      detachPeer(true);
      forgetSession();
      setCaption("");
      setStatus(message || "Voice ended.");
      syncChrome();
      if (!body || !controllerUrl) return;
      fetch(controllerUrl + "/v1/session/" + encodeURIComponent(sessionId) + "/commands", {
        method: "POST",
        headers: {
          "authorization": "Bearer " + token,
          "content-type": "application/json",
          "accept": "application/json"
        },
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify(body)
      }).catch(function () { /* the call is already closed */ });
    }

    function failCall(message) {
      epoch += 1;
      phase = "idle";
      detachPeer(true);
      setStatus(message);
      syncChrome();
    }

    function sessionEnded() {
      epoch += 1;
      phase = "idle";
      detachPeer(true);
      forgetSession();
      setCaption("");
      setStatus("This session has ended.");
      syncChrome();
    }

    function remember(who, text) {
      var words = String(text || "").trim();
      if (!words || (who !== "you" && who !== "claude")) return;
      history.push({ who: who, text: words.slice(0, 600) });
      if (history.length > 8) history = history.slice(history.length - 8);
    }

    function enqueue(text, stamped) {
      var words = String(text || "").trim();
      if (!words || stamped < turn) return;
      speech.push({ text: words, turn: stamped });
      flush();
    }

    function dropOlder() {
      speech = speech.filter(function (item) {
        return item && item.turn >= turn;
      });
    }

    function cancelActive() {
      if (!speaking || speaking.cancelSent) return;
      speaking.cancelSent = true;
      if (!channel || channel.readyState !== "open") return;
      var cancel = { type: "response.cancel", event_id: "voice-cancel-" + randomId() };
      if (speaking.responseId) cancel.response_id = speaking.responseId;
      try { channel.send(JSON.stringify(cancel)); } catch (err) { /* channel already gone */ }
    }

    function beginTurn() {
      if (hearing) return;
      hearing = true;
      turn += 1;
      dropOlder();
      cancelActive();
    }

    function takeNext() {
      var next = null;
      while (speech.length && !next) {
        var item = speech.shift();
        if (item && item.text && item.turn >= turn) next = item;
      }
      return next;
    }

    function flush() {
      if (!channel || channel.readyState !== "open" || speaking) return;
      var next = takeNext();
      if (!next) return;
      speaking = {
        text: next.text,
        turn: next.turn,
        itemSent: false,
        responseSent: false,
        cancelSent: false,
        responseEventId: "voice-speech-" + randomId(),
        responseId: ""
      };
      try {
        channel.send(JSON.stringify({
          event_id: "voice-item-" + randomId(),
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: speaking.text }]
          }
        }));
        speaking.itemSent = true;
        channel.send(JSON.stringify({
          event_id: speaking.responseEventId,
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            metadata: { voice_speech_id: speaking.responseEventId }
          }
        }));
        speaking.responseSent = true;
      } catch (err) {
        /* The line stays staged. A later channel open can send it. */
      }
    }

    function talkNotice(status) {
      if (status === 400) return "That could not be said.";
      if (status === 403) return "That agent is not available.";
      if (status === 409) return "Voice is busy for this session.";
      return "The agent is unavailable.";
    }

    function postTalk(text, gen) {
      if (!session || !controllerUrl) return;
      var words = String(text || "").trim().slice(0, 600);
      if (!words) return;
      var sentTurn = turn;
      var sessionId = session.id;
      var prior = history.slice(-8).map(function (row) {
        return { who: row.who, text: row.text };
      });
      remember("you", words);
      fetch(controllerUrl + "/v1/session/" + encodeURIComponent(sessionId) + "/talk", {
        method: "POST",
        headers: {
          "authorization": "Bearer " + session.token,
          "content-type": "application/json",
          "accept": "application/json"
        },
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({
          text: words,
          history: prior,
          turn: sentTurn,
          agent: agent === "openai" ? "openai" : "claude"
        })
      }).then(function (res) {
        return res.text().then(function (raw) {
          return { status: res.status, body: parseJson(raw) };
        });
      }).then(function (result) {
        if (gen !== epoch || !session || session.id !== sessionId) return;
        if (phase !== "open" && phase !== "connecting") return;
        if (result.status === 410 || result.status === 404) {
          sessionEnded();
          return;
        }
        if (result.status === 401) {
          setStatus("Sign in to start a conversation.");
          return;
        }
        if (result.status !== 200) {
          setStatus(talkNotice(result.status));
          return;
        }
        var reply = result.body && typeof result.body.reply === "string" ? result.body.reply.trim() : "";
        var echoed = result.body && isInt(result.body.turn) ? result.body.turn : sentTurn;
        if (!reply || echoed < turn) return;
        remember("claude", reply);
        setCaption(reply);
        enqueue(reply, echoed);
      }).catch(function () {
        if (gen !== epoch || (phase !== "open" && phase !== "connecting")) return;
        setStatus("The agent is unavailable.");
      });
    }

    function onMessage(ev) {
      if (phase !== "open" && phase !== "connecting") return;
      var msg = ev && ev.data;
      if (typeof msg === "string") {
        try { msg = JSON.parse(msg); } catch (err) { return; }
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "response.created") {
        if (!speaking || !speaking.responseSent) return;
        var created = msg.response && typeof msg.response === "object" ? msg.response : {};
        var createdMeta = created.metadata && typeof created.metadata === "object" ? created.metadata : {};
        var createdId = typeof created.id === "string" ? created.id : "";
        if (!createdId || createdMeta.voice_speech_id !== speaking.responseEventId) return;
        speaking.responseId = createdId;
        return;
      }
      if (msg.type === "response.done") {
        if (!speaking) return;
        var response = msg.response && typeof msg.response === "object" ? msg.response : {};
        var responseId = typeof response.id === "string" ? response.id : "";
        var metadata = response.metadata && typeof response.metadata === "object" ? response.metadata : {};
        if (!speaking.responseId || responseId !== speaking.responseId) return;
        if (metadata.voice_speech_id && metadata.voice_speech_id !== speaking.responseEventId) return;
        var doneStatus = msg.status || response.status || "";
        var details = msg.status_details || response.status_details || {};
        var reason = details && details.reason ? details.reason : msg.reason;
        var barged = doneStatus === "cancelled" && reason === "turn_detected";
        if (barged) beginTurn();
        speaking = null;
        if (!barged && doneStatus && doneStatus !== "completed") setStatus("Voice playback skipped. Still listening.");
        else setStatus("Listening");
        flush();
        return;
      }
      if (msg.type === "input_audio_buffer.speech_started") {
        beginTurn();
        return;
      }
      if (msg.type === "conversation.item.input_audio_transcription.delta") {
        var partialId = msg.item_id ? String(msg.item_id) : "";
        var delta = typeof msg.delta === "string" ? msg.delta : "";
        partials[partialId] = (partials[partialId] || "") + delta;
        if (showCaptions) setCaption(partials[partialId]);
        return;
      }
      if (msg.type !== "conversation.item.input_audio_transcription.completed") return;
      var itemId = msg.item_id == null ? "" : String(msg.item_id);
      var transcript = typeof msg.transcript === "string" ? msg.transcript : "";
      if (!itemId || uttered[itemId] || !transcript.trim()) {
        if (!transcript.trim()) {
          hearing = false;
          flush();
        }
        return;
      }
      uttered[itemId] = true;
      if (!hearing) beginTurn();
      hearing = false;
      if (showCaptions) setCaption(transcript);
      postTalk(transcript, epoch);
    }

    function armEnds(endsAt, gen) {
      if (endTimer) clearTimeout(endTimer);
      endTimer = null;
      if (typeof endsAt !== "number" || !isFinite(endsAt)) return;
      var wait = Math.max(0, endsAt * 1000 - Date.now());
      endTimer = setTimeout(function () {
        endTimer = null;
        if (gen !== epoch) return;
        if (phase !== "open" && phase !== "connecting") return;
        endConversation("Voice ended.");
      }, wait);
    }

    function readyOffer(peer, gen, offer) {
      function sdp() {
        if (gen !== epoch) return "";
        if (peer.localDescription && peer.localDescription.sdp) return peer.localDescription.sdp;
        return (offer && offer.sdp) || "";
      }
      if (peer.iceGatheringState !== "gathering") return Promise.resolve(sdp());
      return new Promise(function (resolve) {
        function finish() {
          if (offerWait === finish) offerWait = null;
          peer.removeEventListener("icegatheringstatechange", onState);
          resolve(sdp());
        }
        function onState() {
          if (peer.iceGatheringState === "complete" || gen !== epoch) finish();
        }
        offerWait = finish;
        peer.addEventListener("icegatheringstatechange", onState);
      });
    }

    function negotiate(media, gen) {
      stream = media;
      var peer = new RTCPeerConnection();
      pc = peer;
      var tracks = media.getTracks ? media.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) peer.addTrack(tracks[i], media);
      var data = peer.createDataChannel("oai-events");
      channel = data;
      data.onmessage = onMessage;
      data.onopen = function () { flush(); };
      data.onclose = function () {
        if (gen !== epoch || phase !== "open") return;
        scheduleReconnect(gen);
      };
      peer.onconnectionstatechange = function () {
        if (gen !== epoch || phase !== "open") return;
        if (peer.connectionState === "failed") scheduleReconnect(gen);
      };
      peer.ontrack = function (ev) {
        var remote = ev.streams && ev.streams[0];
        if (remote) audioNode.srcObject = remote;
      };
      return peer.createOffer().then(function (offer) {
        return peer.setLocalDescription(offer).then(function () {
          return readyOffer(peer, gen, offer);
        });
      }).then(function (sdp) {
        if (gen !== epoch || !sdp || !session) return null;
        return fetch(controllerUrl + "/v1/session/" + encodeURIComponent(session.id) + "/voice", {
          method: "POST",
          headers: {
            "authorization": "Bearer " + session.token,
            "content-type": "application/json",
            "accept": "application/json"
          },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({ sdp: sdp })
        }).then(function (res) {
          return res.text().then(function (raw) {
            return { status: res.status, body: parseJson(raw) };
          });
        });
      }).then(function (result) {
        if (!result || gen !== epoch) return;
        if (result.status === 200 && result.body && typeof result.body.sdp === "string") {
          return peer.setRemoteDescription({ type: "answer", sdp: result.body.sdp }).then(function () {
            if (gen !== epoch) return;
            phase = "open";
            reconnects = 0;
            setStatus("Listening");
            armEnds(result.body.ends_at, gen);
            syncChrome();
            flush();
          });
        }
        if (result.status === 410 || result.status === 404) {
          sessionEnded();
          return;
        }
        if (result.status === 401) {
          failCall("Sign in to start a conversation.");
          return;
        }
        if (result.status === 409) {
          failCall("Voice is busy for this session.");
          return;
        }
        if (result.status === 429 || result.status === 503) {
          failCall("The agent is unavailable.");
          return;
        }
        failCall("Voice could not start.");
      });
    }

    function scheduleReconnect(gen) {
      if (gen !== epoch || phase !== "open" || reconnectTimer) return;
      reconnects += 1;
      if (reconnects > 2) {
        failCall("Voice could not reconnect.");
        return;
      }
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (gen !== epoch || phase !== "open" || !stream) return;
        var next = ++epoch;
        var live = stream;
        detachPeer(false);
        stream = live;
        phase = "connecting";
        setStatus("Reconnecting");
        syncChrome();
        negotiate(stream, next).catch(function () {
          if (next !== epoch) return;
          failCall("Voice could not reconnect.");
        });
      }, reconnects === 1 ? 0 : 1000);
    }

    function openCall(gen) {
      var media = navigator.mediaDevices;
      if (!media || typeof media.getUserMedia !== "function" || typeof globalRef.RTCPeerConnection !== "function") {
        failCall("Microphone blocked.");
        return;
      }
      media.getUserMedia({ audio: true }).then(function (live) {
        if (gen !== epoch) {
          stopTracks(live);
          return null;
        }
        return negotiate(live, gen);
      }, function () {
        if (gen !== epoch) return null;
        failCall("Microphone blocked.");
        return null;
      }).catch(function (err) {
        if (gen !== epoch) return;
        failCall("Voice could not start.");
      });
    }

    function operatorToken() {
      if (typeof opts.getOperatorToken !== "function") return Promise.resolve("");
      return Promise.resolve().then(function () { return opts.getOperatorToken(); }).then(function (token) {
        return token == null ? "" : String(token);
      }, function () { return ""; });
    }

    function startConversation() {
      if (phase !== "idle" || !voiceAllowed || !controllerUrl) return;
      phase = "connecting";
      agent = chosenAgent();
      stopSent = false;
      reconnects = 0;
      var gen = ++epoch;
      setStatus("Starting");
      syncChrome();
      operatorToken().then(function (token) {
        if (gen !== epoch) return null;
        if (!token) {
          phase = "idle";
          setStatus("Sign in to start a conversation.");
          syncChrome();
          return null;
        }
        if (session) return openCall(gen);
        if (!creationId) creationId = "home-" + randomId();
        return fetch(controllerUrl + "/v1/session", {
          method: "POST",
          headers: {
            "authorization": "Bearer " + token,
            "content-type": "application/json",
            "accept": "application/json"
          },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({
            creation_id: creationId,
            title: "Homepage conversation",
            start: "blank"
          })
        }).then(function (res) {
          return res.text().then(function (raw) {
            return { status: res.status, body: parseJson(raw) };
          });
        }).then(function (result) {
          if (gen !== epoch) return;
          if (result.status === 401) {
            phase = "idle";
            setStatus("Sign in to start a conversation.");
            syncChrome();
            return;
          }
          if (result.status === 410 || result.status === 404) {
            sessionEnded();
            return;
          }
          if (result.status === 409) {
            phase = "idle";
            setStatus("Voice is busy for this session.");
            syncChrome();
            return;
          }
          if (result.status === 429 || result.status === 503) {
            phase = "idle";
            setStatus("The agent is unavailable.");
            syncChrome();
            return;
          }
          if (result.status !== 200 || !result.body.session_id || !result.body.token) {
            phase = "idle";
            setStatus("Voice could not start.");
            syncChrome();
            return;
          }
          session = {
            id: String(result.body.session_id),
            token: String(result.body.token),
            version: isInt(result.body.artifact_version) ? result.body.artifact_version : 0
          };
          syncChrome();
          openCall(gen);
        });
      }).catch(function (err) {
        if (gen !== epoch) return;
        phase = "idle";
        setStatus("Voice could not start.");
        syncChrome();
      });
    }

    function loadHealth() {
      if (!controllerUrl) return;
      fetch(controllerUrl + "/health", {
        method: "GET",
        credentials: "omit",
        cache: "no-store"
      }).then(function (res) {
        if (res.status !== 200) return null;
        return res.json();
      }).then(function (body) {
        voiceAllowed = !!(body && body.features && body.features.voice === true);
        var listed = body && body.features && Array.isArray(body.features.agents) ? body.features.agents : [];
        var known = [];
        for (var i = 0; i < listed.length; i++) {
          var name = String(listed[i] || "").toLowerCase();
          if ((name === "claude" || name === "openai") && known.indexOf(name) < 0) known.push(name);
        }
        agents = known;
        if (phase === "idle") agent = chosenAgent();
        syncChrome();
      }).catch(function () {
        voiceAllowed = false;
        agents = [];
        syncChrome();
      });
    }

    startButton.addEventListener("click", startConversation);
    endButton.addEventListener("click", function () { endConversation("Voice ended."); });
    loadHealth();
    syncChrome();

    return {
      destroy: function () {
        endConversation("Voice ended.");
        if (box.parentNode) box.parentNode.removeChild(box);
      }
    };
  }

  return { mount: mount };
});
