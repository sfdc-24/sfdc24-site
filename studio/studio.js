/* Studio page. Renders typed artifact nodes and one active decision.
   Fixture mode (?script=fixture) replays studio/contract/fixtures/scripted-session.json.
   A data-controller-url signs in (email code), then POSTs /v1/session and
   fetch-streams events. Tokens are headers, never part of a URL.
   Neither of those plays the labelled walkthrough and does not install hooks.
   Talk appears only for a live session when GET /v1/health is 200 and
   features.voice is true. The microphone stays idle until Talk. */
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
      ended: false,
      endReason: "",
      announcements: [],
      statusText: "",
      voiceStatus: ""
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

  /* Release 4: a form stays on screen until the controller says each of its
     questions was answered. When none is left open, the form closes and its
     decisions read as history, like any other. */
  function closeBatchQuestion(state, answered) {
    if (!state.batch) return;
    var open = 0;
    (state.batch.questions || []).forEach(function (q) {
      if (q.question_id === answered.question_id) q.status = answered.status;
      if (q.status === "open") open += 1;
    });
    if (!open) state.batch = null;
  }

  function rememberQuestion(state, question) {
    state.questions[question.question_id] = question;
    if (state.questionOrder.indexOf(question.question_id) < 0) {
      state.questionOrder.push(question.question_id);
    }
  }

  /* Acceptance is decided before the cursor or the op_id set is touched.
     A refused event is not recorded, so it cannot block the stream. */
  var ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
  var EVENT_TYPES = {
    "session.started": 1, "decision.batch": 1, "artifact.snapshot": 1, "artifact.patch": 1,
    "question.asked": 1, "question.answered": 1, "question.superseded": 1,
    "focus.set": 1, "progress": 1, "confirm": 1, "session.ended": 1
  };
  var KINDS = {
    screen: 1, section: 1, heading: 1, text: 1, button: 1, "image-placeholder": 1,
    form: 1, field: 1, list: 1, card: 1, nav: 1, "process-step": 1, edge: 1
  };
  var GROUPS = {
    Strategy: 1, Audience: 1, Structure: 1, Screen: 1, Component: 1, Content: 1,
    Behaviour: 1, Data: 1, Accessibility: 1, Release: 1
  };
  var STATUSES = { open: 1, answered: 1, assumed: 1, deferred: 1, superseded: 1 };
  var SOURCES = { tap: 1, voice: 1, typed: 1, assumed: 1 };
  var PATCH_OPS = { set_label: 1, set_detail: 1, insert_child: 1, remove: 1 };
  var GAP_MS = 2000;
  var gapTimer = null;

  function isObj(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function isId(value) {
    return typeof value === "string" && ID_RE.test(value);
  }

  function isInt(value, min) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= min;
  }

  function isText(value) {
    return typeof value === "string" && value.length <= 600;
  }

  function onlyKeys(obj, allowed) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (!allowed[keys[i]]) return false;
    }
    return true;
  }

  function validIdList(list, min) {
    if (!Array.isArray(list) || list.length < min) return false;
    for (var i = 0; i < list.length; i++) {
      if (!isId(list[i])) return false;
    }
    return true;
  }

  function validNode(node, depth) {
    if (!isObj(node) || depth > 40) return false;
    if (!onlyKeys(node, { id: 1, kind: 1, label: 1, detail: 1, children: 1, from: 1, to: 1 })) return false;
    if (!isId(node.id) || !KINDS[node.kind]) return false;
    if ("label" in node && !isText(node.label)) return false;
    if ("detail" in node && !isText(node.detail)) return false;
    if ("from" in node && !isId(node.from)) return false;
    if ("to" in node && !isId(node.to)) return false;
    if ("children" in node) {
      if (!Array.isArray(node.children) || node.children.length > 60) return false;
      for (var i = 0; i < node.children.length; i++) {
        if (!validNode(node.children[i], depth + 1)) return false;
      }
    }
    return true;
  }

  function validOption(option) {
    if (!isObj(option)) return false;
    if (!onlyKeys(option, {
      option_id: 1, label: 1, consequence: 1, recommended: 1, recommended_because: 1
    })) return false;
    if (!isId(option.option_id) || !isText(option.label) || !isText(option.consequence)) return false;
    if ("recommended" in option && typeof option.recommended !== "boolean") return false;
    if ("recommended_because" in option && !isText(option.recommended_because)) return false;
    return true;
  }

  function validQuestion(question) {
    if (!isObj(question)) return false;
    if (!onlyKeys(question, {
      question_id: 1, parent_question_id: 1, group: 1, scope_path: 1, reason: 1, prompt: 1,
      options: 1, status: 1, selected_option: 1, freeform_answer: 1, answer_source: 1,
      affected_artifact_ids: 1, artifact_version_before: 1, artifact_version_after: 1
    })) return false;
    if (!isId(question.question_id) || !isText(question.scope_path) || !isText(question.reason) || !isText(question.prompt)) return false;
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) return false;
    for (var i = 0; i < question.options.length; i++) {
      if (!validOption(question.options[i])) return false;
    }
    if (!STATUSES[question.status] || !validIdList(question.affected_artifact_ids, 1)) return false;
    if ("parent_question_id" in question && !isId(question.parent_question_id)) return false;
    if ("group" in question && !GROUPS[question.group]) return false;
    if ("selected_option" in question && !isId(question.selected_option)) return false;
    if ("freeform_answer" in question && !isText(question.freeform_answer)) return false;
    if ("answer_source" in question && !SOURCES[question.answer_source]) return false;
    if ("artifact_version_before" in question && !isInt(question.artifact_version_before, 0)) return false;
    if ("artifact_version_after" in question && !isInt(question.artifact_version_after, 0)) return false;
    return true;
  }

  function validPatchOp(op) {
    if (!isObj(op)) return false;
    if (!onlyKeys(op, { op: 1, node_id: 1, value: 1, node: 1 })) return false;
    if (!PATCH_OPS[op.op] || !isId(op.node_id)) return false;
    if ("value" in op && !isText(op.value)) return false;
    if ("node" in op && !validNode(op.node, 0)) return false;
    return true;
  }

  function validPayload(type, payload) {
    if (!isObj(payload)) return false;
    if (type === "session.started") {
      return onlyKeys(payload, { title: 1 }) && isText(payload.title);
    }
    if (type === "artifact.snapshot") {
      return onlyKeys(payload, { root: 1 }) && validNode(payload.root, 0);
    }
    if (type === "artifact.patch") {
      if (!onlyKeys(payload, { ops: 1 }) || !Array.isArray(payload.ops) || !payload.ops.length) return false;
      for (var i = 0; i < payload.ops.length; i++) {
        if (!validPatchOp(payload.ops[i])) return false;
      }
      return true;
    }
    if (type === "question.asked" || type === "question.answered") {
      return onlyKeys(payload, { question: 1 }) && validQuestion(payload.question);
    }
    if (type === "question.superseded") {
      return onlyKeys(payload, { question_id: 1, superseded_by_revision: 1 }) &&
        isId(payload.question_id) && isInt(payload.superseded_by_revision, 1);
    }
    if (type === "decision.batch") {
      if (!onlyKeys(payload, { batch_id: 1, title: 1, questions: 1 })) return false;
      if (!isId(payload.batch_id) || !isText(payload.title)) return false;
      if (!Array.isArray(payload.questions) || payload.questions.length < 2 || payload.questions.length > 4) return false;
      for (var q = 0; q < payload.questions.length; q++) {
        if (!validQuestion(payload.questions[q])) return false;
      }
      return true;
    }
    if (type === "focus.set") {
      return onlyKeys(payload, { artifact_ids: 1 }) && validIdList(payload.artifact_ids, 1);
    }
    if (type === "progress") {
      return onlyKeys(payload, { artifact_ids: 1, text: 1 }) &&
        validIdList(payload.artifact_ids, 1) && isText(payload.text);
    }
    if (type === "confirm") {
      return onlyKeys(payload, { text: 1, artifact_ids: 1 }) &&
        isText(payload.text) && validIdList(payload.artifact_ids, 1);
    }
    if (type === "session.ended") {
      return onlyKeys(payload, { reason: 1 }) && isText(payload.reason);
    }
    return false;
  }

  function validEnvelope(event) {
    if (!isObj(event)) return false;
    if (!onlyKeys(event, {
      session_id: 1, generation: 1, seq: 1, op_id: 1, type: 1, task_id: 1,
      task_revision: 1, artifact_version: 1, turn_id: 1, payload: 1
    })) return false;
    if (!isId(event.session_id) || !isId(event.op_id) || !isId(event.task_id) || !isId(event.turn_id)) return false;
    if (!isInt(event.generation, 1) || !isInt(event.seq, 1)) return false;
    if (!isInt(event.task_revision, 1) || !isInt(event.artifact_version, 0)) return false;
    if (!EVENT_TYPES[event.type]) return false;
    return validPayload(event.type, event.payload);
  }

  /* refuse | generation | repair | hold | apply. Read-only. */
  function classify(state, event) {
    if (!validEnvelope(event)) return "refuse";
    if (state.sessionId && event.session_id !== state.sessionId) return "refuse";
    if (state.generation && event.generation < state.generation) return "refuse";
    if (state.generation && event.generation > state.generation) {
      if (event.type === "artifact.snapshot" && event.seq === 1 &&
          event.artifact_version >= state.artifactVersion &&
          (!state.taskRevision || event.task_revision >= state.taskRevision)) {
        return "generation";
      }
      return "refuse";
    }
    if (state.taskRevision && event.task_revision < state.taskRevision) return "refuse";
    if (event.type === "artifact.patch" && event.artifact_version <= state.artifactVersion) return "refuse";
    if (event.type === "artifact.snapshot" && event.artifact_version <= state.artifactVersion) return "refuse";
    if (state.lastSeq && event.seq <= state.lastSeq) return "refuse";
    if (!state.lastSeq ? event.seq > 1 : event.seq > state.lastSeq + 1) {
      if (event.type === "artifact.snapshot") return "repair";
      return "hold";
    }
    if (event.type === "artifact.patch" && event.artifact_version !== state.artifactVersion + 1) return "hold";
    if ((event.type === "confirm" || event.type === "progress" || event.type === "focus.set") &&
        event.artifact_version !== state.artifactVersion) return "refuse";
    return "apply";
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
      closeBatchQuestion(state, answered);
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
      state.ended = true;
      state.endReason = payload.reason || "";
      state.activeQuestionId = null;
      announce(state, state.endReason);
    }
  }

  function clearGap() {
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = null;
  }

  function armGap() {
    if (gapTimer) return;
    gapTimer = setTimeout(releaseGap, GAP_MS);
  }

  function dropAtOrBelow(state, snapshot) {
    state.queue = state.queue.filter(function (queued) {
      if (queued.seq <= snapshot.seq) return false;
      if (queued.artifact_version <= snapshot.artifact_version) return false;
      return true;
    });
  }

  function commit(state, event) {
    state.seenOps[event.op_id] = true;
    state.lastSeq = event.seq;
    if (!state.sessionId) state.sessionId = event.session_id;
    if (event.generation > state.generation) state.generation = event.generation;
    applyEvent(state, event);
    /* Release 4 (Codex review of #146): the end is final. Whatever was
       queued behind it is dropped, and ingest refuses anything newer. */
    if (state.ended) state.queue = [];
    if (voice) voice.onCommitted(event);
  }

  function enqueue(state, event) {
    state.queue.push(event);
    state.queue.sort(function (a, b) { return a.seq - b.seq; });
  }

  function alreadyQueued(state, opId) {
    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i].op_id === opId) return true;
    }
    return false;
  }

  function beginGeneration(state, event) {
    clearGap();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    settleUntil = 0;
    state.queue = [];
    state.seenOps = {};
    state.generation = event.generation;
    state.lastSeq = 0;
    commit(state, event);
  }

  function repairWith(state, event) {
    clearGap();
    dropAtOrBelow(state, event);
    state.lastSeq = event.seq - 1;
    commit(state, event);
  }

  function drain(state) {
    var changed = false;
    var guard = 0;
    while (state.queue.length && guard++ < 40) {
      var next = state.queue[0];
      var kind = classify(state, next);
      if (kind === "generation") {
        state.queue.shift();
        beginGeneration(state, next);
        changed = true;
        break;
      }
      if (kind === "repair") {
        state.queue.shift();
        repairWith(state, next);
        changed = true;
        continue;
      }
      if (kind === "refuse") {
        state.queue.shift();
        if (state.queue.length && state.queue[0].seq > state.lastSeq + 1) armGap();
        break;
      }
      if (kind === "hold") break;
      if (isSettling() && waitsForSettle(next.type)) break;
      state.queue.shift();
      commit(state, next);
      changed = true;
    }
    if (!state.queue.length) clearGap();
    return changed;
  }

  /* A gap, or a patch that skipped a version, waits at most 2s. Then the
     hole is skipped. A skip-ahead patch is dropped, never applied to the
     wrong base. A question still waiting out the settle stays queued. */
  function releaseGap() {
    gapTimer = null;
    if (!state.queue.length) return;
    if (state.queue[0].seq > state.lastSeq + 1) state.lastSeq = state.queue[0].seq - 1;
    var changed = drain(state);
    var guard = 0;
    while (state.queue.length && guard++ < 20) {
      var head = state.queue[0];
      var kind = classify(state, head);
      if (kind === "hold" && head.seq === state.lastSeq + 1 && head.type === "artifact.patch") {
        state.queue.shift();
        state.lastSeq = head.seq;
        changed = drain(state) || changed;
        continue;
      }
      if (kind === "refuse" && head.seq === state.lastSeq + 1) {
        state.queue.shift();
        state.lastSeq = head.seq;
        changed = drain(state) || changed;
        continue;
      }
      break;
    }
    if (changed) render(state);
  }

  /* The next question, a form, or the end of the session waits until the
     change before it has been named and shown. */
  function waitsForSettle(type) {
    return type === "question.asked" || type === "decision.batch" || type === "session.ended";
  }

  function ingest(state, event) {
    if (!event || !event.op_id) return false;
    if (state.ended) return false;
    if (state.seenOps[event.op_id] || alreadyQueued(state, event.op_id)) return false;
    var kind = classify(state, event);
    if (kind === "refuse") return false;
    if (kind === "generation") {
      beginGeneration(state, event);
      return true;
    }
    if (kind === "repair") {
      repairWith(state, event);
      drain(state);
      return true;
    }
    var waitForSettle = kind === "apply" && isSettling() && waitsForSettle(event.type);
    if (kind === "hold" || waitForSettle) {
      enqueue(state, event);
      if (kind === "hold") armGap();
      return false;
    }
    commit(state, event);
    drain(state);
    return true;
  }

  /* --- commands --------------------------------------------------------- */

  var commandCount = 0;

  function commandKey(command) {
    if (command.type === "answer") {
      return "answer:" + command.question_id + ":" + (command.option_id || "");
    }
    if (command.type === "change_decision") return "change_decision:" + command.question_id;
    if (command.type === "answer_batch") {
      /* Release 4: the scripted answer depends on what was chosen, so a visitor
         who picks Executives never sees a heading written for admins. */
      var picked = (command.answers || []).map(function (a) {
        return a.question_id + "=" + a.option_id;
      }).sort();
      return "answer_batch:" + (command.batch_id || "") + ":" + picked.join(",");
    }
    if (command.type === "decide_later") return "decide_later:" + command.question_id;
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
    this.nextSeq = 0;
    this.stampCount = 0;
  }

  FixtureTransport.prototype.start = function (deliver) {
    var self = this;
    this.deliver = deliver;
    return fetch(this.url).then(function (res) {
      if (!res.ok) throw new Error("fixture unavailable");
      return res.json();
    }).then(function (script) {
      self.script = script;
      (script.initial || []).forEach(function (event) {
        if (event.seq > self.nextSeq) self.nextSeq = event.seq;
        deliver(event);
      });
    });
  };

  /* Stamp one template after the previous event has been applied, so a
     confirm takes the version the patch just landed. x_keep_version is the
     trap flag: those events keep the version written on them, and the flag
     itself is not part of the envelope. */
  FixtureTransport.prototype.stamp = function (template) {
    var event = copy(template);
    var keep = !!event.x_keep_version;
    delete event.x_keep_version;
    var bump = !!event.x_bump_revision;
    delete event.x_bump_revision;
    event.session_id = this.script.session_id;
    event.generation = state.generation || 1;
    event.seq = ++this.nextSeq;
    this.stampCount += 1;
    event.op_id = "fx-" + event.seq + "-" + this.stampCount;
    if (!keep) {
      event.artifact_version = event.type === "artifact.patch"
        ? state.artifactVersion + 1
        : state.artifactVersion;
      /* A correction raises the revision before the visitor submits the
         form. The template was written at the earlier revision; a real
         controller would answer at the current one. Traps keep theirs. */
      if (state.taskRevision && event.task_revision < state.taskRevision) {
        event.task_revision = state.taskRevision;
      }
      if (bump) {
        event.task_revision = (state.taskRevision || 1) + 1;
        if (event.payload && "superseded_by_revision" in event.payload) {
          event.payload.superseded_by_revision = event.task_revision;
        }
      }
    }
    return event;
  };

  FixtureTransport.prototype.supports = function (command) {
    return !!(this.script && this.script.on_command && this.script.on_command[commandKey(command)]);
  };

  FixtureTransport.prototype.send = function (command) {
    var templates = (this.script && this.script.on_command && this.script.on_command[commandKey(command)]) || [];
    var self = this;
    /* Release 3: a command the script has no answer for (their own words, for
       one) used to do nothing at all. Say why instead of going quiet. */
    var note = document.querySelector("[data-studio-note]");
    if (note) {
      note.textContent = templates.length ? "" :
        "This walkthrough is scripted, so only the listed options play. In a live session your own words are understood.";
      note.hidden = !templates.length ? false : true;
    }
    /* One command's answer is delivered as a unit: the finish card must not
       flash between an answer and the form that follows it. */
    self.delivering = true;
    templates.forEach(function (template) { self.deliver(self.stamp(template)); });
    self.delivering = false;
    render(state);
    return Promise.resolve();
  };

  /* Operator token (email code, sessionStorage) then session token (memory).
     Last-Event-ID is the integer seq. A clean end of a 200 stream reconnects
     at once only when it delivered a frame (an event or a ": keep-alive") or
     stayed open at least 5s — that is the controller's ~25s turn. An empty
     200 (the session is gone, but the refusal arrived after the headers) backs
     off. Five empty streams in a row end the session. Backoff (1s, doubling
     to 15s) is for that case, network errors, and 5xx. Branch on the status
     code. Refusal bodies are {"detail": "..."} and are not consulted. */
  var OPERATOR_KEY = "studio.operator";
  var EMPTY_STREAM_MS = 5000;
  var EMPTY_STREAM_LIMIT = 5;

  function randomId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
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

  function readOperator() {
    try {
      var raw = sessionStorage.getItem(OPERATOR_KEY);
      if (!raw) return null;
      var stored = JSON.parse(raw);
      if (!stored || !stored.token) return null;
      if (stored.expires_at) {
        var exp = Date.parse(stored.expires_at);
        if (!isNaN(exp) && exp <= Date.now()) {
          sessionStorage.removeItem(OPERATOR_KEY);
          return null;
        }
      }
      return { token: String(stored.token), expires_at: stored.expires_at || "" };
    } catch (err) {
      return null;
    }
  }

  function writeOperator(token, expiresAt) {
    try {
      sessionStorage.setItem(OPERATOR_KEY, JSON.stringify({
        token: token,
        expires_at: expiresAt || ""
      }));
    } catch (err) { /* storage unavailable */ }
  }

  function clearOperator() {
    try { sessionStorage.removeItem(OPERATOR_KEY); } catch (err) { /* storage unavailable */ }
  }

  function ControllerTransport(url) {
    this.base = String(url || "").replace(/\/+$/, "");
    this.deliver = null;
    this.onStatus = null;
    this.onSignIn = null;
    this.sessionId = "";
    this.token = "";
    this.operatorToken = "";
    this.creationId = "";
    this.lastEventId = "";
    this.delay = 1000;
    this.timer = null;
    this.abort = null;
    this.streamAbort = null;
    this.live = false;
    this.stopped = false;
    this.streamGen = 0;
    this.busy = false;
    this.sessionRetried = false;
    this.emptyStreak = 0;
  }

  function parseJson(text) {
    if (!text) return {};
    try { return JSON.parse(text); } catch (err) { return {}; }
  }

  ControllerTransport.prototype.retrySeconds = function (body, res) {
    var retry = body && body.retry_after != null ? body.retry_after : null;
    if ((retry == null || retry === "") && res && res.headers && res.headers.get) {
      retry = res.headers.get("retry-after");
    }
    if (typeof retry === "string" && retry !== "") retry = Number(retry);
    if (typeof retry !== "number" || !isFinite(retry) || retry < 0) return null;
    return retry;
  };

  ControllerTransport.prototype.busyText = function (body, res) {
    var msg = "The studio is busy, try again shortly.";
    var seconds = this.retrySeconds(body, res);
    if (seconds == null) return msg;
    var unit = seconds === 1 ? "second." : "seconds.";
    return msg + " Try again in " + seconds + " " + unit;
  };

  ControllerTransport.prototype.noteBusy = function (body, res) {
    this.busy = true;
    this.status(this.busyText(body, res));
  };

  ControllerTransport.prototype.scheduleAfter = function (ms, fn) {
    if (this.stopped || this.timer) return;
    var self = this;
    this.timer = setTimeout(function () {
      self.timer = null;
      fn();
    }, ms);
  };

  ControllerTransport.prototype.status = function (message) {
    if (this.onStatus) this.onStatus(message);
  };

  ControllerTransport.prototype.stop = function (message) {
    this.stopped = true;
    this.live = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortNow(this.abort);
    this.abort = null;
    this.abortNow(this.streamAbort);
    this.streamAbort = null;
    if (message) this.status(message);
    if (this.onSessionEnd) this.onSessionEnd();
  };

  ControllerTransport.prototype.abortNow = function (ctrl) {
    if (!ctrl) return;
    try { ctrl.abort(); } catch (err) { /* already aborted */ }
  };

  ControllerTransport.prototype.schedule = function (fn) {
    if (this.stopped || this.timer) return;
    var self = this;
    var wait = this.delay;
    this.delay = Math.min(this.delay * 2, 15000);
    this.timer = setTimeout(function () {
      self.timer = null;
      fn();
    }, wait);
  };

  ControllerTransport.prototype.needsSignIn = function () {
    this.live = false;
    this.operatorToken = "";
    this.token = "";
    this.sessionId = "";
    this.creationId = "";
    this.sessionRetried = false;
    this.emptyStreak = 0;
    this.lastEventId = "";
    this.streamGen += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortNow(this.abort);
    this.abort = null;
    this.abortNow(this.streamAbort);
    this.streamAbort = null;
    clearOperator();
    if (this.onSessionEnd) this.onSessionEnd();
    if (this.onSignIn) this.onSignIn();
  };

  ControllerTransport.prototype.start = function (deliver) {
    this.deliver = deliver;
    if (!this.base) return Promise.resolve();
    return this.openSession();
  };

  ControllerTransport.prototype.openSession = function () {
    var self = this;
    if (self.stopped || !self.base) return Promise.resolve();
    if (!self.operatorToken) {
      self.needsSignIn();
      return Promise.resolve();
    }
    if (!self.creationId) self.creationId = randomId();
    self.abortNow(self.abort);
    self.abort = typeof AbortController === "undefined" ? null : new AbortController();
    var opts = {
      method: "POST",
      headers: {
        "authorization": "Bearer " + self.operatorToken,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({ creation_id: self.creationId }),
      credentials: "omit",
      cache: "no-store"
    };
    if (self.abort) opts.signal = self.abort.signal;
    return fetch(self.base + "/v1/session", opts).then(function (res) {
      return res.text().then(function (text) {
        if (self.stopped) return;
        var body = parseJson(text);
        if (res.status === 401) {
          self.needsSignIn();
          return;
        }
        if (res.status === 429) {
          self.noteBusy(body, res);
          if (!self.sessionRetried) {
            self.sessionRetried = true;
            var seconds = self.retrySeconds(body, res);
            if (seconds == null) self.schedule(function () { self.openSession(); });
            else self.scheduleAfter(seconds * 1000, function () { self.openSession(); });
          }
          return;
        }
        if (res.status >= 500) {
          self.noteBusy(body, res);
          self.schedule(function () { self.openSession(); });
          return;
        }
        if (res.status === 404 || res.status === 410) {
          self.stop("This session has ended.");
          return;
        }
        if (res.status === 403) {
          self.stop("This page cannot open a studio session.");
          return;
        }
        if (res.status !== 200 || !body.session_id || !body.token) {
          self.stop("The studio could not be opened.");
          return;
        }
        self.sessionId = String(body.session_id);
        self.token = String(body.token);
        self.emptyStreak = 0;
        self.delay = 1000;
        if (self.timer) {
          clearTimeout(self.timer);
          self.timer = null;
        }
        if (self.onSession) self.onSession();
        self.connect();
      });
    }).catch(function (err) {
      if (self.stopped) return;
      if (err && err.name === "AbortError") return;
      self.schedule(function () { self.openSession(); });
    });
  };

  ControllerTransport.prototype.connect = function () {
    var self = this;
    if (self.stopped || !self.token || !self.sessionId || self.live) return;
    self.live = true;
    var gen = ++self.streamGen;
    self.abortNow(self.streamAbort);
    self.streamAbort = typeof AbortController === "undefined" ? null : new AbortController();
    var headers = {
      "accept": "text/event-stream",
      "authorization": "Bearer " + self.token
    };
    if (self.lastEventId) headers["last-event-id"] = self.lastEventId;
    var opts = { method: "GET", headers: headers, credentials: "omit", cache: "no-store" };
    if (self.streamAbort) opts.signal = self.streamAbort.signal;
    var url = self.base + "/v1/session/" + encodeURIComponent(self.sessionId) + "/events";
    fetch(url, opts).then(function (res) {
      if (self.stopped || gen !== self.streamGen) return "stale";
      if (res.status === 401) {
        self.live = false;
        self.needsSignIn();
        return "signin";
      }
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        self.live = false;
        self.stop("This session has ended.");
        return "ended";
      }
      if (res.status === 400) {
        self.live = false;
        return "bad";
      }
      if (res.status === 409) {
        self.live = false;
        self.schedule(function () { self.connect(); });
        return "retry";
      }
      if (res.status === 429) {
        return res.text().then(function (text) {
          self.live = false;
          if (self.stopped || gen !== self.streamGen) return "busy";
          var body = parseJson(text);
          self.noteBusy(body, res);
          var seconds = self.retrySeconds(body, res);
          if (seconds == null) self.schedule(function () { self.connect(); });
          else self.scheduleAfter(seconds * 1000, function () { self.connect(); });
          return "busy";
        });
      }
      if (res.status >= 500) {
        self.live = false;
        self.schedule(function () { self.connect(); });
        return "retry";
      }
      if (!res.ok || !res.body || !res.body.getReader) {
        self.live = false;
        return "bad";
      }
      return self.readStream(res, gen);
    }).then(function (why) {
      if (self.stopped || gen !== self.streamGen) return;
      if (why === "giveup") {
        self.stop("This session has ended.");
        return;
      }
      if (why !== "end" && why !== "backoff") return;
      self.live = false;
      if (why === "end") {
        self.delay = 1000;
        if (self.timer) {
          clearTimeout(self.timer);
          self.timer = null;
        }
        self.connect();
        return;
      }
      self.schedule(function () { self.connect(); });
    }).catch(function (err) {
      if (self.stopped || gen !== self.streamGen) return;
      if (err && err.name === "AbortError") return;
      self.live = false;
      self.schedule(function () { self.connect(); });
    });
  };

  ControllerTransport.prototype.readStream = function (res, gen) {
    var self = this;
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var frames = 0;
    var started = Date.now();
    function pull() {
      return reader.read().then(function (part) {
        if (self.stopped || gen !== self.streamGen) return "stopped";
        if (part.done) {
          buffer += decoder.decode();
          frames += self.consume(buffer).frames;
          return self.finishStream(frames, Date.now() - started);
        }
        buffer += decoder.decode(part.value, { stream: true });
        var taken = self.consume(buffer);
        frames += taken.frames;
        buffer = taken.rest;
        return pull();
      });
    }
    return pull();
  };

  /* A frame is one event or a comment such as ": keep-alive". An immediate
     close with neither, shorter than 5s, is not the 25s turn. */
  ControllerTransport.prototype.finishStream = function (frames, elapsed) {
    if (frames > 0 || elapsed >= EMPTY_STREAM_MS) {
      this.emptyStreak = 0;
      return "end";
    }
    this.emptyStreak += 1;
    if (this.emptyStreak >= EMPTY_STREAM_LIMIT) return "giveup";
    return "backoff";
  };

  function sseFrame(block) {
    if (!block) return false;
    var lines = block.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === ":") return true;
      var colon = line.indexOf(":");
      var field = colon < 0 ? line : line.slice(0, colon);
      if (field === "data" || field === "event" || field === "id") return true;
    }
    return false;
  }

  /* Blank-line frames. id: is the resume cursor. Several data: lines are one
     JSON value joined by newlines. A leading space after the colon is the
     optional SSE separator, not part of the value. */
  ControllerTransport.prototype.consume = function (buffer) {
    var normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var parts = normalized.split("\n\n");
    var rest = parts.pop();
    var frames = 0;
    for (var i = 0; i < parts.length; i++) {
      if (sseFrame(parts[i])) frames += 1;
      this.dispatchFrame(parts[i]);
    }
    return { rest: rest, frames: frames };
  };

  ControllerTransport.prototype.dispatchFrame = function (block) {
    if (!block) return;
    var lines = block.split("\n");
    var id = "";
    var data = [];
    var saw = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ":") continue;
      var colon = line.indexOf(":");
      var field, value;
      if (colon < 0) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.charAt(0) === " ") value = value.slice(1);
      }
      if (field === "id") id = value;
      else if (field === "data") {
        data.push(value);
        saw = true;
      }
    }
    if (/^\d+$/.test(id)) this.lastEventId = id;
    if (!saw) return;
    var text = data.join("\n");
    if (!text) return;
    var event;
    try { event = JSON.parse(text); } catch (err) { return; }
    this.delay = 1000;
    if (this.busy) {
      this.busy = false;
      this.status("");
    }
    if (this.deliver) this.deliver(event);
  };

  ControllerTransport.prototype.send = function (command) {
    var self = this;
    if (self.stopped || !self.sessionId || !self.token) return Promise.resolve();
    var url = self.base + "/v1/session/" + encodeURIComponent(self.sessionId) + "/commands";
    return fetch(url, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + self.token,
        "content-type": "application/json",
        "accept": "application/json"
      },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(command)
    }).then(function (res) {
      return res.text().then(function (text) {
        if (self.stopped) return;
        var body = parseJson(text);
        if (res.status === 409) {
          self.status("Catching up");
          return;
        }
        if (res.status === 401) {
          self.needsSignIn();
          return;
        }
        if (res.status === 404 || res.status === 410) {
          self.stop("This session has ended.");
          return;
        }
        if (res.status === 429) self.status(self.busyText(body, res));
      });
    }).catch(function () { /* the event stream reports a dead controller */ });
  };

  /* --- voice ----------------------------------------------------------- */
  /* GET /v1/health (no auth) is the voice flag. Cloud Run reserves paths
     ending in z, so this is not /healthz. Missing or not 200: hide Talk.
     One peer connection, one autoplay audio element, nothing recorded.
     A response.done that was cancelled because the visitor spoke
     (reason turn_detected) is barge-in: leave the call up, show no error. */

  var voice = null;

  function endsAtMs(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && isFinite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
      var numeric = Number(value);
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    var parsed = Date.parse(value);
    return isNaN(parsed) ? null : parsed;
  }

  function asPromise(value) {
    if (value && typeof value.then === "function") return value;
    return Promise.resolve(value);
  }

  function waitIce(pc) {
    var gathering = pc && pc.iceGatheringState;
    if (!gathering || gathering === "complete") return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        if (pc.removeEventListener) pc.removeEventListener("icegatheringstatechange", onState);
        resolve();
      }
      function onState() {
        if (pc.iceGatheringState === "complete") finish();
      }
      if (pc.addEventListener) pc.addEventListener("icegatheringstatechange", onState);
      var prior = pc.onicecandidate;
      pc.onicecandidate = function (ev) {
        if (typeof prior === "function") prior(ev);
        if (!ev || !ev.candidate) finish();
      };
    });
  }

  function spokenLine(event) {
    var payload = event.payload || {};
    if (event.type === "question.asked") return (payload.question && payload.question.prompt) || "";
    if (event.type === "progress" || event.type === "confirm") return payload.text || "";
    if (event.type === "decision.batch") {
      return (payload.title ? payload.title + ". " : "") + "The options are on screen.";
    }
    return "";
  }

  function isBargeIn(msg) {
    if (!msg || msg.type !== "response.done") return false;
    var response = msg.response || {};
    var status = msg.status || response.status;
    var details = msg.status_details || response.status_details || {};
    var reason = msg.reason || details.reason;
    return status === "cancelled" && reason === "turn_detected";
  }

  function Voice(owner) {
    this.transport = owner;
    this.feature = false;
    this.sessionOpen = false;
    this.active = false;
    this.starting = false;
    this.epoch = 0;
    this.pc = null;
    this.channel = null;
    this.tracks = [];
    this.pending = [];
    this.heard = {};
    this.caption = "";
    this.timer = null;
    this.abort = null;
    this.statusText = "";
  }

  Voice.prototype.attach = function () {
    var self = this;
    this.ensureUi();
    this.transport.onSession = function () {
      self.sessionOpen = true;
      self.sync();
    };
    this.transport.onSessionEnd = function () {
      self.sessionOpen = false;
      self.hangup("session");
    };
    this.loadFeature();
  };

  Voice.prototype.loadFeature = function () {
    var self = this;
    if (!this.transport.base) return;
    fetch(this.transport.base + "/v1/health", {
      method: "GET",
      headers: { "accept": "application/json" },
      credentials: "omit",
      cache: "no-store"
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) return null;
        return parseJson(text);
      });
    }).then(function (body) {
      self.feature = !!(body && body.features && body.features.voice === true);
      self.sync();
    }).catch(function () {
      self.feature = false;
      self.sync();
    });
  };

  Voice.prototype.ensureUi = function () {
    if (document.querySelector("[data-studio-voice]")) return;
    var bar = el("div", { "class": "studio-voice", "data-studio-voice": "" });
    bar.hidden = true;
    bar.appendChild(text("button", "Talk", { "type": "button", "data-action": "talk" }));
    var stop = text("button", "Stop", { "type": "button", "data-action": "stop-voice" });
    stop.hidden = true;
    bar.appendChild(stop);
    bar.appendChild(text("span", "", { "data-studio-voice-status": "", "role": "status" }));
    var caption = text("span", "", { "data-studio-caption": "", "class": "studio-caption" });
    caption.hidden = true;
    bar.appendChild(caption);
    var audio = el("audio", { "data-studio-voice-audio": "", "autoplay": "", "playsinline": "" });
    audio.autoplay = true;
    var anchor = document.getElementById("studio-status");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else app.appendChild(bar);
    (bar.parentNode || app).appendChild(audio);
  };

  Voice.prototype.setStatus = function (message) {
    this.statusText = message || "";
    state.voiceStatus = this.statusText;
    var node = document.querySelector("[data-studio-voice-status]");
    if (node) node.textContent = this.statusText;
    var live = document.getElementById("studio-live");
    if (live) live.textContent = liveText(state);
  };

  Voice.prototype.sync = function () {
    var bar = document.querySelector("[data-studio-voice]");
    if (!bar) return;
    var talk = bar.querySelector("[data-action='talk']");
    var stop = bar.querySelector("[data-action='stop-voice']");
    var open = this.feature && this.sessionOpen && !state.ended;
    var calling = this.active || this.starting;
    if (talk) talk.hidden = !open || calling;
    if (stop) stop.hidden = !calling;
    bar.hidden = !(open || calling || this.statusText);
  };

  Voice.prototype.showCaption = function (value) {
    var node = document.querySelector("[data-studio-caption]");
    if (!node) return;
    node.textContent = value || "";
    node.hidden = !value;
  };

  Voice.prototype.hideCaption = function () {
    this.caption = "";
    var node = document.querySelector("[data-studio-caption]");
    if (!node) return;
    node.textContent = "";
    node.hidden = true;
  };

  Voice.prototype.sendChannel = function (payload) {
    var line = JSON.stringify(payload);
    if (this.channel && this.channel.readyState === "open" && this.channel.send) {
      this.channel.send(line);
      return;
    }
    this.pending.push(line);
  };

  Voice.prototype.flush = function () {
    if (!this.channel || this.channel.readyState !== "open" || !this.channel.send) return;
    var queued = this.pending.splice(0, this.pending.length);
    for (var i = 0; i < queued.length; i++) this.channel.send(queued[i]);
  };

  Voice.prototype.speak = function (text) {
    if (!text) return;
    this.sendChannel({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say this to the visitor, naturally: " + text }]
      }
    });
    this.sendChannel({
      type: "response.create",
      response: { output_modalities: ["audio"] }
    });
  };

  Voice.prototype.onCommitted = function (event) {
    if (!event) return;
    if (event.type === "session.ended") {
      this.sessionOpen = false;
      this.hangup("ended");
      return;
    }
    if (!this.active && !this.starting) return;
    var text = spokenLine(event);
    if (text) this.speak(text);
  };

  Voice.prototype.onChannelMessage = function (raw) {
    var msg = raw;
    if (typeof raw === "string") {
      try { msg = JSON.parse(raw); } catch (err) { return; }
    } else if (raw && typeof raw === "object" && typeof raw.data === "string") {
      try { msg = JSON.parse(raw.data); } catch (err) { return; }
    }
    if (!msg || typeof msg !== "object") return;
    /* Cancelled because the visitor started talking. Not a failure. */
    if (isBargeIn(msg) || msg.type === "response.done") return;
    if (msg.type === "conversation.item.input_audio_transcription.delta") {
      this.caption += msg.delta || "";
      this.showCaption(this.caption);
      return;
    }
    if (msg.type === "conversation.item.input_audio_transcription.completed") this.onTranscript(msg);
  };

  Voice.prototype.onTranscript = function (msg) {
    var itemId = msg.item_id == null ? "" : String(msg.item_id);
    if (typeof msg.transcript === "string") {
      this.caption = msg.transcript;
      this.showCaption(this.caption);
    }
    if (!itemId || typeof msg.transcript !== "string") return;
    if (this.heard[itemId]) return;
    this.heard[itemId] = true;
    send({ type: "utterance", item_id: itemId, transcript: msg.transcript });
  };

  Voice.prototype.closeMedia = function () {
    var audio = document.querySelector("[data-studio-voice-audio]");
    if (audio) {
      try { audio.srcObject = null; } catch (err) { /* element went away */ }
    }
    if (this.channel) {
      try { this.channel.close(); } catch (err) { /* already closed */ }
      this.channel = null;
    }
    if (this.pc) {
      try { this.pc.ontrack = null; } catch (err) { /* already gone */ }
      try { this.pc.close(); } catch (err) { /* already closed */ }
      this.pc = null;
    }
    var tracks = this.tracks || [];
    this.tracks = [];
    tracks.forEach(function (track) {
      try { if (track && track.stop) track.stop(); } catch (err) { /* already stopped */ }
    });
    this.pending = [];
  };

  Voice.prototype.hangup = function (reason) {
    var was = this.active || this.starting;
    this.epoch += 1;
    this.active = false;
    this.starting = false;
    if (this.abort) {
      try { this.abort.abort(); } catch (err) { /* already aborted */ }
      this.abort = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closeMedia();
    this.hideCaption();
    if (was && reason !== "fail") this.setStatus("Voice ended.");
    this.sync();
  };

  Voice.prototype.fail = function (message) {
    this.hangup("fail");
    this.setStatus(message);
    this.sync();
  };

  Voice.prototype.userStop = function () {
    if (!this.active && !this.starting) return;
    send({ type: "stop" });
    this.hangup("stop");
  };

  Voice.prototype.armEnds = function (endsAt) {
    var self = this;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    var at = endsAtMs(endsAt);
    if (at == null) return;
    var wait = at - Date.now();
    if (wait < 0) wait = 0;
    if (wait > 2147483647) wait = 2147483647;
    var epoch = this.epoch;
    this.timer = setTimeout(function () {
      self.timer = null;
      if (epoch !== self.epoch) return;
      self.hangup("timeout");
    }, wait);
  };

  Voice.prototype.start = function () {
    var self = this;
    if (self.active || self.starting || !self.feature || !self.sessionOpen || state.ended) return;
    if (!self.transport.sessionId || !self.transport.token) return;
    self.starting = true;
    self.heard = {};
    self.pending = [];
    self.epoch += 1;
    var epoch = self.epoch;
    self.sync();
    var media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") {
      self.starting = false;
      self.setStatus("Microphone blocked. You can still type.");
      self.sync();
      return;
    }
    media.getUserMedia({ audio: true }).then(function (stream) {
      if (epoch !== self.epoch) {
        var leftover = stream && stream.getTracks ? stream.getTracks() : [];
        leftover.forEach(function (track) {
          try { if (track && track.stop) track.stop(); } catch (err) { /* already stopped */ }
        });
        return;
      }
      return self.offer(stream, epoch);
    }, function () {
      if (epoch !== self.epoch) return;
      self.starting = false;
      self.setStatus("Microphone blocked. You can still type.");
      self.sync();
    });
  };

  Voice.prototype.offer = function (stream, epoch) {
    var self = this;
    var tracks = stream && stream.getTracks ? stream.getTracks() : [];
    self.tracks = tracks.slice ? tracks.slice() : tracks;
    if (typeof RTCPeerConnection !== "function") {
      self.fail("Voice could not start. You can still type.");
      return;
    }
    var pc;
    try {
      pc = new RTCPeerConnection();
    } catch (err) {
      self.fail("Voice could not start. You can still type.");
      return;
    }
    if (epoch !== self.epoch) {
      try { pc.close(); } catch (closeErr) { /* raced with Stop */ }
      self.closeMedia();
      return;
    }
    self.pc = pc;
    self.tracks.forEach(function (track) {
      pc.addTrack(track, stream);
    });
    var channel;
    try {
      channel = pc.createDataChannel("oai-events");
    } catch (err) {
      self.fail("Voice could not start. You can still type.");
      return;
    }
    self.channel = channel;
    channel.onmessage = function (ev) {
      if (epoch !== self.epoch) return;
      self.onChannelMessage(ev ? ev.data : null);
    };
    channel.onopen = function () {
      if (epoch !== self.epoch) return;
      self.flush();
    };
    pc.ontrack = function (ev) {
      if (epoch !== self.epoch) return;
      var audio = document.querySelector("[data-studio-voice-audio]");
      if (!audio) return;
      var remote = ev && ev.streams && ev.streams[0];
      if (!remote && ev && ev.track && typeof MediaStream === "function") {
        try { remote = new MediaStream([ev.track]); } catch (err) { remote = null; }
      }
      if (remote) audio.srcObject = remote;
    };
    return asPromise(pc.createOffer()).then(function (desc) {
      return asPromise(pc.setLocalDescription(desc)).then(function () { return waitIce(pc); });
    }).then(function () {
      if (epoch !== self.epoch) return;
      var local = pc.localDescription;
      var sdp = local && local.sdp ? String(local.sdp) : "";
      if (!sdp) throw new Error("missing offer");
      return self.postOffer(sdp, epoch);
    }).then(function () {
      if (epoch !== self.epoch) return;
      if (self.channel && self.channel.readyState === "open") self.flush();
    }).catch(function (err) {
      if (epoch !== self.epoch) return;
      if (err && err.name === "AbortError") return;
      self.fail("Voice could not start. You can still type.");
    });
  };

  Voice.prototype.postOffer = function (sdp, epoch) {
    var self = this;
    self.abort = typeof AbortController === "undefined" ? null : new AbortController();
    var opts = {
      method: "POST",
      headers: {
        "authorization": "Bearer " + self.transport.token,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({ sdp: sdp }),
      credentials: "omit",
      cache: "no-store"
    };
    if (self.abort) opts.signal = self.abort.signal;
    var url = self.transport.base + "/v1/session/" + encodeURIComponent(self.transport.sessionId) + "/voice";
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        if (epoch !== self.epoch) return;
        var body = parseJson(text);
        if (res.status === 200 && body.sdp) {
          return asPromise(self.pc.setRemoteDescription({ type: "answer", sdp: String(body.sdp) })).then(function () {
            if (epoch !== self.epoch) return;
            self.starting = false;
            self.active = true;
            self.setStatus("Listening");
            self.armEnds(body.ends_at);
            self.sync();
          });
        }
        if (res.status === 409) {
          self.fail("Voice is busy for this session.");
          return;
        }
        if (res.status === 410) {
          self.hangup("ended");
          self.transport.stop("This session has ended.");
          return;
        }
        if (res.status === 401) {
          self.hangup("fail");
          self.transport.needsSignIn();
          return;
        }
        self.fail("Voice could not start. You can still type.");
      });
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

  /* A live controller can answer any command. The scripted walkthrough can
     answer only what its script lists, so it says what it supports. */
  function canSend(command) {
    return !(transport && transport.supports) || transport.supports(command);
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
      if (canSend({ type: "decide_later", question_id: question.question_id })) {
        actions.appendChild(text("button", "Decide later", {
          "type": "button",
          "class": "studio-text-btn",
          "data-action": "later",
          "data-question-id": question.question_id
        }));
      }
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
      /* A deferred decision can be made now; an answered one changed. Only
         where the other side can answer it (Codex review of #146: the
         walkthrough offered Change on form questions it had no reply for). */
      var again = question.status === "answered" ? "Change this decision"
        : question.status === "deferred" ? "Decide now" : "";
      if (again && canSend({ type: "change_decision", question_id: question.question_id })) {
        card.appendChild(text("button", again, {
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

  function walkthroughDone(state) {
    var later = state.questionOrder.filter(function (id) {
      return state.questions[id] && state.questions[id].status === "deferred";
    }).length;
    return "That is the whole walkthrough: every decision you made changed the prototype as you made it." +
      (later === 1 ? " You left one for later." : later > 1 ? " You left " + later + " for later." : "") +
      " In a live session you can change any decision and keep going by voice or by typing.";
  }

  function allDecided(state) {
    if (!state.questionOrder.length || state.activeQuestionId || state.batch || state.queue.length) return false;
    return state.questionOrder.every(function (id) {
      return !state.questions[id] || state.questions[id].status !== "open";
    });
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

    /* Release 4: the walkthrough finishes somewhere. Once every decision is
       made it says so and offers the next step; any decision can still be
       changed. A controller's session.ended is final: nothing is left to press. */
    var finish = document.querySelector("[data-studio-finish]");
    if (finish) {
      var walked = !state.ended && transport instanceof FixtureTransport && !transport.delivering &&
        allDecided(state);
      finish.hidden = !(state.ended || walked);
      var reason = finish.querySelector("[data-studio-finish-text]");
      if (reason) reason.textContent = state.ended ? state.endReason : walkthroughDone(state);
    }
    if (state.ended) {
      var controls = document.querySelectorAll(
        "#studio-active button, #studio-active input, #studio-batch button, #studio-batch input, " +
        "#studio-history button, #studio-history input");
      for (var c = 0; c < controls.length; c++) controls[c].disabled = true;
    }

    var live = document.getElementById("studio-live");
    if (live) live.textContent = liveText(state);
    if (voice) voice.sync();
  }

  function liveText(state) {
    var parts = [];
    if (state.announcements.length) parts.push(state.announcements.join(" "));
    if (state.statusText) parts.push(state.statusText);
    if (state.voiceStatus) parts.push(state.voiceStatus);
    return parts.join(" ");
  }

  function showStatus(message) {
    state.statusText = message || "";
    var node = document.getElementById("studio-status");
    if (node) {
      node.textContent = state.statusText;
      node.hidden = !state.statusText;
    }
    var live = document.getElementById("studio-live");
    if (live) live.textContent = liveText(state);
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
  var sentLog = null;

  afterSettle = function () {
    if (drain(state)) render(state);
  };

  function onEvent(event) {
    if (ingest(state, event)) render(state);
  }

  function send(fields) {
    if (!transport) return;
    var command = buildCommand(state, fields);
    if (sentLog) sentLog.push(command);
    transport.send(command);
  }

  var app = document.getElementById("studio-app");

  app.addEventListener("click", function (ev) {
    var button = ev.target.closest("button");
    if (!button || !app.contains(button)) return;
    var action = button.getAttribute("data-action");
    var questionId = button.getAttribute("data-question-id");
    if (action === "restart") {
      location.reload();
      return;
    }
    if (action === "talk") {
      if (voice) voice.start();
      return;
    }
    if (action === "stop-voice") {
      if (voice) voice.userStop();
      return;
    }
    if (state.ended) return;
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

  /* Release 3: Enter in "Say it your way" sends, like the button beside it.
     Not while an input method is composing: that Enter commits the characters
     being composed (Japanese, Chinese, Korean), it is not "send". */
  app.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" || !ev.target.matches || !ev.target.matches("[data-freeform-input]")) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    var sendButton = ev.target.closest("[data-freeform]") &&
      ev.target.closest("[data-freeform]").querySelector('[data-action="freeform-send"]');
    if (sendButton) sendButton.click();
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

  var SIGNIN_NOTE = "If that address is allowed, a code is on its way.";
  var signIn = { clientKey: "", challengeId: "", email: "" };

  function signInForm() {
    var form = document.getElementById("studio-signin");
    if (form) return form;
    form = el("form", {
      "id": "studio-signin",
      "data-studio-signin": "",
      "class": "studio-signin",
      "novalidate": "novalidate"
    });
    form.appendChild(text("p", "Sign in with the email allowed to open a session.", { "class": "studio-signin-lead" }));
    var emailLabel = el("label", { "class": "studio-signin-label" });
    emailLabel.appendChild(document.createTextNode("Email"));
    emailLabel.appendChild(el("input", {
      "type": "email",
      "data-studio-email": "",
      "autocomplete": "email",
      "required": "required"
    }));
    form.appendChild(emailLabel);
    form.appendChild(text("button", "Send code", { "type": "submit", "data-studio-send-code": "" }));
    var note = text("p", "", { "data-studio-signin-note": "", "class": "studio-signin-note" });
    note.hidden = true;
    form.appendChild(note);
    var codeLabel = el("label", { "class": "studio-signin-label", "data-studio-code-label": "" });
    codeLabel.hidden = true;
    codeLabel.appendChild(document.createTextNode("Code"));
    codeLabel.appendChild(el("input", {
      "type": "text",
      "inputmode": "numeric",
      "maxlength": "6",
      "data-studio-code": "",
      "autocomplete": "one-time-code"
    }));
    form.appendChild(codeLabel);
    var check = text("button", "Check code", { "type": "button", "data-studio-check-code": "" });
    check.hidden = true;
    form.appendChild(check);
    var err = text("p", "", { "data-studio-signin-error": "", "class": "studio-signin-error" });
    err.hidden = true;
    form.appendChild(err);
    var anchor = document.getElementById("studio-status");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(form, anchor);
    else app.appendChild(form);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!codeLabel.hidden) verifyAuth();
      else startAuth();
    });
    check.addEventListener("click", function () { verifyAuth(); });
    return form;
  }

  function showSignIn(step) {
    var form = signInForm();
    form.hidden = false;
    var note = form.querySelector("[data-studio-signin-note]");
    var codeLabel = form.querySelector("[data-studio-code-label]");
    var check = form.querySelector("[data-studio-check-code]");
    var err = form.querySelector("[data-studio-signin-error]");
    var showCode = step === "code";
    note.hidden = !showCode;
    note.textContent = showCode ? SIGNIN_NOTE : "";
    codeLabel.hidden = !showCode;
    check.hidden = !showCode;
    if (!showCode) {
      signIn.challengeId = "";
      signIn.clientKey = "";
    }
    if (err && step !== "rejected") {
      err.hidden = true;
      err.textContent = "";
    }
  }

  function hideSignIn() {
    var form = document.getElementById("studio-signin");
    if (form) form.hidden = true;
  }

  function setSignInError(message) {
    var form = signInForm();
    var err = form.querySelector("[data-studio-signin-error]");
    err.textContent = message || "";
    err.hidden = !message;
  }

  function startAuth() {
    var form = signInForm();
    var input = form.querySelector("[data-studio-email]");
    var email = String(input && input.value || "").trim().toLowerCase();
    if (!email || !transport) return;
    signIn.email = email;
    signIn.clientKey = randomId();
    signIn.challengeId = "";
    setSignInError("");
    fetch(transport.base + "/v1/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ email: email, client_key: signIn.clientKey })
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = parseJson(text);
        if (res.status === 200) {
          signIn.challengeId = body.challenge_id ? String(body.challenge_id) : "";
          showSignIn("code");
          return;
        }
        setSignInError("The studio could not be reached.");
      });
    }).catch(function () {
      setSignInError("The studio could not be reached.");
    });
  }

  function verifyAuth() {
    if (!transport || !signIn.challengeId) return;
    var form = signInForm();
    var input = form.querySelector("[data-studio-code]");
    var code = String(input && input.value || "").trim();
    setSignInError("");
    fetch(transport.base + "/v1/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({
        challenge_id: signIn.challengeId,
        email: signIn.email,
        code: code,
        client_key: signIn.clientKey
      })
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = parseJson(text);
        if (res.status === 401) {
          clearOperator();
          setSignInError("That code was not accepted.");
          return;
        }
        if (res.status === 200 && body.token) {
          writeOperator(String(body.token), body.expires_at || "");
          hideSignIn();
          showStatus("");
          transport.operatorToken = String(body.token);
          transport.creationId = "";
          transport.sessionRetried = false;
          transport.stopped = false;
          transport.start(controllerDeliver);
          return;
        }
        setSignInError("The studio could not be reached.");
      });
    }).catch(function () {
      setSignInError("The studio could not be reached.");
    });
  }

  function controllerDeliver(event) {
    var version = state.artifactVersion;
    var generation = state.generation;
    onEvent(event);
    if (!event || event.type !== "artifact.snapshot") return;
    if (state.artifactVersion === version && state.generation === generation) return;
    var node = document.getElementById("studio-status");
    if (node && /catching up/i.test(node.textContent || "")) showStatus("");
  }

  var params = new URLSearchParams(location.search);
  var controllerUrl = (app.getAttribute("data-controller-url") || "").trim();
  var explicitFixture = params.get("script") === "fixture";
  /* Three modes. ?script=fixture is the acceptance harness (hooks included).
     A data-controller-url uses the live transport. Neither plays the labelled
     walkthrough and does not install the hooks. */
  if (explicitFixture || !controllerUrl) {
    if (explicitFixture) {
      sentLog = [];
      window.__studio = {
        sent: sentLog,
        inject: function (event) { onEvent(event); }
      };
    }
    var demo = document.querySelector("[data-studio-demo]");
    if (demo) demo.hidden = false;
    transport = new FixtureTransport("/studio/contract/fixtures/scripted-session.json");
    transport.start(onEvent);
  } else {
    transport = new ControllerTransport(controllerUrl);
    transport.onStatus = showStatus;
    voice = new Voice(transport);
    voice.attach();
    transport.onSignIn = function () {
      clearOperator();
      showStatus("");
      showSignIn("email");
    };
    var stored = readOperator();
    if (stored && stored.token) {
      transport.operatorToken = stored.token;
      transport.start(controllerDeliver);
    } else {
      showSignIn("email");
    }
  }
})();
