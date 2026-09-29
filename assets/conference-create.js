/* Create-conference page. Host unlock and code minting stay on the gate. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.conferenceCreate = api;
  if (typeof document !== "undefined") {
    var start = function () { api.mount(document); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var SESSION_KEY = "sfdc24_conf_host_session";

  function joinLink(origin, code) {
    var safe = String(code || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (safe.length < 8) return "";
    var base = String(origin || "").replace(/\/$/, "");
    if (!base) return "";
    return base + "/conference/#c=" + safe;
  }

  function emailOk(raw) {
    var text = String(raw || "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) && text.length <= 120;
  }

  function inviteSentence() {
    return "Draft only. Nothing was sent.";
  }

  function mount(doc) {
    var gate = root.conferenceGate;
    var hostForm = doc.getElementById("host-form");
    var hostCode = doc.getElementById("host-code");
    var guestForm = doc.getElementById("guest-form");
    var status = doc.getElementById("create-status");
    var minted = doc.getElementById("minted");
    var inviteCard = doc.getElementById("invite-draft");
    var list = doc.getElementById("code-list");
    if (!hostForm || !hostCode || !gate) return;

    function say(text) {
      if (status) status.textContent = text;
    }

    function storage() {
      try { return root.sessionStorage; } catch (e) { return null; }
    }

    function session() {
      var box = storage();
      if (!box) return "";
      try { return box.getItem(SESSION_KEY) || ""; } catch (e2) { return ""; }
    }

    function saveSession(value) {
      var box = storage();
      if (!box) return;
      try { box.setItem(SESSION_KEY, value); } catch (e) {}
    }

    function clearSession() {
      var box = storage();
      if (!box) return;
      try { box.removeItem(SESSION_KEY); } catch (e) {}
    }

    function showGuest(email) {
      hostForm.hidden = true;
      if (guestForm) guestForm.hidden = false;
      if (email && emailOk(email)) say("Host gate is open for " + email + ".");
      else say("Host gate is open.");
    }

    function showHost() {
      hostForm.hidden = false;
      if (guestForm) guestForm.hidden = true;
      if (minted) minted.hidden = true;
      if (inviteCard) inviteCard.hidden = true;
      hostCode.value = "";
      say("Enter the host code. This page does not keep it.");
    }

    function addRow(row) {
      if (!list || !row || !row.code) return;
      if (list.getAttribute("data-empty") === "1") {
        list.textContent = "";
        list.setAttribute("data-empty", "0");
      }
      var item = doc.createElement("li");
      var link = joinLink(root.location ? root.location.origin : "", row.code);
      var spoken = row.reference ? " — " + row.reference : "";
      item.textContent = row.code + spoken + (row.used ? " — used" : " — open") + (link ? " — " + link : "");
      list.appendChild(item);
    }

    function showInvite(invite) {
      if (!inviteCard) return;
      if (!invite || !invite.title || !invite.description) {
        inviteCard.hidden = true;
        return;
      }
      inviteCard.hidden = false;
      var title = doc.getElementById("invite-title");
      var description = doc.getElementById("invite-description");
      var inviteStatus = doc.getElementById("invite-status");
      if (title) title.textContent = invite.title;
      if (description) description.textContent = invite.description;
      if (inviteStatus) inviteStatus.textContent = inviteSentence(invite);
    }

    function showMint(data) {
      if (!minted) return;
      minted.hidden = false;
      var codeEl = doc.getElementById("minted-code");
      var linkEl = doc.getElementById("join-link");
      var link = joinLink(root.location ? root.location.origin : "", data.code);
      if (codeEl) codeEl.textContent = data.code || "";
      var spoken = doc.getElementById("minted-reference");
      if (spoken) spoken.textContent = data.reference ? "Agents address them as " + data.reference + "." : "";
      if (linkEl) {
        linkEl.textContent = link;
        linkEl.setAttribute("href", link || "#");
      }
      addRow({code: data.code, used: false, reference: data.reference || ""});
      showInvite(data.invite);
      var queued = data.event && data.event.status === "forwarded" && data.event.durable === true;
      var sink = queued
        ? "Salesforce accepted the Event."
        : "Event queued on this gate. Salesforce has not stored it.";
      say("One joiner. " + sink + " Internal testing only. The join link stays on this page.");
    }

    hostForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = String(hostCode.value || "");
      hostCode.value = "";
      if (!code.trim()) {
        say("Enter the host code. This page does not keep it.");
        return;
      }
      gate.postJson("/v1/host/unlock", {code: code}).then(function (data) {
        if (!data || data.ok !== true || !data.session) {
          say(gate.messageFor(data && data.status, data && data.error));
          return;
        }
        saveSession(data.session);
        showGuest(data.email);
      });
    });

    if (guestForm) {
      guestForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var name = doc.getElementById("guest-name");
        var email = doc.getElementById("guest-email");
        var reference = doc.getElementById("agent-reference");
        var objective = doc.getElementById("guest-objective");
        var token = session();
        if (!token) {
          showHost();
          return;
        }
        gate.postJson("/v1/codes", {
          name: name ? name.value : "",
          email: email ? email.value : "",
          reference: reference ? reference.value : "",
          objective: objective ? objective.value : ""
        }, token).then(function (data) {
          if (!data || data.ok !== true || !data.code) {
            say(gate.messageFor(data && data.status, data && data.error));
            return;
          }
          if (name) name.value = "";
          if (email) email.value = "";
          if (reference) reference.value = "";
          if (objective) objective.value = "";
          showMint(data);
        });
      });
    }

    var copy = doc.getElementById("copy-link");
    if (copy) {
      copy.addEventListener("click", function () {
        var linkEl = doc.getElementById("join-link");
        var text = linkEl ? linkEl.textContent : "";
        var clip = root.navigator && root.navigator.clipboard;
        if (!text || !clip || typeof clip.writeText !== "function") {
          say("Select the join link and copy it.");
          return;
        }
        clip.writeText(text).then(function () {
          say("Join link copied. One joiner.");
        }).catch(function () {
          say("Select the join link and copy it.");
        });
      });
    }

    var keep = doc.getElementById("keep-draft");
    if (keep) {
      keep.addEventListener("click", function () {
        var inviteStatus = doc.getElementById("invite-status");
        if (inviteStatus) inviteStatus.textContent = "Draft kept. Nothing was sent.";
      });
    }

    var lock = doc.getElementById("lock-gate");
    if (lock) {
      lock.addEventListener("click", function () {
        clearSession();
        showHost();
      });
    }

    if (session()) showGuest("");
  }

  return {
    joinLink: joinLink,
    emailOk: emailOk,
    inviteSentence: inviteSentence,
    mount: mount
  };
});
