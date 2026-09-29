/* Thin LiveKit room. A one-time handoff arrives in the hash. The JWT does not. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.conferenceLive = api;
  if (typeof document !== "undefined") {
    var start = function () { api.mount(document); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  function readHandoff() {
    var hash = root.location && root.location.hash ? String(root.location.hash) : "";
    var match = /^#h=([A-Za-z0-9_-]{8,128})$/.exec(hash);
    return match ? match[1] : "";
  }

  function clearHash() {
    if (!root.history || !root.location || typeof root.history.replaceState !== "function") return;
    root.history.replaceState(null, "", root.location.pathname + root.location.search);
  }

  function mount(doc) {
    var status = doc.getElementById("room-status");
    var id = readHandoff();
    var room = root.conferenceRoom;
    var gate = root.conferenceGate;

    function say(text) {
      if (status) status.textContent = text;
    }

    if (!id) {
      say("Open this page from the portal after the code is checked. No room was allocated.");
      return;
    }
    if (!room || typeof room.requestConsent !== "function" || !gate || typeof gate.postJson !== "function") {
      say("The room client is not on this page. No room was allocated.");
      return;
    }
    room.requestConsent(function (ok) {
      if (!ok) {
        say("The room was not opened.");
        return;
      }
      gate.postJson("/v1/room", {handoff: id}).then(function (data) {
        clearHash();
        if (!data || data.ok !== true || !data.room_token) {
          say(gate.messageFor(data && data.status, data && data.error));
          return;
        }
        if (typeof room.admit === "function") room.admit(data);
      });
    });
  }

  return {readHandoff: readHandoff, mount: mount};
});
