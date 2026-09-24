/* Studio page. Renders typed artifact nodes and one active decision.
   Fixture mode (?script=fixture) replays studio/contract/fixtures/scripted-session.json.
   Controller mode is a stub: SSE + POST to data-controller-url, left unconnected. */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      });
    }
    return node;
  }

  function text(tag, value, attrs) {
    var node = el(tag, attrs);
    node.textContent = value == null ? "" : String(value);
    return node;
  }

  /* --- reducer ---------------------------------------------------------- */

  function createState() {
    return {
      sessionId: "",
      generation: 0,
      taskRevision: 0,
      artifactVersion: 0,
      lastSeq: 0,
      seenOps: {},
      queue: [],
      root: null,
      title: "",
      questions: {},
      questionOrder: [],
      activeQuestionId: null,
      highlights: {},
      changedIds: {},
      confirmText: "",
      progress: null,
      batch: null,
      announcements: []
    };
  }

  /* A change is named and shown before the next question. The hold is real
     time, including when reduced motion drops the settle animation. */
  var SETTLE_MS = 2000;
  var settleUntil = 0;
  var settleTimer = null;
  var afterSettle = function () {};

  function isSettling() {
    return Date.now() < settleUntil;
  }

  function armSettle() {
    settleUntil = Date.now() + SETTLE_MS;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      settleTimer = null;
      settleUntil = 0;
      afterSettle();
    }, SETTLE_MS);
  }

  function overlaps(left, right) {
    var seen = {};
    (left || []).forEach(function (id) { if (id) seen[id] = true; });
    var list = right || [];
    for (var i = 0; i < list.length; i++) {
      if (seen[list[i]]) return true;
    }
    return false;
  }

  function retract(state, message) {
    if (!message) return;
    state.announcements = state.announcements.filter(function (line) {
      return line !== message;
    });
  }

  function clearProgress(state, ids) {
    if (!state.progress || !overlaps(state.progress.ids, ids)) return;
    retract(state, state.progress.text);
    state.progress = null;
  }

  function markChanged(state, ids) {
    var next = {};
    (ids || []).forEach(function (id) { if (id) next[id] = true; });
    state.changedIds = next;
  }

  function setHighlights(state, ids) {
    var next = {};
    (ids || []).forEach(function (id) { if (id) next[id] = true; });
    state.highlights = next;
  }

  function announce(state, message) {
    if (!message) return;
    state.announcements.push(String(message));
  }

  function findNode(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var hit = findNode(kids[i], id);
      if (hit) return hit;
    }
    return null;
  }

  function removeNode(node, id) {
    if (!node || !node.children) return false;
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].id === id) {
        node.children.splice(i, 1);
        return true;
      }
      if (removeNode(node.children[i], id)) return true;
    }
    return false;
  }

  function applyOp(root, op) {
    if (!root || !op) return;
    if (op.op === "remove") {
      removeNode(root, op.node_id);
      return;
    }
    var node = findNode(root, op.node_id);
    if (!node) return;
    if (op.op === "set_label") node.label = op.value == null ? "" : String(op.value);
    else if (op.op === "set_detail") node.detail = op.value == null ? "" : String(op.value);
    else if (op.op === "insert_child" && op.node) {
      if (!node.children) node.children = [];
      node.children.push(copy(op.node));
    }
  }

  function rememberQuestion(state, question) {
    state.questions[question.question_id] = question;
    if (state.questionOrder.indexOf(question.question_id) < 0) {
      state.questionOrder.push(question.question_id);
    }
  }

  /* Ignore older task revisions, and artifact writes that do not move
     the version forward. Same-version questions and confirmations still apply.
     A repeated op_id is recorded once. Seq is applied in order; a gap waits. */
  function acceptEvent(state, event) {
    if (state.generation && event.generation < state.generation) return false;
    if (state.taskRevision && event.task_revision < state.taskRevision) return false;
    if ((event.type === "artifact.snapshot" || event.type === "artifact.patch") &&
        event.artifact_version <= state.artifactVersion) return false;
    return true;
  }

  function applyEvent(state, event) {
    var payload = event.payload || {};
    if (event.session_id) state.sessionId = event.session_id;
    if (event.generation > state.generation) state.generation = event.generation;
    if (event.task_revision > state.taskRevision) state.taskRevision = event.task_revision;

    if (event.type === "session.started") {
      state.title = payload.title || "";
      return;
    }
    if (event.type === "artifact.snapshot") {
      state.root = payload.root ? copy(payload.root) : null;
      state.artifactVersion = event.artifact_version;
      return;
    }
    if (event.type === "artifact.patch") {
      var touched = [];
      (payload.ops || []).forEach(function (op) {
        applyOp(state.root, op);
        if (op.node_id) touched.push(op.node_id);
        if (op.node && op.node.id) touched.push(op.node.id);
      });
      state.artifactVersion = event.artifact_version;
      clearProgress(state, touched);
      markChanged(state, touched);
      armSettle();
      return;
    }
    if (event.type === "question.asked") {
      var asked = copy(payload.question);
      rememberQuestion(state, asked);
      state.activeQuestionId = asked.question_id;
      setHighlights(state, asked.affected_artifact_ids);
      announce(state, asked.prompt);
      return;
    }
    if (event.type === "question.answered") {
      var answered = copy(payload.question);
      rememberQuestion(state, answered);
      if (state.activeQuestionId === answered.question_id) state.activeQuestionId = null;
      return;
    }
    if (event.type === "question.superseded") {
      var prior = state.questions[payload.question_id];
      if (prior) prior.status = "superseded";
      if (state.activeQuestionId === payload.question_id) state.activeQuestionId = null;
      return;
    }
    if (event.type === "decision.batch") {
      state.batch = copy(payload);
      var ids = [];
      (payload.questions || []).forEach(function (q) {
        (q.affected_artifact_ids || []).forEach(function (id) { ids.push(id); });
      });
      setHighlights(state, ids);
      announce(state, payload.title);
      return;
    }
    if (event.type === "focus.set") {
      setHighlights(state, payload.artifact_ids);
      return;
    }
    if (event.type === "progress") {
      state.progress = {
        text: payload.text || "",
        ids: (payload.artifact_ids || []).slice()
      };
      setHighlights(state, payload.artifact_ids);
      announce(state, state.progress.text);
      return;
    }
    if (event.type === "confirm") {
      state.confirmText = payload.text || "";
      setHighlights(state, payload.artifact_ids);
      (payload.artifact_ids || []).forEach(function (id) {
        if (id) state.changedIds[id] = true;
      });
      clearProgress(state, payload.artifact_ids);
      announce(state, state.confirmText);
      armSettle();
      return;
    }
    if (event.type === "session.ended") {
      announce(state, payload.reason || "");
    }
  }

  function drain(state) {
    var changed = false;
    for (;;) {
      if (!state.queue.length) break;
      var next = state.queue[0];
      if (next.seq <= state.lastSeq) {
        state.queue.shift();
        continue;
      }
      if (next.seq !== state.lastSeq + 1) break;
      /* The next question waits out the settle. Leave it queued; do not drop it. */
      if (isSettling() && (next.type === "question.asked" || next.type === "decision.batch")) break;
      state.queue.shift();
      state.lastSeq = next.seq;
      if (!acceptEvent(state, next)) continue;
      applyEvent(state, next);
      changed = true;
    }
    return changed;
  }

  function ingest(state, event) {
    if (!event || !event.op_id || state.seenOps[event.op_id]) return false;
    state.seenOps[event.op_id] = true;
    state.queue.push(event);
    state.queue.sort(function (a, b) { return a.seq - b.seq; });
    return drain(state);
  }

  /* --- commands --------------------------------------------------------- */

  var commandCount = 0;

  function commandKey(command) {
    if (command.type === "answer") {
      return "answer:" + command.question_id + ":" + (command.option_id || "");
    }
    if (command.type === "change_decision") return "change_decision:" + command.question_id;
    if (command.type === "answer_batch") return "answer_batch:" + (command.batch_id || "");
    return command.type || "";
  }

  function buildCommand(state, fields) {
    var command = {
      command_id: "cmd-" + (++commandCount),
      session_id: state.sessionId,
      expected_version: state.artifactVersion
    };
    Object.keys(fields).forEach(function (key) { command[key] = fields[key]; });
    return command;
  }

  /* --- transports ------------------------------------------------------- */

  function FixtureTransport(url) {
    this.url = url;
    this.script = null;
    this.deliver = null;
  }

  FixtureTransport.prototype.start = function (deliver) {
    var self = this;
    this.deliver = deliver;
    return fetch(this.url).then(function (res) {
      if (!res.ok) throw new Error("fixture unavailable");
      return res.json();
    }).then(function (script) {
      self.script = script;
      (script.initial || []).forEach(function (event) { deliver(event); });
    });
  };

  FixtureTransport.prototype.send = function (command) {
    var events = (this.script && this.script.on_command && this.script.on_command[commandKey(command)]) || [];
    var deliver = this.deliver;
    events.forEach(function (event) { deliver(event); });
    return Promise.resolve();
  };

  /* Stub for the cloud controller Codex is building. Not opened in this stage:
     connect() is the SSE leg, send() is the POST leg, and nothing calls connect. */
  function ControllerTransport(url) {
    this.url = url || "";
    this.deliver = null;
    this.source = null;
  }

  ControllerTransport.prototype.start = function (deliver) {
    this.deliver = deliver;
    return Promise.resolve();
  };

  ControllerTransport.prototype.connect = function () {
    if (!this.url || this.source || typeof EventSource === "undefined") return;
    var self = this;
    this.source = new EventSource(this.url);
    this.source.onmessage = function (msg) {
      var event;
      try { event = JSON.parse(msg.data); } catch (err) { return; }
      if (self.deliver) self.deliver(event);
    };
  };

  ControllerTransport.prototype.send = function (command) {
    if (!this.url) return Promise.resolve();
    return fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    });
  };

  /* --- render ----------------------------------------------------------- */

  function sortedOptions(options) {
    return (options || []).slice().sort(function (a, b) {
      return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
    });
  }

  function optionById(question, optionId) {
    var options = question.options || [];
    for (var i = 0; i < options.length; i++) {
      if (options[i].option_id === optionId) return options[i];
    }
    return null;
  }

  function renderEdge(parent, node) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "node-svg");
    svg.setAttribute("viewBox", "0 0 80 16");
    svg.setAttribute("aria-hidden", "true");
    var line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", "8");
    line.setAttribute("x2", "80");
    line.setAttribute("y2", "8");
    svg.appendChild(line);
    parent.appendChild(svg);
    if (node.from || node.to) {
      parent.appendChild(text("span", (node.from || "") + " → " + (node.to || ""), { "class": "node-detail" }));
    }
  }

  function renderProcessStep(parent) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "node-svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    var circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "5");
    svg.appendChild(circle);
    parent.appendChild(svg);
  }

  function renderNode(node, highlights, changed) {
    var view = el("div", {
      "class": "node kind-" + node.kind,
      "data-node-id": node.id,
      "data-kind": node.kind,
      "data-highlight": highlights[node.id] ? "true" : "false",
      "data-changed": changed[node.id] ? "true" : "false"
    });
    if (node.kind === "edge") renderEdge(view, node);
    if (node.kind === "process-step") renderProcessStep(view);
    if (node.label) view.appendChild(text("span", node.label, { "class": "node-label" }));
    if (node.detail) view.appendChild(text("span", node.detail, { "class": "node-detail" }));
    (node.children || []).forEach(function (child) {
      view.appendChild(renderNode(child, highlights, changed));
    });
    return view;
  }

  function renderOptionButton(question, option) {
    var button = el("button", {
      "type": "button",
      "class": "studio-option",
      "data-action": "answer",
      "data-question-id": question.question_id,
      "data-option-id": option.option_id
    });
    if (option.recommended) button.setAttribute("data-recommended", "true");
    button.appendChild(text("span", option.label, { "class": "opt-label" }));
    if (option.recommended) button.appendChild(text("span", "Recommended", { "class": "opt-rec" }));
    if (option.recommended_because) button.appendChild(text("span", option.recommended_because, { "class": "opt-why" }));
    if (option.consequence) button.appendChild(text("span", option.consequence, { "class": "opt-cons" }));
    return button;
  }

  function renderCard(question, active) {
    var card = el("article", {
      "data-studio-card": "",
      "data-question-id": question.question_id,
      "data-status": question.status || "open",
      "data-active": active ? "true" : "false"
    });
    card.appendChild(text("span", "Where this fits", { "class": "card-k" }));
    card.appendChild(text("p", question.scope_path || "", { "data-card-scope": "" }));
    card.appendChild(text("span", "Why I am asking", { "class": "card-k" }));
    card.appendChild(text("p", question.reason || "", { "data-card-reason": "" }));
    card.appendChild(text("p", question.prompt || "", { "data-card-prompt": "" }));

    if (question.status === "open") {
      var options = el("div", { "class": "studio-options" });
      sortedOptions(question.options).forEach(function (option) {
        options.appendChild(renderOptionButton(question, option));
      });
      card.appendChild(options);
      var actions = el("div", { "class": "card-actions" });
      actions.appendChild(text("button", "Say it your way", {
        "type": "button",
        "class": "studio-text-btn",
        "data-action": "freeform",
        "data-question-id": question.question_id
      }));
      actions.appendChild(text("button", "Decide later", {
        "type": "button",
        "class": "studio-text-btn",
        "data-action": "later",
        "data-question-id": question.question_id
      }));
      card.appendChild(actions);
      var freeform = el("div", { "class": "studio-freeform", "data-freeform": question.question_id });
      freeform.hidden = true;
      var label = el("label");
      label.appendChild(text("span", "Your words"));
      label.appendChild(el("input", { "type": "text", "data-freeform-input": "", "maxlength": "600" }));
      freeform.appendChild(label);
      freeform.appendChild(text("button", "Use these words", {
        "type": "button",
        "class": "studio-text-btn",
        "data-action": "freeform-send",
        "data-question-id": question.question_id
      }));
      card.appendChild(freeform);
    } else {
      var chosen = optionById(question, question.selected_option);
      var chosenText = chosen ? chosen.label : (question.freeform_answer || "");
      if (chosenText) card.appendChild(text("p", chosenText, { "class": "chosen" }));
      if (question.status === "answered") {
        card.appendChild(text("button", "Change this decision", {
          "type": "button",
          "class": "studio-text-btn",
          "data-action": "change",
          "data-question-id": question.question_id
        }));
      }
    }
    return card;
  }

  function renderBatch(batch) {
    var form = el("form", {
      "class": "studio-batch",
      "data-studio-batch": batch.batch_id,
      "autocomplete": "off"
    });
    form.appendChild(text("h2", batch.title || "Decisions"));
    (batch.questions || []).forEach(function (question) {
      var group = el("fieldset");
      group.appendChild(text("legend", question.prompt || ""));
      if (question.scope_path) group.appendChild(text("p", question.scope_path, { "class": "batch-where" }));
      if (question.reason) group.appendChild(text("p", question.reason, { "class": "batch-why" }));
      sortedOptions(question.options).forEach(function (option) {
        var label = el("label");
        if (option.recommended) label.setAttribute("data-recommended", "true");
        var input = el("input", { "type": "radio", "name": question.question_id, "value": option.option_id });
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + option.label));
        if (option.recommended) label.appendChild(text("span", "Recommended", { "class": "opt-rec-inline" }));
        if (option.recommended_because) label.appendChild(text("span", option.recommended_because, { "class": "opt-why" }));
        if (option.consequence) label.appendChild(text("span", option.consequence, { "class": "opt-cons" }));
        group.appendChild(label);
      });
      form.appendChild(group);
    });
    var submit = text("button", "Submit decisions", { "type": "submit" });
    submit.disabled = true;
    form.appendChild(submit);
    return form;
  }

  function render(state) {
    var title = document.getElementById("studio-title");
    if (title) title.textContent = state.title || "";

    var artifact = document.getElementById("studio-artifact");
    artifact.setAttribute("data-artifact-version", String(state.artifactVersion));
    clear(artifact);
    if (state.root) artifact.appendChild(renderNode(state.root, state.highlights, state.changedIds));

    var progress = document.getElementById("studio-progress");
    if (progress) {
      var line = state.progress ? state.progress.text : "";
      progress.textContent = line;
      progress.hidden = !line;
    }

    var activeHost = document.getElementById("studio-active");
    var historyHost = document.getElementById("studio-history");
    clear(activeHost);
    clear(historyHost);
    var history = [];
    state.questionOrder.forEach(function (id) {
      var question = state.questions[id];
      if (!question) return;
      var active = question.question_id === state.activeQuestionId && question.status === "open";
      var card = renderCard(question, active);
      if (active) activeHost.appendChild(card);
      else history.push(card);
    });
    if (history.length) {
      historyHost.appendChild(text("p", "Earlier decisions", { "class": "studio-history-label" }));
      history.forEach(function (card) { historyHost.appendChild(card); });
    }

    var batchHost = document.getElementById("studio-batch");
    clear(batchHost);
    if (state.batch) batchHost.appendChild(renderBatch(state.batch));

    var confirm = document.querySelector("[data-studio-confirm]");
    if (confirm) confirm.textContent = state.confirmText || "";

    var live = document.getElementById("studio-live");
    if (live) live.textContent = state.announcements.join(" ");
  }

  function refreshBatchSubmit(form) {
    var groups = {};
    var radios = form.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < radios.length; i++) {
      var name = radios[i].name;
      if (!groups[name]) groups[name] = false;
      if (radios[i].checked) groups[name] = true;
    }
    var names = Object.keys(groups);
    var ready = names.length > 0 && names.every(function (name) { return groups[name]; });
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !ready;
  }

  /* --- boot ------------------------------------------------------------- */

  var state = createState();
  var transport = null;

  afterSettle = function () {
    if (drain(state)) render(state);
  };

  function onEvent(event) {
    if (ingest(state, event)) render(state);
  }

  function send(fields) {
    if (!transport) return;
    transport.send(buildCommand(state, fields));
  }

  var app = document.getElementById("studio-app");

  app.addEventListener("click", function (ev) {
    var button = ev.target.closest("button");
    if (!button || !app.contains(button)) return;
    var action = button.getAttribute("data-action");
    var questionId = button.getAttribute("data-question-id");
    if (action === "answer") {
      send({
        type: "answer",
        question_id: questionId,
        option_id: button.getAttribute("data-option-id"),
        answer_source: "tap"
      });
      return;
    }
    if (action === "change") {
      send({ type: "change_decision", question_id: questionId });
      return;
    }
    if (action === "later") {
      send({ type: "decide_later", question_id: questionId });
      return;
    }
    if (action === "freeform") {
      var panel = button.parentNode.parentNode.querySelector("[data-freeform]");
      if (panel) panel.hidden = !panel.hidden;
      return;
    }
    if (action === "freeform-send") {
      var input = button.parentNode.querySelector("[data-freeform-input]");
      var words = input ? input.value : "";
      if (!words) return;
      send({
        type: "answer",
        question_id: questionId,
        freeform_answer: words,
        answer_source: "typed"
      });
    }
  });

  app.addEventListener("change", function (ev) {
    var form = ev.target.closest && ev.target.closest("[data-studio-batch]");
    if (form) refreshBatchSubmit(form);
  });

  app.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.getAttribute || !form.getAttribute("data-studio-batch")) return;
    ev.preventDefault();
    var answers = [];
    var checked = form.querySelectorAll('input[type="radio"]:checked');
    for (var i = 0; i < checked.length; i++) {
      answers.push({ question_id: checked[i].name, option_id: checked[i].value });
    }
    send({
      type: "answer_batch",
      batch_id: form.getAttribute("data-studio-batch"),
      answers: answers,
      answer_source: "tap"
    });
  });

  var params = new URLSearchParams(location.search);
  var controllerUrl = app.getAttribute("data-controller-url") || "";
  if (params.get("script") === "fixture") {
    transport = new FixtureTransport("/studio/contract/fixtures/scripted-session.json");
  } else {
    transport = new ControllerTransport(controllerUrl);
  }
  transport.start(onEvent);
})();
