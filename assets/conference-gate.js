/* Conference gate client. The host code is typed by a person and sent to the
   gate. This file does not contain a host code and does not mint room tokens. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.conferenceGate = api;
  if (typeof document !== "undefined") {
    var start = function () { api.mount(document); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  function gateBase() {
    var cfg = root.SFDC24_CONF_GATE || {};
    var raw = String(cfg.url || "").trim();
    if (!raw) return "";
    try {
      var url = new URL(raw);
      if (url.username || url.password) return "";
      var local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "site.test";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
      return (url.origin + url.pathname).replace(/\/$/, "");
    } catch (e) {
      return "";
    }
  }

  function messageFor(status, error) {
    if (error === "used" || status === 409) return "That code is already used.";
    if (error === "incomplete" || status === 400) return "Name, email, and objective are required.";
    if (error === "limited" || status === 429) return "This session has enough codes.";
    if (error === "gate_unconfigured" || status === 503) return "The conference gate is not configured. Nothing was allocated.";
    if (status === 401 || error === "rejected") return "That code was not accepted.";
    return "The gate did not answer. Nothing was allocated.";
  }

  function postJson(path, body, session) {
    var base = gateBase();
    if (!base || typeof root.fetch !== "function") {
      return Promise.resolve({ok: false, status: 503, error: "gate_unconfigured"});
    }
    var headers = {"content-type": "application/json", "accept": "application/json"};
    if (session) headers.authorization = "Bearer " + session;
    return root.fetch(base + path, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {}),
      credentials: "omit",
      mode: "cors"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!data || typeof data !== "object") data = {};
        data.status = res.status;
        return data;
      });
    }).catch(function () {
      return {ok: false, status: 0, error: "unreachable"};
    });
  }

  function getJson(path, session) {
    var base = gateBase();
    if (!base || typeof root.fetch !== "function") {
      return Promise.resolve({ok: false, status: 503, error: "gate_unconfigured"});
    }
    var headers = {"accept": "application/json"};
    if (session) headers.authorization = "Bearer " + session;
    return root.fetch(base + path, {
      method: "GET",
      headers: headers,
      credentials: "omit",
      mode: "cors"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!data || typeof data !== "object") data = {};
        data.status = res.status;
        return data;
      });
    }).catch(function () {
      return {ok: false, status: 0, error: "unreachable"};
    });
  }

  function mount(doc) {
    var form = doc.getElementById("code-form");
    var input = doc.getElementById("conf-code");
    var status = doc.getElementById("room-status");
    if (!form || !input) return;
    var busy = false;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (busy) return;
      var code = String(input.value || "").trim();
      input.value = "";
      if (!code) {
        if (status) status.textContent = "Enter a conference code.";
        return;
      }
      busy = true;
      postJson("/v1/join", {code: code}).then(function (data) {
        busy = false;
        if (!data || data.ok !== true) {
          if (status) status.textContent = messageFor(data && data.status, data && data.error);
          return;
        }
        var room = root.conferenceRoom;
        if (room && typeof room.admit === "function") room.admit(data);
        else if (status) {
          status.textContent = data.room_token
            ? "Admitted. The room client is not on this page."
            : "Admitted. The gate did not issue a room token. No room was allocated.";
        }
      });
    });
  }

  return {
    gateBase: gateBase,
    messageFor: messageFor,
    postJson: postJson,
    getJson: getJson,
    mount: mount
  };
});
