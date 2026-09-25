/* Studio page. Renders typed artifact nodes and one active decision.
   The bare URL plays the labelled walkthrough. Fixture mode (?script=fixture)
   replays studio/contract/fixtures/scripted-session.json and installs the hooks.
   ?live=1 with a data-controller-url signs in (email code), then POSTs /v1/session
   and fetch-streams events. That parameter only chooses the mode: the controller
   URL comes from the attribute, never from the query. Tokens are headers, never
   part of a URL.
   Start conversation is shown only when GET /health returns 200 with
   features.voice and a live session is open. A failed or non-200 health
   check hides it. Nothing touches the microphone before that press. The
   scripted walkthrough never shows it. The microphone stays open across
   turns until End conversation or the session ends. */
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
      statusText: ""
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
      state.revealSeq = (state.revealSeq || 0) + 1;
      state.revealIds = touched.slice();
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
      closeVoiceBecauseSessionEnded();
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
    if (transport && transport.noteApplied) transport.noteApplied(event);
    speakCommitted(event);
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
  var COMMAND_RETRY_LIMIT = 3;

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

  /* The controller's expires_at is Unix seconds, not an ISO string. */
  function expiresAtMs(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && isFinite(value)) return value * 1000;
    if (typeof value === "string") {
      if (/^[0-9]+$/.test(value)) return Number(value) * 1000;
      var parsed = Date.parse(value);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  function readOperator() {
    try {
      var raw = sessionStorage.getItem(OPERATOR_KEY);
      if (!raw) return null;
      var stored = JSON.parse(raw);
      if (!stored || !stored.token) return null;
      if (stored.expires_at != null && stored.expires_at !== "") {
        var exp = expiresAtMs(stored.expires_at);
        if (exp == null || exp <= Date.now()) {
          sessionStorage.removeItem(OPERATOR_KEY);
          return null;
        }
      }
      return { token: String(stored.token), expires_at: stored.expires_at };
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
    syncSignOut();
  }

  function clearOperator() {
    try { sessionStorage.removeItem(OPERATOR_KEY); } catch (err) { /* storage unavailable */ }
    syncSignOut();
  }

  /* Release 8: a signed-in operator can sign out. Shown only in live mode
     while an operator sign-in is stored. */
  function syncSignOut() {
    var button = document.querySelector("[data-studio-signout]");
    if (!button) return;
    button.hidden = !(transport instanceof ControllerTransport && readOperator());
  }

  /* Ends the live session (and any voice call) on the controller first, so
     nothing keeps running after the operator leaves, then forgets the sign-in
     and returns to the public walkthrough. Waits at most 3 s for the end. */
  /* Codex review of #162: once the operator asks to leave, nothing but the
     stop may reach the controller - queued and held ordinary commands are
     dropped and every decision control is disabled (render keeps them
     disabled). A stop that is not confirmed within 3 s is said plainly, with
     Try again or an explicit Leave anyway; leaving is never silent. */
  var signingOut = false;
  var SIGNOUT_UNCONFIRMED = "The live session could not be confirmed as ended. " +
    "It ends on its own when its time runs out (at most 10 minutes).";

  function disableForSignOut() {
    var controls = document.querySelectorAll(
      "#studio-active button, #studio-active input, #studio-batch button, #studio-batch input, " +
      "#studio-history button, #studio-history input, [data-studio-talk], [data-freeform-input]");
    for (var c = 0; c < controls.length; c++) controls[c].disabled = true;
  }

  function leaveSignedOut() {
    clearOperator();
    location.assign("/studio/");
  }

  function awaitSignOutEnd() {
    var retry = document.querySelector("[data-studio-signout-retry]");
    var leave = document.querySelector("[data-studio-signout-leave]");
    if (retry) retry.hidden = true;
    if (leave) leave.hidden = true;
    var deadline = Date.now() + 3000;
    (function wait() {
      if (state.ended) { leaveSignedOut(); return; }
      if (Date.now() > deadline) {
        showStatus(SIGNOUT_UNCONFIRMED);
        if (retry) { retry.hidden = false; retry.disabled = false; }
        if (leave) { leave.hidden = false; leave.disabled = false; }
        return;
      }
      setTimeout(wait, 100);
    })();
  }

  function signOut() {
    var button = document.querySelector("[data-studio-signout]");
    if (button) button.disabled = true;
    var open = transport instanceof ControllerTransport && transport.sessionId && !state.ended;
    if (!open) { leaveSignedOut(); return; }
    signingOut = true;
    transport.commandQueue = [];
    if (transport.commandRetry && transport.commandRetry.type !== "stop") {
      transport.commandRetry = null;
      transport.commandHold = false;
    }
    disableForSignOut();
    if (voice.phase === "connecting" || voice.phase === "open") stopVoice();
    else send({ type: "stop" });
    awaitSignOutEnd();
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
    this.resetCommands();
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

  ControllerTransport.prototype.status = function (message, retryAction, owner) {
    var self = this;
    /* A failed Stop is the visitor's last action and owns the single recovery
       control until it is retried, succeeds, or the session ends. An ordinary
       command may still finish in the background, but it must not erase that
       recovery path. */
    if (this.stopHeld && owner !== "stop") {
      message = this.stopNotice || "The studio could not be reached.";
      retryAction = function () { self.retryHeldStop(); };
    }
    if (this.onStatus) this.onStatus(message, retryAction || null);
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
    this.clearCommandTimer();
    if (this.workingTimer) { clearTimeout(this.workingTimer); this.workingTimer = null; }
    this.commandHold = false;
    this.clearStopTimer();
    this.stopCommand = null;
    this.stopFlight = null;
    this.stopAwaitingCatchUp = false;
    this.stopHeld = false;
    this.stopNotice = "";
    if (message) this.status(message);
    if (this.onSessionEnd) this.onSessionEnd();
    if (this.onLive) this.onLive();
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
    this.resetCommands();
    if (this.onSignIn) this.onSignIn();
    if (this.onSessionEnd) this.onSessionEnd();
    if (this.onLive) this.onLive();
  };

  /* One command in flight. The rest wait, and expected_version is stamped
     when a command is sent, from the newest applied event or the previous
     receipt. A 409 is retried once, immediately when the applied version is
     already newer than the one that failed, otherwise when a newer version
     arrives. A named current_version does not accept a version that is not
     newer than that failure and reaches a named target. A 429, 5xx, or network
     failure keeps this command and its exact payload, retries it a finite
     number of times, then offers an explicit retry before anything queued
     behind it. Other 4xx refusals wait for that explicit retry immediately. */
  ControllerTransport.prototype.resetCommands = function () {
    this.commandGen = (this.commandGen || 0) + 1;
    this.commandQueue = [];
    this.commandFlight = null;
    if (this.workingTimer) { clearTimeout(this.workingTimer); this.workingTimer = null; }
    this.commandRetry = null;
    this.knownVersion = 0;
    this.awaitingCatchUp = false;
    this.catchTarget = null;
    this.catchFloor = 0;
    this.retriedCommands = [];
    this.retryIds = [];
    this.commandHold = false;
    this.commandDelay = 1000;
    this.clearCommandTimer();
    this.stopCommand = null;
    this.stopFlight = null;
    this.stopDelay = 1000;
    this.stopAwaitingCatchUp = false;
    this.stopCatchFloor = 0;
    this.stopCatchTarget = null;
    this.stopRenewOnRetry = false;
    this.stopHeld = false;
    this.stopNotice = "";
    this.clearStopTimer();
    if (this.onStatus) this.status("");
  };

  /* Release 17: a live command runs the whole Claude turn before it answers,
     about ten seconds, and the page showed nothing meanwhile. After a short
     pause a quiet status says the studio is working; it never replaces a
     retry, catching-up or stop message, and it goes as soon as the answer
     (or a failure) comes back. */
  var WORKING_TEXT = "Working on it…";
  ControllerTransport.prototype.startWorking = function (command) {
    var self = this;
    var gen = self.commandGen;
    self.clearWorking();
    self.workingTimer = setTimeout(function () {
      self.workingTimer = null;
      if (self.commandFlight === command && gen === self.commandGen && !self.stopped &&
          !self.stopCommand && !self.stopHeld && !state.ended && !state.statusText) {
        self.status(WORKING_TEXT);
      }
    }, 700);
  };

  ControllerTransport.prototype.clearWorking = function () {
    if (this.workingTimer) {
      clearTimeout(this.workingTimer);
      this.workingTimer = null;
    }
    if (state.statusText === WORKING_TEXT) this.status("");
  };

  ControllerTransport.prototype.clearCommandTimer = function () {
    if (this.commandTimer) {
      clearTimeout(this.commandTimer);
      this.commandTimer = null;
    }
  };

  /* Command bookkeeping must never enter the serialized body. The controller
     binds command_id to the exact JSON payload, so an ambiguous retry must
     preserve both the id and every body field byte-for-byte. */
  ControllerTransport.prototype.commandMeta = function (command, key, value) {
    if (!Object.prototype.hasOwnProperty.call(command, key)) {
      Object.defineProperty(command, key, {
        value: value, writable: true, configurable: true, enumerable: false
      });
    } else {
      command[key] = value;
    }
    return value;
  };

  ControllerTransport.prototype.clearStopTimer = function () {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  };

  ControllerTransport.prototype.noteVersion = function (version) {
    if (typeof version !== "number" || !isFinite(version)) return;
    if (version > this.knownVersion) this.knownVersion = version;
  };

  ControllerTransport.prototype.newestVersion = function () {
    var version = this.knownVersion || 0;
    if (typeof state.artifactVersion === "number" && state.artifactVersion > version) {
      version = state.artifactVersion;
    }
    return version;
  };

  ControllerTransport.prototype.clearCatchingUp = function () {
    if (state.statusText === "Catching up") this.status("");
  };

  ControllerTransport.prototype.hasCaughtUp = function (version) {
    if (!(typeof version === "number" && isFinite(version) && version > this.catchFloor)) return false;
    return !(typeof this.catchTarget === "number" && isFinite(this.catchTarget)) ||
      version >= this.catchTarget;
  };

  ControllerTransport.prototype.stopHasCaughtUp = function (version) {
    if (!(typeof version === "number" && isFinite(version) && version > this.stopCatchFloor)) return false;
    return !(typeof this.stopCatchTarget === "number" && isFinite(this.stopCatchTarget)) ||
      version >= this.stopCatchTarget;
  };

  ControllerTransport.prototype.pumpCommands = function () {
    if (this.stopped || state.ended || this.commandFlight || this.awaitingCatchUp || this.commandHold) return;
    var command = this.commandRetry || this.commandQueue.shift();
    if (!command) return;
    if (command === this.commandRetry) this.commandRetry = null;
    this.postCommand(command);
  };

  ControllerTransport.prototype.holdCommand = function (command, notice) {
    var self = this;
    this.clearCommandTimer();
    this.commandRetry = command;
    this.commandHold = true;
    this.status(notice || state.statusText || "The studio could not be reached.", function () {
      self.retryHeldCommand();
    });
  };

  ControllerTransport.prototype.retryHeldCommand = function () {
    if (this.stopped || state.ended || !this.commandRetry) return;
    this.commandMeta(this.commandRetry, "__studioFailures", 0);
    this.commandDelay = 1000;
    this.commandHold = false;
    this.status("");
    this.pumpCommands();
  };

  /* Keep the command that just failed. The queue stays behind it, and the
     command_id and exact payload stay the same: the controller may already
     have applied it. Automatic retries are finite; after that the same command
     remains available behind an explicit retry button. */
  ControllerTransport.prototype.failCommand = function (command, notice, waitMs) {
    var failures = (Number(command.__studioFailures) || 0) + 1;
    this.commandMeta(command, "__studioFailures", failures);
    this.commandRetry = command;
    this.commandHold = true;
    if (notice) this.status(notice);
    if (failures >= COMMAND_RETRY_LIMIT) {
      this.holdCommand(command, notice);
      return;
    }
    this.scheduleCommandRetry(waitMs);
  };

  ControllerTransport.prototype.scheduleCommandRetry = function (waitMs) {
    if (this.stopped || this.commandTimer) return;
    var self = this;
    var wait = typeof waitMs === "number" ? waitMs : (this.commandDelay || 1000);
    if (typeof waitMs !== "number") this.commandDelay = Math.min(Math.max(wait, 1000) * 2, 15000);
    this.commandTimer = setTimeout(function () {
      self.commandTimer = null;
      self.commandHold = false;
      if (self.stopped || state.ended) return;
      self.pumpCommands();
    }, wait);
  };

  ControllerTransport.prototype.clearCommandFailure = function () {
    var text = state.statusText || "";
    if (text === "The studio could not be reached." || text === "This action was refused." ||
        text.indexOf("The studio is busy") === 0) {
      this.status("");
    }
  };

  ControllerTransport.prototype.postCommand = function (command) {
    var self = this;
    if (self.stopped || state.ended || !self.sessionId || !self.token) return;
    var retryAt = self.retryIds.indexOf(command);
    if (retryAt >= 0) {
      command.command_id = "cmd-" + (++commandCount);
      self.retryIds.splice(retryAt, 1);
    }
    /* First send, or the deliberately new id after a stale-version 409: stamp
       the newest version. Same-id retries after an unknown outcome retain the
       original expected_version so the controller sees the identical body. */
    if (command.__studioPayloadId !== command.command_id) {
      command.expected_version = self.newestVersion();
      self.commandMeta(command, "__studioPayloadId", command.command_id);
    }
    self.commandFlight = command;
    self.startWorking(command);
    var gen = self.commandGen;
    var url = self.base + "/v1/session/" + encodeURIComponent(self.sessionId) + "/commands";
    fetch(url, {
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
        if (gen !== self.commandGen) return;
        self.commandFlight = null;
        self.clearWorking();
        if (self.stopped || state.ended) return;
        var body = parseJson(text);
        if (res.status === 409) {
          var failedAt = typeof command.expected_version === "number" ? command.expected_version : 0;
          var named = body && body.current_version;
          if (typeof named === "string" && named !== "") named = Number(named);
          var target = typeof named === "number" && isFinite(named) ? named : null;
          var firstRetry = self.retriedCommands.indexOf(command) < 0;
          self.catchFloor = failedAt;
          self.catchTarget = target;
          if (firstRetry) {
            self.retriedCommands.push(command);
            self.retryIds.push(command);
            self.commandRetry = command;
          } else {
            self.commandRetry = null;
          }
          /* Already past the version this command failed at. A named
             current_version does not keep us waiting, and it does not
             count a version that is not newer than the failure. */
          if (firstRetry && self.hasCaughtUp(self.newestVersion())) {
            self.awaitingCatchUp = false;
            self.clearCatchingUp();
            self.pumpCommands();
            return;
          }
          self.status("Catching up");
          self.awaitingCatchUp = true;
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
        if (res.status === 429) {
          var seconds = self.retrySeconds(body, res);
          self.status(self.busyText(body, res));
          self.failCommand(command, "", seconds == null ? null : seconds * 1000);
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          self.holdCommand(command, "This action was refused.");
          return;
        }
        if (res.status === 200 || res.status === 202) {
          self.noteVersion(body && body.artifact_version);
          self.commandMeta(command, "__studioFailures", 0);
          self.commandDelay = 1000;
          self.clearCommandFailure();
          self.pumpCommands();
          return;
        }
        self.failCommand(command, "The studio could not be reached.");
      });
    }).catch(function () {
      if (gen !== self.commandGen) return;
      self.commandFlight = null;
      self.clearWorking();
      if (self.stopped || state.ended) return;
      self.failCommand(command, "The studio could not be reached.");
    });
  };

  ControllerTransport.prototype.noteApplied = function (event) {
    if (!event) return;
    this.noteVersion(event.artifact_version);
    if (event.type === "session.ended" || state.ended) {
      this.clearCommandTimer();
      this.commandHold = false;
      this.commandQueue = [];
      this.commandRetry = null;
      this.awaitingCatchUp = false;
      this.clearCatchingUp();
      this.stopCommand = null;
      this.stopFlight = null;
      this.stopAwaitingCatchUp = false;
      this.stopRenewOnRetry = false;
      this.stopHeld = false;
      this.stopNotice = "";
      this.clearStopTimer();
      this.status("");
      return;
    }
    var version = typeof event.artifact_version === "number" ? event.artifact_version : 0;
    if (this.stopAwaitingCatchUp && this.stopHasCaughtUp(version)) {
      this.stopAwaitingCatchUp = false;
      if (!this.awaitingCatchUp) this.clearCatchingUp();
      this.postStop();
    }
    if (!this.awaitingCatchUp) return;
    /* A named current_version is a lower bound as well as the strict advance
       fence. A version-2 event does not repair a server that named version 4. */
    if (!this.hasCaughtUp(version)) return;
    this.awaitingCatchUp = false;
    this.clearCatchingUp();
    this.pumpCommands();
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
        self.connect();
        if (self.onLive) self.onLive();
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
      /* A JSON 409 is repair-busy, refused before any bytes. Back off.
         A JSON 404 is the session gone and is handled above. An empty 200
         remains the defence if a refusal still arrives after the headers. */
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

  /* Stop is not a queued command. The visitor pressed it, so it goes now,
     even while another command is in flight. Utterances still waiting are
     dropped. The one already sent may finish. A same-id retry repeats the
     exact JSON: the controller fingerprints the whole body. A received 409
     is a new command after catch-up, or a new command when the controller
     is busy. 429, 5xx, and a lost response keep this id, retry a finite
     number of times, then offer Retry last action. */
  ControllerTransport.prototype.dropQueuedUtterances = function () {
    this.commandQueue = this.commandQueue.filter(function (command) {
      return !command || command.type !== "utterance";
    });
    if (this.commandRetry && this.commandRetry.type === "utterance") {
      this.commandRetry = null;
      this.awaitingCatchUp = false;
      this.commandHold = false;
      this.clearCommandTimer();
    }
  };

  ControllerTransport.prototype.sendStop = function (command) {
    /* Codex review of #178: Stop is the visitor's last word, so "Working on
       it" never outlives it - neither a pause still pending nor one already
       on screen. Only that text is cleared; a retry, refusal or busy message
       stays. */
    this.clearWorking();
    this.dropQueuedUtterances();
    if (this.stopCommand) return;
    this.stopCommand = command;
    this.stopDelay = 1000;
    this.stopRenewOnRetry = false;
    this.postStop();
  };

  ControllerTransport.prototype.renewStopCommand = function () {
    var command = this.stopCommand;
    if (!command) return;
    command.command_id = "cmd-" + (++commandCount);
    this.commandMeta(command, "__studioPayloadId", "");
  };

  ControllerTransport.prototype.stopConflictKind = function (body) {
    var detail = body && typeof body.detail === "string" ? body.detail : "";
    var error = body && typeof body.error === "string" ? body.error : "";
    if (/busy/i.test(detail) || /busy/i.test(error)) return "busy";
    return "cas";
  };

  ControllerTransport.prototype.holdStop = function (notice) {
    var self = this;
    this.clearStopTimer();
    this.stopAwaitingCatchUp = false;
    this.stopHeld = true;
    this.stopNotice = notice || state.statusText || "The studio could not be reached.";
    this.status(this.stopNotice, function () {
      self.retryHeldStop();
    }, "stop");
  };

  ControllerTransport.prototype.retryHeldStop = function () {
    if (this.stopped || state.ended || !this.stopCommand) return;
    this.stopHeld = false;
    this.stopNotice = "";
    if (this.stopRenewOnRetry) {
      this.stopRenewOnRetry = false;
      this.commandMeta(this.stopCommand, "__studioCasUsed", false);
      this.renewStopCommand();
    }
    this.commandMeta(this.stopCommand, "__studioFailures", 0);
    this.stopDelay = 1000;
    this.status("");
    this.postStop();
  };

  ControllerTransport.prototype.failStop = function (command, notice, waitMs) {
    var failures = (Number(command.__studioFailures) || 0) + 1;
    this.commandMeta(command, "__studioFailures", failures);
    this.stopCommand = command;
    if (notice) this.status(notice);
    if (failures >= COMMAND_RETRY_LIMIT) {
      this.holdStop(notice);
      return;
    }
    this.scheduleStopRetry(waitMs);
  };

  ControllerTransport.prototype.scheduleStopRetry = function (waitMs) {
    if (this.stopped || this.stopTimer || !this.stopCommand) return;
    var self = this;
    var wait = typeof waitMs === "number" ? waitMs : (this.stopDelay || 1000);
    if (typeof waitMs !== "number") this.stopDelay = Math.min(Math.max(wait, 1000) * 2, 15000);
    this.stopTimer = setTimeout(function () {
      self.stopTimer = null;
      if (self.stopped || state.ended || !self.stopCommand) return;
      self.postStop();
    }, wait);
  };

  ControllerTransport.prototype.acceptStopConflict = function (command, body, res) {
    if (this.stopConflictKind(body) === "busy") {
      /* The controller cached this refusal under the command_id. A new id
         is a new command, so the old body is not rewritten and the 409 is
         not replayed. */
      this.renewStopCommand();
      this.status(this.busyText(body, res));
      this.failStop(this.stopCommand, "");
      return;
    }
    var failedAt = typeof command.expected_version === "number" ? command.expected_version : 0;
    var named = body && body.current_version;
    if (typeof named === "string" && named !== "") named = Number(named);
    var target = typeof named === "number" && isFinite(named) ? named : null;
    this.stopCatchFloor = failedAt;
    this.stopCatchTarget = target;
    if (command.__studioCasUsed) {
      this.stopRenewOnRetry = true;
      this.holdStop("Catching up");
      return;
    }
    this.commandMeta(command, "__studioCasUsed", true);
    this.renewStopCommand();
    if (this.stopHasCaughtUp(this.newestVersion())) {
      this.stopAwaitingCatchUp = false;
      this.clearCatchingUp();
      this.postStop();
      return;
    }
    this.stopAwaitingCatchUp = true;
    this.status("Catching up");
  };

  ControllerTransport.prototype.postStop = function () {
    var self = this;
    var command = self.stopCommand;
    if (!command || self.stopFlight || self.stopped || state.ended || !self.sessionId || !self.token) return;
    /* First send, or a new id after a received 409: stamp the newest version.
       Same-id retries after an unknown outcome keep every field. */
    if (command.__studioPayloadId !== command.command_id) {
      command.expected_version = self.newestVersion();
      self.commandMeta(command, "__studioPayloadId", command.command_id);
    }
    self.stopFlight = command;
    var gen = self.commandGen;
    var url = self.base + "/v1/session/" + encodeURIComponent(self.sessionId) + "/commands";
    fetch(url, {
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
        if (gen !== self.commandGen || self.stopFlight !== command) return;
        self.stopFlight = null;
        if (self.stopped || state.ended) return;
        var body = parseJson(text);
        if (res.status === 409) {
          self.acceptStopConflict(command, body, res);
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
        if (res.status === 429) {
          var seconds = self.retrySeconds(body, res);
          self.status(self.busyText(body, res));
          self.failStop(command, "", seconds == null ? null : seconds * 1000);
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          self.holdStop("This action was refused.");
          return;
        }
        if (res.status === 200 || res.status === 202) {
          self.stopCommand = null;
          self.stopDelay = 1000;
          self.stopAwaitingCatchUp = false;
          self.stopHeld = false;
          self.stopNotice = "";
          self.clearStopTimer();
          self.commandMeta(command, "__studioFailures", 0);
          self.noteVersion(body && body.artifact_version);
          self.clearCatchingUp();
          self.clearCommandFailure();
          self.pumpCommands();
          return;
        }
        self.failStop(command, "The studio could not be reached.");
      });
    }).catch(function () {
      if (gen !== self.commandGen || self.stopFlight !== command) return;
      self.stopFlight = null;
      if (self.stopped || state.ended) return;
      self.failStop(command, "The studio could not be reached.");
    });
  };

  ControllerTransport.prototype.send = function (command) {
    if (this.stopped || !this.sessionId || !this.token) return Promise.resolve();
    if (command && command.type === "stop") {
      this.sendStop(command);
      return Promise.resolve();
    }
    if (state.ended) return Promise.resolve();
    this.commandQueue.push(command);
    this.pumpCommands();
    return Promise.resolve();
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

  function batchQuestionSig(batch, question) {
    /* Everything that gives the decision its meaning, and nothing that
       changes when the visitor answers it (status) or when an unrelated
       part of the task is revised (task_revision). */
    return JSON.stringify([batch.batch_id, state.generation, batch.title || "", question.question_id,
      question.group || "", question.scope_path || "", question.reason || "", question.prompt || "",
      (question.affected_artifact_ids || []).slice(),
      (question.options || []).map(function (o) {
        return [o.option_id, o.label, o.consequence || "", !!o.recommended, o.recommended_because || ""];
      })]);
  }

  function renderBatch(batch) {
    var form = el("form", {
      "class": "studio-batch",
      "data-studio-batch": batch.batch_id,
      "autocomplete": "off"
    });
    form.appendChild(text("h2", batch.title || "Decisions"));
    (batch.questions || []).forEach(function (question) {
      /* Release 5: a form question answered another way (by voice) leaves
         the form; the submission names only the questions still open, which
         is what the controller accepts. */
      if (question.status && question.status !== "open") return;
      /* A tick is carried across a re-render only into the SAME decision:
         same batch, same generation, same prompt and options (Codex review
         of #149 - a replacement form reusing ids must start unticked). */
      var group = el("fieldset", { "data-studio-sig": batchQuestionSig(batch, question) });
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
      /* Voice is not on for public sessions yet (the public controller reports
         voice false), so the walkthrough does not promise it. Add it back when
         voice is live for everyone. */
      " In a live session you can change any decision and keep going by typing.";
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
    /* Release 5: every event re-renders, and a rebuilt form used to drop
       the choices the visitor had already ticked. Carry them across. */
    var ticked = {};
    var oldChecked = batchHost.querySelectorAll('input[type="radio"]:checked');
    for (var t = 0; t < oldChecked.length; t++) {
      var oldGroup = oldChecked[t].closest("fieldset");
      if (oldGroup) ticked[oldGroup.getAttribute("data-studio-sig")] = oldChecked[t].value;
    }
    clear(batchHost);
    if (state.batch) {
      var form = renderBatch(state.batch);
      var radios = form.querySelectorAll('input[type="radio"]');
      for (var r = 0; r < radios.length; r++) {
        var group = radios[r].closest("fieldset");
        if (group && ticked[group.getAttribute("data-studio-sig")] === radios[r].value) radios[r].checked = true;
      }
      /* Release 10: on a phone the form in front is the bottom sheet, as a
         single question is. A question open at the same time keeps it. */
      form.setAttribute("data-active", activeHost.firstChild ? "false" : "true");
      batchHost.appendChild(form);
      refreshBatchSubmit(form);
    }

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
    if (signingOut) disableForSignOut();

    var live = document.getElementById("studio-live");
    if (live) live.textContent = liveText(state);
    syncVoiceChrome();
    revealChange(state);
  }

  /* Release 9: on a phone the question card is a bottom sheet (rule 8), so a
     change can land behind it. Once per change, bring the first changed node
     into the top half of the screen. It scrolls the page only - keyboard
     focus never moves (rule 7) - and honours reduced motion (rule 10). */
  /* The counter belongs to one renderer state: a reset (same-page sign-in,
     new session) starts a new state whose first change must be revealed even
     though its count starts at 1 again (Codex review of #164). */
  var revealedSeq = 0;
  var revealedState = null;
  function revealChange(state) {
    if (!state.revealSeq) return;
    if (state === revealedState && state.revealSeq === revealedSeq) return;
    revealedState = state;
    revealedSeq = state.revealSeq;
    if (!window.matchMedia || !window.matchMedia("(max-width: 800px)").matches) return;
    var id = (state.revealIds || [])[0];
    if (!id) return;
    var node = document.querySelector('#studio-artifact [data-node-id="' + id + '"]');
    if (!node) return;
    var sheet = document.querySelector('[data-studio-card][data-active="true"], .studio-batch[data-active="true"]');
    var limit = window.innerHeight * 0.5;
    if (sheet) limit = Math.min(limit, sheet.getBoundingClientRect().top);
    var box = node.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= limit) return;
    var target = window.scrollY + box.top - Math.max(16, (limit - box.height) / 2);
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, target), behavior: reduce ? "auto" : "smooth" });
  }

  function liveText(state) {
    var lines = state.announcements.join(" ");
    if (!state.statusText) return lines;
    return lines ? lines + " " + state.statusText : state.statusText;
  }

  /* A new sign-in must not keep the previous session's fence, queue, or
     timers. Commands read session_id from this state; the URL reads it from
     the transport. They have to be the same session. */
  function resetRenderer() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    settleUntil = 0;
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = null;
    state = createState();
    render(state);
    if (transport && transport.resetCommands) transport.resetCommands();
  }

  function showStatus(message, retryAction) {
    state.statusText = message || "";
    var node = document.getElementById("studio-status");
    if (node) {
      node.textContent = state.statusText;
      node.hidden = !state.statusText;
    }
    var retry = document.querySelector("[data-studio-command-retry]");
    if (retry) {
      retry.onclick = typeof retryAction === "function" ? retryAction : null;
      retry.hidden = typeof retryAction !== "function";
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

  /* --- voice (stage B) -------------------------------------------------- */

  /* One call per session. The controller relays the SDP; audio goes straight
     to the provider and is never recorded here. Speech is text the controller
     already committed, or a /talk reply. The microphone stays up across turns. */
  var voice = {
    allowed: false,
    agents: [],
    agent: "claude",
    agentLocked: false,
    phase: "idle",
    gen: 0,
    sessionId: "",
    pc: null,
    channel: null,
    stream: null,
    endTimer: null,
    offerWait: null,
    reconnectTimer: null,
    reconnects: 0,
    speech: [],
    speaking: null,
    spoken: {},
    uttered: {},
    partials: {},
    history: [],
    turn: 0,
    hearing: false,
    stopSent: false
  };

  function voiceAudio() {
    return document.querySelector("[data-studio-voice-audio]");
  }

  function setVoiceMessage(message) {
    var node = document.querySelector("[data-studio-voice-status]");
    if (node) {
      node.textContent = message || "";
      node.hidden = !message;
    }
    syncVoiceChrome();
  }

  function showCaption(text) {
    var node = document.querySelector("[data-studio-caption]");
    if (node) {
      node.textContent = text || "";
      node.hidden = !text;
    }
    syncVoiceChrome();
  }

  function clearCaption() {
    voice.partials = {};
    var node = document.querySelector("[data-studio-caption]");
    if (node) {
      node.textContent = "";
      node.hidden = true;
    }
  }

  function chosenAgent() {
    if (voice.agentLocked && (voice.agent === "claude" || voice.agent === "openai")) return voice.agent;
    var picker = document.querySelector("[data-studio-agent]");
    var selected = picker && picker.querySelector("[data-studio-agent-choice]:checked");
    var value = selected ? String(selected.value) : "";
    if ((value === "claude" || value === "openai") &&
        (!voice.agents.length || voice.agents.indexOf(value) >= 0)) return value;
    if (voice.agents.indexOf("claude") >= 0) return "claude";
    if (voice.agents.indexOf("openai") >= 0) return "openai";
    return "claude";
  }

  function syncVoiceChrome() {
    var root = document.querySelector("[data-studio-voice]");
    if (!root) return;
    var talk = root.querySelector("[data-studio-talk]");
    var stop = root.querySelector("[data-studio-stop]");
    var live = transport instanceof ControllerTransport &&
      !!(transport.sessionId && transport.token && !transport.stopped) && !state.ended;
    var calling = voice.phase === "connecting" || voice.phase === "open";
    var showTalk = !!(voice.allowed && live && voice.phase === "idle");
    if (talk) talk.hidden = !showTalk;
    if (stop) stop.hidden = !calling;
    var picker = root.querySelector("[data-studio-agent]");
    if (picker) {
      var showAgents = voice.agents.length > 1 && (showTalk || calling || voice.phase === "done");
      picker.hidden = !showAgents;
      var choices = picker.querySelectorAll("[data-studio-agent-choice]");
      for (var i = 0; i < choices.length; i++) {
        choices[i].disabled = !!(voice.agentLocked || calling || voice.phase === "done");
      }
    }
    var status = root.querySelector("[data-studio-voice-status]");
    var caption = root.querySelector("[data-studio-caption]");
    var visible = showTalk || calling ||
      (status && !status.hidden) || (caption && !caption.hidden) ||
      (picker && !picker.hidden);
    root.hidden = !visible;
  }

  function stopStream(stream) {
    if (!stream || !stream.getTracks) return;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      try { tracks[i].stop(); } catch (err) { /* already stopped */ }
    }
  }

  function teardownMedia() {
    if (voice.endTimer) {
      clearTimeout(voice.endTimer);
      voice.endTimer = null;
    }
    if (voice.reconnectTimer) {
      clearTimeout(voice.reconnectTimer);
      voice.reconnectTimer = null;
    }
    voice.speech = [];
    voice.speaking = null;
    voice.hearing = false;
    var finishOffer = voice.offerWait;
    voice.offerWait = null;
    var pc = voice.pc;
    var channel = voice.channel;
    voice.pc = null;
    voice.channel = null;
    if (channel) {
      try { channel.onmessage = null; } catch (err) { /* already dropped */ }
      try { channel.onopen = null; } catch (err) { /* already dropped */ }
      try { channel.onclose = null; } catch (err) { /* already dropped */ }
      try {
        if (typeof channel.close === "function") channel.close();
      } catch (err) { /* already closed */ }
    }
    if (pc) {
      try { pc.ontrack = null; } catch (err) { /* already dropped */ }
      try { pc.onconnectionstatechange = null; } catch (err) { /* already dropped */ }
      try { pc.close(); } catch (err) { /* already closed */ }
    }
    var stream = voice.stream;
    voice.stream = null;
    stopStream(stream);
    var audio = voiceAudio();
    var remote = audio && audio.srcObject;
    if (audio) {
      try { audio.srcObject = null; } catch (err) { /* unsupported */ }
    }
    stopStream(remote);
    clearCaption();
    if (finishOffer) finishOffer();
  }

  function failVoice(message, phase) {
    voice.gen += 1;
    teardownMedia();
    voice.phase = phase || "idle";
    setVoiceMessage(message);
  }

  function closeVoiceBecauseSessionEnded() {
    if (voice.phase !== "connecting" && voice.phase !== "open") {
      syncVoiceChrome();
      return;
    }
    voice.gen += 1;
    teardownMedia();
    voice.phase = "done";
    setVoiceMessage("Voice ended.");
  }

  function syncVoiceSession() {
    var sessionId = transport instanceof ControllerTransport &&
      transport.sessionId && transport.token && !transport.stopped
      ? String(transport.sessionId) : "";
    if (sessionId && sessionId !== voice.sessionId) {
      voice.gen += 1;
      teardownMedia();
      voice.sessionId = sessionId;
      voice.phase = "idle";
      voice.stopSent = false;
      voice.spoken = {};
      voice.uttered = {};
      voice.partials = {};
      voice.history = [];
      voice.turn = 0;
      voice.hearing = false;
      voice.agentLocked = false;
      voice.reconnects = 0;
      voice.agent = chosenAgent();
      setVoiceMessage("");
    }
    syncVoiceChrome();
  }

  function speechFor(event) {
    var payload = event.payload || {};
    if (event.type === "question.asked") {
      return payload.question && payload.question.prompt ? String(payload.question.prompt) : "";
    }
    if (event.type === "progress") return payload.text ? String(payload.text) : "";
    if (event.type === "confirm") return payload.text ? String(payload.text) : "";
    if (event.type === "decision.batch") {
      var title = payload.title ? String(payload.title) : "";
      if (!title) return "";
      return title.replace(/[.?!]\s*$/, "") + ". The options are on screen.";
    }
    return "";
  }

  /* The realtime server cancels a spoken response when the visitor starts
     talking. Both shapes are barge-in, not a failure. */
  function isBargeIn(msg) {
    if (!msg || msg.type !== "response.done") return false;
    var response = msg.response && typeof msg.response === "object" ? msg.response : {};
    var status = msg.status || response.status;
    var details = msg.status_details || response.status_details || {};
    if (!details || typeof details !== "object") details = {};
    var reason = details.reason || msg.reason;
    return status === "cancelled" && reason === "turn_detected";
  }

  /* A line stamped before the visitor's latest turn is stale. Newer lines,
     including the reply to what they just said, stay. */
  function enqueueSpeech(text, turn) {
    var words = String(text || "").trim();
    if (!words) return;
    var stamped = typeof turn === "number" ? turn : voice.turn;
    if (stamped < voice.turn) return;
    voice.speech.push({ text: words, turn: stamped });
    flushSpeech();
  }

  function dropStaleSpeech() {
    voice.speech = voice.speech.filter(function (item) {
      return item && item.turn >= voice.turn;
    });
  }

  function cancelActiveLine() {
    var active = voice.speaking;
    if (!active || active.cancelSent) return;
    active.cancelSent = true;
    var channel = voice.channel;
    if (!channel || channel.readyState !== "open") return;
    var cancel = { type: "response.cancel", event_id: "studio-speech-cancel-" + randomId() };
    if (active.responseId) cancel.response_id = active.responseId;
    try { channel.send(JSON.stringify(cancel)); } catch (err) { /* channel already gone */ }
  }

  /* The visitor started a new turn. Drop anything queued before it and cancel
     the line being spoken. The call itself stays up. */
  function beginVisitorTurn() {
    if (voice.hearing) return;
    voice.hearing = true;
    voice.turn += 1;
    dropStaleSpeech();
    cancelActiveLine();
  }

  function rememberTurn(who, text) {
    var words = String(text || "").trim();
    if (!words || (who !== "you" && who !== "claude")) return;
    voice.history.push({ who: who, text: words });
    if (voice.history.length > 8) voice.history = voice.history.slice(voice.history.length - 8);
  }

  function talkNotice(status) {
    if (status === 400) return "That could not be said.";
    if (status === 403) return "That agent is not available.";
    if (status === 429) return "This conversation is at its limit.";
    return "The agent is unavailable.";
  }

  /* 503 (and the other talk refusals except a dead session) are a notice.
     They must not hang up. 401 signs in again. 404 and 410 mean the session
     is already gone. */
  function noteTalkFailure(status) {
    if (voice.phase !== "open" && voice.phase !== "connecting") return;
    if (status === 401) {
      if (transport && typeof transport.needsSignIn === "function") transport.needsSignIn();
      return;
    }
    if (status === 404 || status === 410) {
      closeVoiceBecauseSessionEnded();
      if (transport && !transport.stopped) transport.stop("This session has ended.");
      return;
    }
    setVoiceMessage(talkNotice(status));
  }

  function postTalk(text) {
    if (!(transport instanceof ControllerTransport)) return;
    if (!transport.sessionId || !transport.token || !transport.base) return;
    var words = String(text || "").trim();
    if (!words) return;
    var gen = voice.gen;
    var turn = voice.turn;
    var sessionId = String(transport.sessionId);
    var history = voice.history.slice(-8).map(function (row) {
      return { who: row.who, text: row.text };
    });
    rememberTurn("you", words);
    var url = transport.base + "/v1/session/" + encodeURIComponent(sessionId) + "/talk";
    fetch(url, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + transport.token,
        "content-type": "application/json",
        "accept": "application/json"
      },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({
        text: words,
        history: history,
        agent: voice.agent === "openai" ? "openai" : "claude"
      })
    }).then(function (res) {
      return res.text().then(function (raw) {
        return { status: res.status, body: parseJson(raw) };
      });
    }).then(function (result) {
      if (!result || gen !== voice.gen) return;
      if (voice.phase !== "open" && voice.phase !== "connecting") return;
      if (!transport || String(transport.sessionId || "") !== sessionId) return;
      if (result.status !== 200) {
        noteTalkFailure(result.status);
        return;
      }
      var reply = result.body && typeof result.body.reply === "string" ? result.body.reply.trim() : "";
      if (!reply || turn < voice.turn) return;
      rememberTurn("claude", reply);
      enqueueSpeech(reply, turn);
    }).catch(function () {
      if (gen !== voice.gen) return;
      noteTalkFailure(503);
    });
  }

  function speakCommitted(event) {
    if (!event) return;
    if (voice.phase !== "connecting" && voice.phase !== "open") return;
    var text = speechFor(event);
    if (!text) return;
    var key = event.op_id || (event.type + ":" + text);
    if (voice.spoken[key]) return;
    voice.spoken[key] = true;
    enqueueSpeech(text, voice.turn);
  }

  function flushSpeech() {
    var channel = voice.channel;
    if (!channel || channel.readyState !== "open") return;
    if (!voice.speaking) {
      var next = null;
      while (voice.speech.length && !next) {
        var item = voice.speech.shift();
        if (item && item.turn >= voice.turn && item.text) next = item;
      }
      if (!next) return;
      voice.speaking = {
        text: next.text,
        turn: next.turn,
        itemSent: false,
        responseSent: false,
        cancelSent: false,
        itemEventId: "studio-speech-item-" + randomId(),
        responseEventId: "studio-speech-response-" + randomId(),
        responseId: ""
      };
    }
    var active = voice.speaking;
    if (active.responseSent) return;
    try {
      if (!active.itemSent) {
        channel.send(JSON.stringify({
          event_id: active.itemEventId,
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Say this to the visitor, naturally: " + active.text }]
          }
        }));
        active.itemSent = true;
      }
      if (!active.responseSent) {
        channel.send(JSON.stringify({
          event_id: active.responseEventId,
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            metadata: { studio_speech_id: active.responseEventId }
          }
        }));
        active.responseSent = true;
      }
    } catch (err) {
      /* Keep the staged line. A later channel-open or committed event can
         resume the unsent stage without creating concurrent responses. */
    }
  }

  function onVoiceChannelMessage(ev) {
    if (voice.phase !== "open" && voice.phase !== "connecting") return;
    var msg = ev && ev.data;
    if (typeof msg === "string") {
      try { msg = JSON.parse(msg); } catch (err) { return; }
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "response.created") {
      if (!voice.speaking || !voice.speaking.responseSent) return;
      var created = msg.response && typeof msg.response === "object" ? msg.response : {};
      var createdMetadata = created.metadata && typeof created.metadata === "object"
        ? created.metadata : {};
      var createdId = typeof created.id === "string" ? created.id : "";
      if (!createdId || createdMetadata.studio_speech_id !== voice.speaking.responseEventId) return;
      if (voice.speaking.responseId && voice.speaking.responseId !== createdId) return;
      voice.speaking.responseId = createdId;
      return;
    }
    /* Exactly one default-conversation response may be active. Completion,
       cancellation, and a provider error retire that line before the next
       committed line is requested. Barge-in never replays the interrupted
       line. */
    if (msg.type === "response.done") {
      if (!voice.speaking) return;
      var response = msg.response && typeof msg.response === "object" ? msg.response : {};
      var responseId = typeof response.id === "string" ? response.id : "";
      var metadata = response.metadata && typeof response.metadata === "object"
        ? response.metadata : {};
      if (!voice.speaking.responseId || responseId !== voice.speaking.responseId) return;
      if (metadata.studio_speech_id &&
          metadata.studio_speech_id !== voice.speaking.responseEventId) return;
      var status = msg.status || response.status || "";
      var barged = isBargeIn(msg);
      if (barged) beginVisitorTurn();
      voice.speaking = null;
      if (barged) voice.hearing = false;
      if (!barged && status && status !== "completed") {
        setVoiceMessage("Voice playback skipped. Still listening.");
      } else {
        setVoiceMessage("Listening");
      }
      flushSpeech();
      return;
    }
    if (msg.type === "error") {
      if (!voice.speaking) return;
      var providerError = msg.error && typeof msg.error === "object" ? msg.error : {};
      var causedBy = typeof providerError.event_id === "string" ? providerError.event_id : "";
      /* Generic errors are recoverable and may concern another client event.
         Only rejection of this line's response.create proves there is no
         active response to wait for. Once response.created has arrived, its
         matching response.done is the sole terminal signal. */
      if (!causedBy || causedBy !== voice.speaking.responseEventId || voice.speaking.responseId) return;
      voice.speaking = null;
      setVoiceMessage("Voice playback skipped. Still listening.");
      flushSpeech();
      return;
    }
    if (msg.type === "input_audio_buffer.speech_started") {
      beginVisitorTurn();
      return;
    }
    if (msg.type === "conversation.item.input_audio_transcription.delta") {
      var partialId = msg.item_id ? String(msg.item_id) : "";
      var delta = typeof msg.delta === "string" ? msg.delta : "";
      voice.partials[partialId] = (voice.partials[partialId] || "") + delta;
      showCaption(voice.partials[partialId]);
      return;
    }
    if (msg.type !== "conversation.item.input_audio_transcription.completed") return;
    var itemId = msg.item_id == null ? "" : String(msg.item_id);
    var transcript = typeof msg.transcript === "string" ? msg.transcript : "";
    if (transcript) showCaption(transcript);
    if (!itemId || voice.uttered[itemId] || !transcript.trim()) return;
    voice.uttered[itemId] = true;
    voice.hearing = false;
    send({ type: "utterance", item_id: itemId, transcript: transcript });
    postTalk(transcript.trim());
  }

  function readyOffer(pc, gen, offer) {
    function sdp() {
      if (gen !== voice.gen) return "";
      if (pc.localDescription && pc.localDescription.sdp) return pc.localDescription.sdp;
      return (offer && offer.sdp) || "";
    }
    if (pc.iceGatheringState !== "gathering") return Promise.resolve(sdp());
    return new Promise(function (resolve) {
      function finish() {
        if (voice.offerWait === finish) voice.offerWait = null;
        pc.removeEventListener("icegatheringstatechange", onState);
        resolve(sdp());
      }
      function onState() {
        if (pc.iceGatheringState === "complete" || gen !== voice.gen) finish();
      }
      voice.offerWait = finish;
      pc.addEventListener("icegatheringstatechange", onState);
    });
  }

  function postVoice(sdp) {
    var url = transport.base + "/v1/session/" + encodeURIComponent(transport.sessionId) + "/voice";
    return fetch(url, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + transport.token,
        "content-type": "application/json",
        "accept": "application/json"
      },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ sdp: sdp })
    }).then(function (res) {
      return res.text().then(function (text) {
        return { status: res.status, body: parseJson(text) };
      });
    });
  }

  function armEnds(endsAt) {
    if (voice.endTimer) clearTimeout(voice.endTimer);
    voice.endTimer = null;
    if (typeof endsAt !== "number" || !isFinite(endsAt)) return;
    var wait = Math.max(0, endsAt * 1000 - Date.now());
    voice.endTimer = setTimeout(function () {
      voice.endTimer = null;
      if (voice.phase !== "open" && voice.phase !== "connecting") return;
      voice.gen += 1;
      teardownMedia();
      voice.phase = "done";
      setVoiceMessage("Voice ended.");
    }, wait);
  }

  function negotiate(stream, gen) {
    voice.stream = stream;
    var pc = new RTCPeerConnection();
    voice.pc = pc;
    var tracks = stream.getTracks ? stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) pc.addTrack(tracks[i], stream);
    var channel = pc.createDataChannel("oai-events");
    voice.channel = channel;
    channel.onmessage = onVoiceChannelMessage;
    channel.onopen = function () { flushSpeech(); };
    channel.onclose = function () {
      if (gen !== voice.gen || voice.phase !== "open") return;
      scheduleReconnect(gen);
    };
    pc.onconnectionstatechange = function () {
      if (gen !== voice.gen || voice.phase !== "open") return;
      if (pc.connectionState === "failed") scheduleReconnect(gen);
    };
    pc.ontrack = function (ev) {
      var audio = voiceAudio();
      var remote = ev.streams && ev.streams[0];
      if (audio && remote) audio.srcObject = remote;
    };
    setVoiceMessage("Listening");
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        return readyOffer(pc, gen, offer);
      });
    }).then(function (sdp) {
      if (gen !== voice.gen || !sdp) return null;
      return postVoice(sdp);
    }).then(function (result) {
      if (!result || gen !== voice.gen) return;
      if (result.status === 200 && result.body && typeof result.body.sdp === "string") {
        return pc.setRemoteDescription({ type: "answer", sdp: result.body.sdp }).then(function () {
          if (gen !== voice.gen) return;
          voice.phase = "open";
          voice.reconnects = 0;
          setVoiceMessage("Listening");
          armEnds(result.body.ends_at);
          flushSpeech();
        });
      }
      if (result.status === 409) {
        failVoice("Voice is busy for this session.", "busy");
        return;
      }
      if (result.status === 410) {
        closeVoiceBecauseSessionEnded();
        if (transport && !transport.stopped) transport.stop("This session has ended.");
        return;
      }
      failVoice("Voice could not start. You can still type.", "idle");
    });
  }

  function startVoice() {
    if (voice.phase !== "idle") return;
    if (!(transport instanceof ControllerTransport)) return;
    if (!voice.allowed || state.ended || transport.stopped) return;
    if (!transport.sessionId || !transport.token) return;
    var media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function" || typeof window.RTCPeerConnection !== "function") {
      setVoiceMessage("Microphone blocked. You can still type.");
      return;
    }
    voice.agent = chosenAgent();
    voice.agentLocked = true;
    voice.reconnects = 0;
    voice.phase = "connecting";
    var gen = ++voice.gen;
    syncVoiceChrome();
    media.getUserMedia({ audio: true }).then(function (stream) {
      if (gen !== voice.gen) {
        stopStream(stream);
        return null;
      }
      return negotiate(stream, gen);
    }, function () {
      if (gen !== voice.gen) return null;
      failVoice("Microphone blocked. You can still type.", "idle");
      return null;
    }).catch(function () {
      if (gen !== voice.gen) return;
      failVoice("Voice could not start. You can still type.", "idle");
    });
  }

  function stopVoice() {
    if (voice.phase !== "connecting" && voice.phase !== "open") return;
    if (!voice.stopSent) {
      voice.stopSent = true;
      send({ type: "stop" });
    }
    voice.gen += 1;
    teardownMedia();
    voice.phase = "done";
    setVoiceMessage("Voice ended.");
  }

  function loadVoiceFlag() {
    if (!(transport instanceof ControllerTransport) || !transport.base) return;
    fetch(transport.base + "/health", {
      method: "GET",
      credentials: "omit",
      cache: "no-store"
    }).then(function (res) {
      if (res.status !== 200) return null;
      return res.json();
    }).then(function (body) {
      voice.allowed = !!(body && body.features && body.features.voice === true);
      var listed = body && body.features && Array.isArray(body.features.agents)
        ? body.features.agents : [];
      var known = [];
      for (var i = 0; i < listed.length; i++) {
        var name = String(listed[i] || "").toLowerCase();
        if ((name === "claude" || name === "openai") && known.indexOf(name) < 0) known.push(name);
      }
      voice.agents = known;
      if (!voice.agentLocked) voice.agent = chosenAgent();
      syncVoiceChrome();
    }).catch(function () {
      voice.allowed = false;
      voice.agents = [];
      syncVoiceChrome();
    });
  }

  /* A call that was up and then failed is offered again on the same
     microphone. End and a dead session do not come back. */
  function detachPeerKeepMic() {
    var finishOffer = voice.offerWait;
    voice.offerWait = null;
    var pc = voice.pc;
    var channel = voice.channel;
    voice.pc = null;
    voice.channel = null;
    if (channel) {
      try { channel.onmessage = null; } catch (err) { /* already dropped */ }
      try { channel.onopen = null; } catch (err) { /* already dropped */ }
      try { channel.onclose = null; } catch (err) { /* already dropped */ }
      try {
        if (typeof channel.close === "function") channel.close();
      } catch (err) { /* already closed */ }
    }
    if (pc) {
      try { pc.ontrack = null; } catch (err) { /* already dropped */ }
      try { pc.onconnectionstatechange = null; } catch (err) { /* already dropped */ }
      try { pc.close(); } catch (err) { /* already closed */ }
    }
    var audio = voiceAudio();
    var remote = audio && audio.srcObject;
    if (audio) {
      try { audio.srcObject = null; } catch (err) { /* unsupported */ }
    }
    stopStream(remote);
    if (finishOffer) finishOffer();
  }

  function scheduleReconnect(gen) {
    if (gen !== voice.gen || voice.phase !== "open" || voice.reconnectTimer) return;
    voice.reconnects += 1;
    if (voice.reconnects > 2) {
      failVoice("Voice could not reconnect. You can still type.", "idle");
      return;
    }
    voice.reconnectTimer = setTimeout(function () {
      voice.reconnectTimer = null;
      if (gen !== voice.gen || voice.phase !== "open") return;
      var stream = voice.stream;
      if (!stream) return;
      detachPeerKeepMic();
      voice.phase = "connecting";
      var next = ++voice.gen;
      setVoiceMessage("Reconnecting");
      negotiate(stream, next).catch(function () {
        if (next !== voice.gen) return;
        failVoice("Voice could not reconnect. You can still type.", "idle");
      });
    }, voice.reconnects === 1 ? 0 : 1000);
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
    if (signingOut && fields.type !== "stop") return;
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
    if (action === "sign-out") {
      signOut();
      return;
    }
    if (action === "sign-out-retry") {
      showStatus("");
      /* Codex re-review of #162: a refused stop is HELD by the transport, and
         a new send() is ignored while it is. Retry that exact stop instead;
         only when no stop exists at all is a fresh one sent. */
      if (transport instanceof ControllerTransport && transport.stopCommand) {
        if (transport.stopHeld) transport.retryHeldStop();
        else if (!transport.stopFlight && !transport.stopTimer) transport.postStop();
      } else {
        send({ type: "stop" });
      }
      awaitSignOutEnd();
      return;
    }
    if (action === "sign-out-leave") {
      leaveSignedOut();
      return;
    }
    if (signingOut) return;
    if (action === "talk") {
      startVoice();
      return;
    }
    if (action === "stop") {
      stopVoice();
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
  var authGen = 0;

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
    var sendCode = text("button", "Send code", { "type": "button", "data-studio-send-code": "" });
    form.appendChild(sendCode);
    var note = text("p", "", { "data-studio-signin-note": "", "class": "studio-signin-note" });
    note.hidden = true;
    form.appendChild(note);
    var codeLabel = el("label", { "class": "studio-signin-label", "data-studio-code-label": "" });
    codeLabel.hidden = true;
    codeLabel.appendChild(document.createTextNode("Code"));
    var codeInput = el("input", {
      "type": "text",
      "inputmode": "numeric",
      "maxlength": "6",
      "data-studio-code": "",
      "autocomplete": "one-time-code"
    });
    codeLabel.appendChild(codeInput);
    form.appendChild(codeLabel);
    var check = text("button", "Check code", { "type": "button", "data-studio-check-code": "" });
    check.hidden = true;
    form.appendChild(check);
    var err = text("p", "", { "data-studio-signin-error": "", "class": "studio-signin-error" });
    err.hidden = true;
    form.appendChild(err);
    /* Release 12: a visitor whose address is not allowed is not stuck here. */
    var back = el("p", { "class": "studio-signin-alt" });
    back.appendChild(text("a", "Back to the walkthrough", { "href": "/studio/", "data-studio-walkthrough": "" }));
    form.appendChild(back);
    var anchor = document.getElementById("studio-status");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(form, anchor);
    else app.appendChild(form);
    sendCode.addEventListener("click", function () { startAuth(); });
    check.addEventListener("click", function () { verifyAuth(); });
    codeInput.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      verifyAuth();
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (document.activeElement === codeInput) verifyAuth();
      else startAuth();
    });
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
    var clientKey = randomId();
    var gen = ++authGen;
    setSignInError("");
    fetch(transport.base + "/v1/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ email: email, client_key: clientKey })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (gen !== authGen) return;
        var body = parseJson(text);
        if (res.status === 200) {
          signIn.email = email;
          signIn.clientKey = clientKey;
          signIn.challengeId = body.challenge_id ? String(body.challenge_id) : "";
          var codeInput = form.querySelector("[data-studio-code]");
          if (codeInput) codeInput.value = "";
          showSignIn("code");
          return;
        }
        setSignInError("The studio could not be reached.");
      });
    }).catch(function () {
      if (gen !== authGen) return;
      setSignInError("The studio could not be reached.");
    });
  }

  function verifyAuth() {
    if (!transport || !signIn.challengeId) return;
    var gen = authGen;
    var challengeId = signIn.challengeId;
    var email = signIn.email;
    var clientKey = signIn.clientKey;
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
        challenge_id: challengeId,
        email: email,
        code: code,
        client_key: clientKey
      })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (gen !== authGen || challengeId !== signIn.challengeId) return;
        var body = parseJson(text);
        if (res.status === 401) {
          clearOperator();
          setSignInError("That code was not accepted.");
          return;
        }
        if (res.status === 200 && body.token) {
          writeOperator(String(body.token), body.expires_at == null ? "" : body.expires_at);
          hideSignIn();
          resetRenderer();
          showStatus("");
          transport.operatorToken = String(body.token);
          transport.token = "";
          transport.sessionId = "";
          transport.lastEventId = "";
          transport.creationId = "";
          transport.sessionRetried = false;
          transport.emptyStreak = 0;
          transport.stopped = false;
          transport.start(controllerDeliver);
          return;
        }
        setSignInError("The studio could not be reached.");
      });
    }).catch(function () {
      if (gen !== authGen || challengeId !== signIn.challengeId) return;
      setSignInError("The studio could not be reached.");
    });
  }

  function controllerDeliver(event) {
    onEvent(event);
  }

  var params = new URLSearchParams(location.search);
  var controllerUrl = (app.getAttribute("data-controller-url") || "").trim();
  var explicitFixture = params.get("script") === "fixture";
  var liveRequested = params.get("live") === "1";
  /* ?script=fixture is the acceptance harness (hooks included).
     ?live=1 with a data-controller-url uses the live transport. The parameter
     only chooses the mode. Anything else plays the labelled walkthrough and
     does not install the hooks. A controller URL on that walkthrough only
     reveals the sign-in link. */
  if (explicitFixture || !controllerUrl || !liveRequested) {
    if (explicitFixture) {
      sentLog = [];
      window.__studio = {
        sent: sentLog,
        inject: function (event) { onEvent(event); }
      };
    }
    var demo = document.querySelector("[data-studio-demo]");
    if (demo) demo.hidden = false;
    var liveLink = document.querySelector("[data-studio-live]");
    if (liveLink) liveLink.hidden = !controllerUrl;
    transport = new FixtureTransport("/studio/contract/fixtures/scripted-session.json");
    transport.start(onEvent);
  } else {
    transport = new ControllerTransport(controllerUrl);
    transport.onStatus = showStatus;
    transport.onLive = syncVoiceSession;
    transport.onSessionEnd = closeVoiceBecauseSessionEnded;
    loadVoiceFlag();
    transport.onSignIn = function () {
      clearOperator();
      resetRenderer();
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
    syncSignOut();
  }
})();
