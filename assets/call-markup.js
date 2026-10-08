/* Call markup. Notes stay in this browser. No server and no Redis write. */
(function () {
  "use strict";

  var STORE = "sfdc24-call-notes-2026-10-07";
  var FILE = "call-notes-2026-10-07";
  var AUTHORS = ["", "Mr. Salam", "Claude", "Codex", "Gemini", "Grok", "Cursor"];
  var REVIEWERS = ["Codex", "Claude"];
  var state = load();
  var originals = {};
  var draftPin = {};
  var renderN = 0;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      var data = raw ? JSON.parse(raw) : {};
      if (!data || typeof data !== "object") data = {};
      if (!data.diagrams || typeof data.diagrams !== "object") data.diagrams = {};
      return data;
    } catch (err) {
      return {diagrams: {}};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
      return true;
    } catch (err) {
      return false;
    }
  }

  function bucket(id) {
    if (!state.diagrams[id]) {
      state.diagrams[id] = {comments: [], spoken: "", edited: null, editedAt: "", history: [], approved: [], draft: null, review: null};
    }
    var item = state.diagrams[id];
    if (!Array.isArray(item.comments)) item.comments = [];
    if (!Array.isArray(item.history)) item.history = [];
    if (!Array.isArray(item.approved)) item.approved = [];
    if (!item.draft || typeof item.draft !== "object") item.draft = null;
    if (!item.review || typeof item.review !== "object" || REVIEWERS.indexOf(item.review.reviewer) < 0) item.review = null;
    return item;
  }

  function phase(item) {
    if (item.review && item.review.reviewer) return "review";
    if (item.draft || !latestApproved(item)) return "working";
    return "approved";
  }

  function isLocked(item) {
    return phase(item) === "approved";
  }

  function latestApproved(item) {
    if (!item.approved || !item.approved.length) return null;
    return item.approved[item.approved.length - 1];
  }

  function hashText(text) {
    var s = String(text || "").replace(/\r\n/g, "\n");
    function fnv(seed) {
      var h = seed >>> 0;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    }
    return fnv(2166136261) + fnv((2166136261 ^ s.length) >>> 0);
  }

  function logChange(item, entry) {
    entry.id = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    entry.at = entry.at || new Date().toISOString();
    entry.author = entry.author || "";
    entry.before = entry.before == null ? "" : String(entry.before);
    entry.after = entry.after == null ? "" : String(entry.after);
    item.history.push(entry);
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function norm(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-call-diagram]"));
  }

  function diagramId(section) {
    return section.getAttribute("data-call-diagram");
  }

  function titleOf(section) {
    var heading = section.querySelector("h2");
    return heading ? norm(heading.textContent) : diagramId(section);
  }

  function sourceBox(section) {
    return section.querySelector("textarea.call-src");
  }

  function ensureSource(section) {
    var box = sourceBox(section);
    if (box) return box;
    var named = section.querySelector("textarea[id$='-src']");
    if (named) {
      named.classList.add("call-src");
      return named;
    }
    box = el("textarea", {class: "call-src", rows: "12", "aria-label": "Diagram text"});
    var pre = section.querySelector(".diagram-src");
    if (pre && pre.textContent) box.value = pre.textContent;
    var wrap = el("div", {class: "call-edit", hidden: "hidden"});
    wrap.appendChild(box);
    wrap.appendChild(el("p", {})).appendChild(redrawButton(section));
    var anchor = section.querySelector(".call-split") || section.querySelector("figure");
    if (anchor && anchor.nextSibling) section.insertBefore(wrap, anchor.nextSibling);
    else section.appendChild(wrap);
    return box;
  }

  function redrawButton(section) {
    var button = el("button", {type: "button", class: "call-btn"}, "Redraw");
    button.addEventListener("click", function () { redraw(section); });
    return button;
  }

  function captureOriginal(section) {
    var id = diagramId(section);
    if (originals[id]) return;
    var box = sourceBox(section);
    var pre = section.querySelector(".diagram-src");
    var text = box && box.value ? box.value : (pre ? pre.textContent : "");
    if (norm(text)) originals[id] = text;
  }

  function applyStoredEdit(section) {
    var id = diagramId(section);
    var item = bucket(id);
    var box = ensureSource(section);
    captureOriginal(section);
    if (phase(item) !== "working" || section.dataset.viewing) {
      box.readOnly = true;
      if (phase(item) === "approved") box.value = latestApproved(item).source;
      else if (item.edited) box.value = item.edited;
      return;
    }
    box.readOnly = false;
    if (item.draft) {
      box.value = item.edited || latestApproved(item).source;
      return;
    }
    if (item.edited && originals[id] && item.edited !== originals[id]) box.value = item.edited;
  }

  function storedSource(section) {
    var id = diagramId(section);
    var item = bucket(id);
    if (item.draft) return item.edited || (latestApproved(item) && latestApproved(item).source) || originals[id] || "";
    if (isLocked(item)) return latestApproved(item).source;
    if (item.edited) return item.edited;
    return originals[id] || "";
  }

  function layout(section) {
    if (section.querySelector(".call-split")) return;
    var figure = section.querySelector("figure");
    if (!figure) return;
    var split = el("div", {class: "call-split"});
    figure.parentNode.insertBefore(split, figure);
    split.appendChild(figure);
    split.appendChild(el("div", {class: "call-panel"}));
    figure.classList.add("call-figure");
  }

  function tools() {
    if (document.getElementById("call-tools")) return;
    var bar = el("div", {id: "call-tools", class: "call-tools"});
    var exp = el("button", {type: "button", class: "call-btn", id: "export-notes"}, "Export notes");
    exp.addEventListener("click", exportNotes);
    var imp = el("button", {type: "button", class: "call-btn"}, "Import");
    var file = el("input", {type: "file", id: "import-notes", accept: "application/json,.json"});
    file.hidden = true;
    file.addEventListener("change", function () {
      var picked = file.files && file.files[0];
      if (picked) importNotes(picked);
      file.value = "";
    });
    imp.addEventListener("click", function () { file.click(); });
    var clear = el("button", {type: "button", class: "call-btn call-btn-quiet", id: "clear-drafts"}, "Clear drafts");
    clear.addEventListener("click", clearDrafts);
    bar.appendChild(exp);
    bar.appendChild(imp);
    bar.appendChild(file);
    bar.appendChild(clear);
    bar.appendChild(el("p", {class: "call-hint"}, "Each diagram is a working copy, then in review, then approved and locked. One working copy at a time. The rule set is docs/documentation-lifecycle.md. Nothing is sent to Redis."));
    var host = document.querySelector("main") || document.body;
    var first = sections()[0];
    if (first) host.insertBefore(bar, first);
    else host.appendChild(bar);
  }

  function editToggle(section) {
    if (section.querySelector("[data-edit-toggle]")) return;
    var box = ensureSource(section);
    var wrap = box.closest(".call-edit");
    if (!wrap) {
      wrap = el("div", {class: "call-edit"});
      box.parentNode.insertBefore(wrap, box);
      wrap.appendChild(box);
    }
    if (!wrap.querySelector("button")) wrap.appendChild(redrawButton(section));
    wrap.hidden = true;
    var button = el("button", {type: "button", class: "call-btn", "data-edit-toggle": diagramId(section)}, "Edit diagram text");
    button.addEventListener("click", function () {
      if (phase(bucket(diagramId(section))) !== "working" || section.dataset.viewing) {
        setLive(section, "This diagram is not a working copy. Start a new working copy to change the text.");
        return;
      }
      wrap.hidden = !wrap.hidden;
      button.setAttribute("aria-pressed", wrap.hidden ? "false" : "true");
      if (!wrap.hidden) box.focus();
    });
    if (wrap.parentNode) wrap.parentNode.insertBefore(button, wrap);
    else section.appendChild(button);
  }

  function panelOf(section) {
    return section.querySelector(".call-panel");
  }

  function paint(section) {
    var panel = panelOf(section);
    if (!panel) return;
    var id = diagramId(section);
    var item = bucket(id);
    var pin = draftPin[id];
    var previousNote = panel.querySelector(".call-note");
    var previousAuthor = panel.querySelector(".call-author");
    var previousReviewer = panel.querySelector(".call-reviewer");
    var historyOpen = !!(panel.querySelector(".call-history") && panel.querySelector(".call-history").open);
    var versionsOpen = !!(panel.querySelector(".call-versions") && panel.querySelector(".call-versions").open);
    var noteDraft = previousNote ? previousNote.value : "";
    var authorDraft = previousAuthor ? previousAuthor.value : "";
    var reviewerDraft = previousReviewer ? previousReviewer.value : "Codex";
    var current = phase(item);
    var approved = latestApproved(item);
    panel.textContent = "";

    panel.appendChild(el("p", {class: "call-badge call-badge-" + current}, phaseLabel(current)));
    if (current === "approved" && approved) {
      panel.appendChild(el("p", {class: "call-stamp"}, stampLine(approved)));
    } else if (current === "review") {
      panel.appendChild(el("p", {class: "call-stamp"}, "Edits are frozen. Reviewer: " + item.review.reviewer + ". Comments stay open."));
    } else if (item.draft) {
      panel.appendChild(el("p", {class: "call-lock"}, "Working copy v" + item.draft.n + " from approved v" + item.draft.from + "."));
    } else {
      panel.appendChild(el("p", {class: "call-lock"}, "Working copy. Editable, with history."));
    }
    if (section.dataset.viewing) {
      panel.appendChild(el("p", {class: "call-lock"}, "Showing approved v" + section.dataset.viewing + "."));
    }

    panel.appendChild(el("h3", {}, "Comments"));

    var note = el("textarea", {class: "call-note", rows: "3", "aria-label": "Comment on " + titleOf(section)});
    note.value = noteDraft;
    panel.appendChild(note);

    var author = el("select", {class: "call-author", "aria-label": "Author"});
    AUTHORS.forEach(function (name) {
      author.appendChild(el("option", {value: name}, name || "Author optional"));
    });
    if (AUTHORS.indexOf(authorDraft) >= 0) author.value = authorDraft;
    panel.appendChild(author);

    var status = el("p", {class: "call-pin-status"});
    status.textContent = pin ? "Pinned to: " + pin.label : "Whole diagram. Click a node to pin this comment.";
    panel.appendChild(status);
    if (pin) {
      var clear = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Clear pin");
      clear.addEventListener("click", function () {
        delete draftPin[id];
        paint(section);
      });
      panel.appendChild(clear);
    }

    var add = el("button", {type: "button", class: "call-btn"}, "Add comment");
    add.addEventListener("click", function () {
      var text = norm(note.value);
      if (!text) {
        note.focus();
        return;
      }
      var comment = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text,
        author: AUTHORS.indexOf(author.value) >= 0 ? author.value : "",
        nodeLabel: pin ? pin.label : "",
        nodeIndex: pin ? pin.index : 0,
        at: new Date().toISOString()
      };
      item.comments.push(comment);
      logChange(item, {
        kind: "comment-add",
        author: comment.author,
        before: "",
        after: comment.text,
        nodeLabel: comment.nodeLabel
      });
      delete draftPin[id];
      if (!save()) setLive(section, "This browser blocked local storage. Export the notes before leaving.");
      paint(section);
      placeMarkers(section);
    });
    panel.appendChild(add);

    var list = el("ol", {class: "call-list"});
    var number = 0;
    item.comments.forEach(function (comment) {
      var pinned = !!comment.nodeLabel;
      if (pinned) number += 1;
      var li = el("li", {});
      var who = comment.author ? comment.author + " · " : "";
      var where = pinned ? ("#" + number + " · " + comment.nodeLabel) : "Whole diagram";
      li.appendChild(el("p", {class: "call-meta"}, where + " · " + who + stamp(comment.at)));
      li.appendChild(el("p", {class: "call-text"}, comment.text));
      var remove = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Remove");
      remove.addEventListener("click", function () {
        logChange(item, {
          kind: "comment-remove",
          author: authorOf(section) || comment.author,
          before: comment.text,
          after: "",
          nodeLabel: comment.nodeLabel
        });
        item.comments = item.comments.filter(function (row) { return row.id !== comment.id; });
        save();
        paint(section);
        placeMarkers(section);
      });
      li.appendChild(remove);
      list.appendChild(li);
    });
    if (item.comments.length) panel.appendChild(list);

    panel.appendChild(el("h3", {}, "Spoken comments"));
    panel.appendChild(el("p", {class: "call-hint"}, "Paste a transcript excerpt. Spoken remarks from the live transcript can be added after the call."));
    var spoken = el("textarea", {class: "call-spoken", rows: "4", "aria-label": "Spoken comments for " + titleOf(section)});
    spoken.value = item.spoken || "";
    spoken.addEventListener("input", function () {
      item.spoken = spoken.value;
      save();
    });
    panel.appendChild(spoken);

    if (current === "working") {
      var reviewer = el("select", {class: "call-reviewer", "aria-label": "Reviewer"});
      REVIEWERS.forEach(function (name) {
        reviewer.appendChild(el("option", {value: name}, name));
      });
      reviewer.value = REVIEWERS.indexOf(reviewerDraft) >= 0 ? reviewerDraft : "Codex";
      panel.appendChild(reviewer);
      var request = el("button", {type: "button", class: "call-btn"}, "Request review");
      request.addEventListener("click", function () { requestReview(section); });
      panel.appendChild(request);
    } else if (current === "review") {
      panel.appendChild(el("p", {class: "call-hint"}, "Approver: Mr. Salam."));
      var approveBtn = el("button", {type: "button", class: "call-btn"}, "Approve and lock");
      approveBtn.addEventListener("click", function () { approveVersion(section); });
      panel.appendChild(approveBtn);
    }
    var copyBtn = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Start new working copy");
    copyBtn.addEventListener("click", function () { startWorkingCopy(section); });
    panel.appendChild(copyBtn);
    if (item.approved.length) panel.appendChild(versionList(section, item, versionsOpen));
    panel.appendChild(historyList(item, historyOpen));

    var live = el("p", {class: "call-live", role: "status"});
    panel.appendChild(live);
    paintBadge(section);
    syncLock(section);
  }

  function phaseLabel(current) {
    if (current === "review") return "In review";
    if (current === "approved") return "Approved and locked";
    return "Working copy";
  }

  function stampLine(version) {
    var reviewer = version.reviewer || "Reviewer not recorded";
    var approver = version.approver || "Mr. Salam";
    return "Reviewed by " + reviewer + ", Approved by " + approver + ", v" + version.n + ", " + stampDate(version.at) + ", " + version.hash;
  }

  function shownVersion(section, item) {
    if (section.dataset.viewing) {
      var n = Number(section.dataset.viewing);
      var found = null;
      item.approved.forEach(function (row) { if (row.n === n) found = row; });
      return found;
    }
    return phase(item) === "approved" ? latestApproved(item) : null;
  }

  function paintBadge(section) {
    var figure = section.querySelector("figure");
    if (!figure) return;
    figure.querySelectorAll(".call-badge, .call-stamp").forEach(function (node) { node.remove(); });
    var item = bucket(diagramId(section));
    var current = section.dataset.viewing ? "approved" : phase(item);
    var badge = el("p", {class: "call-badge call-badge-" + current}, phaseLabel(current));
    var version = shownVersion(section, item);
    if (figure.firstChild) figure.insertBefore(badge, figure.firstChild);
    else figure.appendChild(badge);
    var lineText = version ? stampLine(version) : (phase(item) === "review" && item.review ? "Reviewer: " + item.review.reviewer + "." : "");
    if (lineText) {
      var line = el("p", {class: "call-stamp"}, lineText);
      if (badge.nextSibling) figure.insertBefore(line, badge.nextSibling);
      else figure.appendChild(line);
    }
  }

  function authorOf(section) {
    var sel = section.querySelector(".call-author");
    var value = sel ? sel.value : "";
    return AUTHORS.indexOf(value) >= 0 ? value : "";
  }

  function approverOf(section) {
    return "Mr. Salam";
  }

  function reviewerOf(section) {
    var sel = section.querySelector(".call-reviewer");
    var value = sel ? sel.value : "Codex";
    return REVIEWERS.indexOf(value) >= 0 ? value : "Codex";
  }

  function currentSource(section) {
    var id = diagramId(section);
    var item = bucket(id);
    var box = sourceBox(section);
    if (item.draft) return (box && box.value) || item.edited || (latestApproved(item) && latestApproved(item).source) || originals[id] || "";
    if (isLocked(item)) return latestApproved(item).source;
    if (box && document.activeElement === box) return box.value;
    if (item.edited) return item.edited;
    if (box && box.value) return box.value;
    return originals[id] || "";
  }

  function entryDiff(entry) {
    if (entry.kind === "edit") return diffLines(entry.before, entry.after);
    if (entry.kind === "comment-add") return "+" + entry.after;
    if (entry.kind === "comment-remove") return "-" + entry.before;
    return diffLines(entry.before, entry.after);
  }

  function historyList(item, open) {
    var details = el("details", {class: "call-history"});
    if (open) details.open = true;
    details.appendChild(el("summary", {}, "History"));
    if (!item.history.length) {
      details.appendChild(el("p", {class: "call-hint"}, "No changes yet."));
      return details;
    }
    var list = el("ol", {class: "call-list"});
    item.history.slice().reverse().forEach(function (entry) {
      var li = el("li", {});
      var kind = {
        edit: "Diagram text",
        "comment-add": "Comment added",
        "comment-remove": "Comment removed",
        approve: "Approved and locked",
        draft: "New working copy",
        review: "Sent for review"
      }[entry.kind] || entry.kind;
      var who = entry.author || "Author not set";
      var where = entry.nodeLabel ? " · " + entry.nodeLabel : "";
      li.appendChild(el("p", {class: "call-meta"}, stamp(entry.at) + " · " + who + " · " + kind + where));
      li.appendChild(el("pre", {class: "call-diff"}, entryDiff(entry)));
      list.appendChild(li);
    });
    details.appendChild(list);
    return details;
  }

  function versionList(section, item, open) {
    var details = el("details", {class: "call-versions"});
    if (open) details.open = true;
    details.appendChild(el("summary", {}, "Approved versions"));
    var list = el("ul", {class: "call-list"});
    item.approved.forEach(function (version) {
      var li = el("li", {});
      li.appendChild(el("p", {class: "call-meta"}, stampLine(version)));
      var view = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "View v" + version.n);
      view.addEventListener("click", function () { showVersion(section, version.n); });
      li.appendChild(view);
      list.appendChild(li);
    });
    details.appendChild(list);
    if (section.dataset.viewing) {
      var back = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Show current");
      back.addEventListener("click", function () { showCurrent(section); });
      details.appendChild(back);
    }
    return details;
  }

  function syncLock(section) {
    var item = bucket(diagramId(section));
    var locked = phase(item) !== "working" || !!section.dataset.viewing;
    var button = section.querySelector("[data-edit-toggle]");
    if (button) button.disabled = locked;
    var box = sourceBox(section);
    if (box) box.readOnly = locked;
    var redrawBtn = section.querySelector(".call-edit button");
    if (redrawBtn) redrawBtn.disabled = locked;
    if (locked) {
      var wrap = section.querySelector(".call-edit");
      if (wrap) wrap.hidden = true;
    }
  }

  function requestReview(section) {
    var id = diagramId(section);
    var item = bucket(id);
    if (phase(item) !== "working" || section.dataset.viewing) {
      setLive(section, "Request review from the working copy.");
      return;
    }
    var box = sourceBox(section);
    var text = String(box ? box.value : currentSource(section)).replace(/\r\n/g, "\n");
    var before = storedSource(section);
    if (before !== text) {
      logChange(item, {kind: "edit", author: authorOf(section) || reviewerOf(section), before: before, after: text});
      if (item.draft) item.edited = text;
      else item.edited = originals[id] && text !== originals[id] ? text : null;
      item.editedAt = item.edited ? new Date().toISOString() : "";
    }
    item.review = {reviewer: reviewerOf(section), at: new Date().toISOString(), by: authorOf(section)};
    logChange(item, {kind: "review", author: item.review.by || item.review.reviewer, before: "", after: item.review.reviewer});
    save();
    paint(section);
    setLive(section, "In review. Edits are frozen. Comments stay open.");
  }

  function approveVersion(section) {
    var id = diagramId(section);
    var item = bucket(id);
    if (phase(item) !== "review" || section.dataset.viewing) {
      setLive(section, "Request review before approval.");
      return;
    }
    var box = sourceBox(section);
    var text = String(box ? box.value : currentSource(section)).replace(/\r\n/g, "\n");
    if (!norm(text)) {
      setLive(section, "There is no diagram text to approve.");
      return;
    }
    var before = storedSource(section);
    if (before !== text) {
      logChange(item, {kind: "edit", author: authorOf(section) || approverOf(section), before: before, after: text});
    }
    var n = item.draft ? item.draft.n : ((latestApproved(item) && latestApproved(item).n) || 0) + 1;
    if (item.approved.some(function (row) { return row.n === n; })) n = latestApproved(item).n + 1;
    var record = {
      n: n,
      at: new Date().toISOString(),
      approver: "Mr. Salam",
      reviewer: item.review.reviewer,
      hash: hashText(text),
      source: text
    };
    item.approved.push(record);
    item.draft = null;
    item.review = null;
    item.edited = text !== originals[id] ? text : null;
    item.editedAt = item.edited ? record.at : "";
    logChange(item, {kind: "approve", author: record.approver, before: "v" + (n - 1), after: stampLine(record)});
    delete section.dataset.viewing;
    if (box) box.value = text;
    save();
    paint(section);
    redraw(section, true);
  }

  function startWorkingCopy(section) {
    var id = diagramId(section);
    var item = bucket(id);
    var current = phase(item);
    if (current === "working" || current === "review") {
      window.alert(current === "review"
        ? "This diagram is in review. Only one open copy is allowed. Clear drafts before starting another working copy."
        : "This diagram already has a working copy. Only one working copy is allowed. Clear drafts to remove it.");
      setLive(section, "Only one working copy is allowed.");
      return;
    }
    var last = latestApproved(item);
    if (!last) return;
    item.draft = {n: last.n + 1, from: last.n, at: new Date().toISOString()};
    item.review = null;
    item.edited = last.source;
    logChange(item, {kind: "draft", author: authorOf(section) || "Mr. Salam", before: "v" + last.n, after: "v" + item.draft.n});
    delete section.dataset.viewing;
    var box = sourceBox(section);
    if (box) {
      box.readOnly = false;
      box.value = last.source;
    }
    save();
    paint(section);
  }

  function showVersion(section, n) {
    var item = bucket(diagramId(section));
    var version = null;
    item.approved.forEach(function (row) { if (row.n === n) version = row; });
    if (!version) return;
    section.dataset.viewing = String(n);
    paint(section);
    renderSource(section, version.source, "Showing approved v" + n + ".");
  }

  function showCurrent(section) {
    delete section.dataset.viewing;
    var item = bucket(diagramId(section));
    var box = sourceBox(section);
    var text = isLocked(item) ? latestApproved(item).source : (box ? box.value : currentSource(section));
    paint(section);
    renderSource(section, text, "Showing the current text.");
  }

  function setLive(section, text) {
    var live = section.querySelector(".call-live");
    if (live) live.textContent = text;
  }

  function stamp(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      });
    } catch (err) {
      return iso;
    }
  }

  function stampDate(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      });
    } catch (err) {
      return iso;
    }
  }

  function nodeLabel(node) {
    var copy = node.cloneNode(true);
    copy.querySelectorAll(".call-pin").forEach(function (pin) { pin.remove(); });
    return norm(copy.textContent);
  }

  function findNode(svg, label, index) {
    var want = norm(label);
    var nodes = svg.querySelectorAll(".node");
    var seen = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodeLabel(nodes[i]) !== want) continue;
      if (seen === (index || 0)) return nodes[i];
      seen += 1;
    }
    return null;
  }

  function markerHost(section) {
    var svg = section.querySelector("svg");
    if (!svg) return null;
    var host = svg.parentElement;
    if (!host) return null;
    host.style.position = "relative";
    var layer = host.querySelector(":scope > .call-marks");
    if (!layer) {
      layer = el("div", {class: "call-marks"});
      layer.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;";
      host.appendChild(layer);
    }
    return {svg: svg, host: host, layer: layer};
  }

  function placeMarkers(section) {
    var found = markerHost(section);
    if (!found) return;
    found.layer.textContent = "";
    section.querySelectorAll("svg .call-pin").forEach(function (node) { node.remove(); });
    var comments = bucket(diagramId(section)).comments;
    var number = 0;
    var offset = {};
    var hostRect = found.host.getBoundingClientRect();
    comments.forEach(function (comment) {
      if (!comment.nodeLabel) return;
      number += 1;
      var node = findNode(found.svg, comment.nodeLabel, comment.nodeIndex || 0);
      if (!node) return;
      var key = comment.nodeLabel + "#" + (comment.nodeIndex || 0);
      var slot = offset[key] || 0;
      offset[key] = slot + 1;
      var rect = node.getBoundingClientRect();
      var mark = el("span", {class: "call-pin"}, String(number));
      mark.style.cssText = "position:absolute;width:22px;height:22px;border-radius:50%;background:#0A66C2;color:#FFFFFF;font:700 12px/22px Segoe UI,sans-serif;text-align:center;pointer-events:auto;";
      mark.style.left = (rect.right - hostRect.left + found.host.scrollLeft - 11 - slot * 18) + "px";
      mark.style.top = (rect.top - hostRect.top + found.host.scrollTop - 11) + "px";
      found.layer.appendChild(mark);
    });
  }

  function onDiagramClick(section, event) {
    if (event.target.closest(".call-pin")) return;
    var node = event.target.closest(".node");
    if (!node || !section.contains(node)) return;
    var svg = section.querySelector("svg");
    var label = nodeLabel(node);
    var matches = Array.prototype.filter.call(svg.querySelectorAll(".node"), function (item) {
      return nodeLabel(item) === label;
    });
    var index = matches.indexOf(node);
    var id = diagramId(section);
    var current = draftPin[id];
    if (current && current.label === label && current.index === index) delete draftPin[id];
    else draftPin[id] = {label: label, index: index < 0 ? 0 : index};
    paint(section);
  }

  function watch(section) {
    var figure = section.querySelector("figure");
    if (figure && !figure.__callWatch) {
      figure.__callWatch = true;
      figure.addEventListener("click", function (event) { onDiagramClick(section, event); });
      new MutationObserver(function (records) {
        var structural = records.some(function (record) {
          var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
          return nodes.some(function (node) {
            return !(node.nodeType === 1 && node.classList && node.classList.contains("call-marks"));
          });
        });
        if (structural) placeMarkers(section);
      }).observe(figure, {childList: true});
    }
    var slot = section.querySelector(".diagram-svg");
    if (slot && !slot.__callWatch) {
      slot.__callWatch = true;
      new MutationObserver(function (records) {
        var structural = records.some(function (record) {
          var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
          return nodes.some(function (node) {
            return !(node.nodeType === 1 && node.classList && node.classList.contains("call-marks"));
          });
        });
        if (structural) placeMarkers(section);
      }).observe(slot, {childList: true});
    }
  }

  function diagramSlot(section) {
    var figure = section.querySelector("figure");
    if (!figure) return null;
    var slot = figure.querySelector(".diagram-svg") || figure.querySelector(".call-svg");
    if (slot) return slot;
    slot = el("div", {class: "call-svg"});
    var svg = figure.querySelector("svg");
    if (svg) slot.appendChild(svg);
    figure.appendChild(slot);
    return slot;
  }

  function renderSource(section, text, message) {
    var figure = section.querySelector("figure");
    var slot = diagramSlot(section);
    if (!window.mermaid || !slot) {
      setLive(section, "Diagram text is stored. Redraw needs the diagram library.");
      return;
    }
    if (!window.mermaid.__callMarkup) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        flowchart: {htmlLabels: true, wrappingWidth: 220, padding: 16}
      });
      window.mermaid.__callMarkup = true;
    }
    renderN += 1;
    var renderId = "calllive" + renderN;
    window.mermaid.render(renderId, text).then(function (out) {
      slot.innerHTML = out.svg;
      var fallback = section.querySelector(".diagram-fallback");
      if (fallback) fallback.hidden = true;
      placeMarkers(section);
      paintBadge(section);
      setLive(section, message || "Diagram redrawn on this screen.");
    }).catch(function () {
      setLive(section, "That diagram text did not render. The previous picture is unchanged.");
    });
  }

  function redraw(section, internal) {
    var box = sourceBox(section);
    var text = box ? box.value : "";
    var id = diagramId(section);
    var item = bucket(id);
    if (!internal && (phase(item) !== "working" || section.dataset.viewing)) {
      setLive(section, "This diagram is not a working copy. Start a new working copy to change the text.");
      return;
    }
    if (!internal) {
      var before = storedSource(section);
      if (before !== text) {
        logChange(item, {kind: "edit", author: authorOf(section) || approverOf(section), before: before, after: text});
      }
      if (item.draft) item.edited = text;
      else item.edited = originals[id] && text !== originals[id] ? text : null;
      item.editedAt = item.edited ? new Date().toISOString() : "";
      save();
      if (before !== text) paint(section);
    }
    renderSource(section, text, "Diagram redrawn on this screen.");
  }

  function diffLines(before, after) {
    var a = String(before || "").replace(/\r\n/g, "\n").split("\n");
    var b = String(after || "").replace(/\r\n/g, "\n").split("\n");
    var n = a.length;
    var m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push(" " + a[i]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push("-" + a[i]);
        i += 1;
      } else {
        out.push("+" + b[j]);
        j += 1;
      }
    }
    while (i < n) { out.push("-" + a[i]); i += 1; }
    while (j < m) { out.push("+" + b[j]); j += 1; }
    return out.join("\n");
  }

  function payload() {
    var diagrams = {};
    sections().forEach(function (section) {
      var id = diagramId(section);
      var item = bucket(id);
      var box = sourceBox(section);
      var original = originals[id] || (box ? box.value : "");
      var current = isLocked(item) ? latestApproved(item).source : (item.draft ? (item.edited || original) : (item.edited || original));
      var changed = !!(current && original && current !== original);
      diagrams[id] = {
        title: titleOf(section),
        comments: item.comments,
        spoken: item.spoken || "",
        original: original,
        edited: changed ? current : null,
        editedAt: changed ? (item.editedAt || "") : "",
        diff: changed ? diffLines(original, current) : null,
        history: item.history,
        approved: item.approved,
        draft: item.draft,
        review: item.review,
        status: phase(item)
      };
    });
    return {
      call: "2026-10-07",
      exported_at: new Date().toISOString(),
      diagrams: diagrams
    };
  }

  function markdown(data) {
    var lines = [
      "# Call notes 2026-10-07",
      "",
      "Taken in the browser while discussing the diagrams. Not a Redis write.",
      ""
    ];
    Object.keys(data.diagrams).forEach(function (id) {
      var diagram = data.diagrams[id];
      lines.push("## " + (diagram.title || id));
      lines.push("");
      lines.push("Status: " + (diagram.status === "review" ? "In review" : diagram.status === "approved" ? "Approved and locked" : "Working copy"));
      lines.push("");
      var groups = {};
      var order = [];
      (diagram.comments || []).forEach(function (comment) {
        var key = comment.nodeLabel ? comment.nodeLabel : "Whole diagram";
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(comment);
      });
      if (!order.length) {
        lines.push("No written comments.");
        lines.push("");
      }
      order.forEach(function (key) {
        lines.push("### " + key);
        lines.push("");
        groups[key].forEach(function (comment) {
          var who = comment.author ? comment.author : "Author not set";
          lines.push("- " + (comment.at || "") + " — " + who + " — " + comment.text);
        });
        lines.push("");
      });
      lines.push("### Spoken comments");
      lines.push("");
      lines.push(diagram.spoken && diagram.spoken.trim() ? diagram.spoken.trim() : "None.");
      lines.push("");
      lines.push("### Diagram text");
      lines.push("");
      if (diagram.diff) {
        lines.push("Edit made during the discussion:");
        lines.push("");
        lines.push("```diff");
        lines.push(diagram.diff);
        lines.push("```");
      } else {
        lines.push("Unchanged from the committed diagram text.");
      }
      lines.push("");
      lines.push("### History");
      lines.push("");
      if (!diagram.history || !diagram.history.length) {
        lines.push("No changes yet.");
        lines.push("");
      } else {
        diagram.history.forEach(function (entry) {
          var who = entry.author || "Author not set";
          lines.push("- " + (entry.at || "") + " — " + who + " — " + (entry.kind || ""));
          lines.push("");
          lines.push("```diff");
          lines.push(entryDiff(entry));
          lines.push("```");
          lines.push("");
        });
      }
      lines.push("### Approved versions");
      lines.push("");
      if (!diagram.approved || !diagram.approved.length) {
        lines.push("None.");
        lines.push("");
      } else {
        diagram.approved.forEach(function (version) {
          lines.push("- " + stampLine(version));
        });
        lines.push("");
      }
      if (diagram.draft) {
        lines.push("Draft v" + diagram.draft.n + " from approved v" + diagram.draft.from + ".");
        lines.push("");
      }
    });
    return lines.join("\n");
  }

  function download(name, text, type) {
    var blob = new Blob([text], {type: type});
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  function dropDraftData(item, id) {
    var lastApproved = -1;
    item.history.forEach(function (entry, index) {
      if (entry.kind === "approve") lastApproved = index;
    });
    item.history = item.history.filter(function (entry, index) {
      if (entry.kind === "edit" || entry.kind === "draft" || entry.kind === "review") return index <= lastApproved;
      return true;
    });
    item.draft = null;
    item.review = null;
    var approved = latestApproved(item);
    var original = originals[id] || "";
    if (approved) {
      item.edited = approved.source !== original ? approved.source : null;
      item.editedAt = item.edited ? (approved.at || "") : "";
    } else {
      item.edited = null;
      item.editedAt = "";
    }
  }

  function clearDrafts() {
    if (!window.confirm("Export notes, then remove unapproved drafts and their edit history from this browser? Approved versions, their manifest entries, and comments stay.")) return;
    exportNotes();
    sections().forEach(captureOriginal);
    Object.keys(state.diagrams).forEach(function (id) {
      dropDraftData(bucket(id), id);
    });
    save();
    var hint = document.querySelector("#call-tools .call-hint");
    if (hint) hint.textContent = "Unapproved drafts cleared. Approved versions and comments stay in this browser. Nothing is sent to Redis.";
    sections().forEach(function (section) {
      var id = diagramId(section);
      var item = bucket(id);
      delete section.dataset.viewing;
      var box = sourceBox(section);
      if (box) box.value = isLocked(item) ? latestApproved(item).source : (originals[id] || "");
      applyStoredEdit(section);
      paint(section);
      placeMarkers(section);
      var text = isLocked(item) ? latestApproved(item).source : (originals[id] || (box ? box.value : ""));
      renderSource(section, text, "Unapproved drafts cleared.");
    });
  }

  function exportNotes() {
    sections().forEach(captureOriginal);
    var data = payload();
    var jobs = [
      {name: FILE + ".md", text: markdown(data), type: "text/markdown"},
      {name: FILE + ".json", text: JSON.stringify(data, null, 2) + "\n", type: "application/json"}
    ];
    var versions = [];
    Object.keys(data.diagrams).forEach(function (id) {
      (data.diagrams[id].approved || []).forEach(function (version) {
        versions.push({
          diagram: id,
          version: version.n,
          file: "floor/diagrams/approved/" + id + "-v" + version.n + ".mmd",
          hash: version.hash,
          approver: version.approver,
          reviewer: version.reviewer || "",
          at: version.at,
          stamp: stampLine(version)
        });
        jobs.push({
          name: "approved/" + id + "-v" + version.n + ".mmd",
          text: "%% " + stampLine(version) + "\n" + version.source,
          type: "text/plain"
        });
      });
    });
    jobs.push({
      name: "manifest.json",
      text: JSON.stringify({call: data.call, exported_at: data.exported_at, versions: versions}, null, 2) + "\n",
      type: "application/json"
    });
    jobs.forEach(function (job, index) {
      setTimeout(function () { download(job.name, job.text, job.type); }, index * 400);
    });
  }

  function cleanComment(row) {
    if (!row || typeof row !== "object") return null;
    var text = norm(row.text);
    if (!text || !row.id) return null;
    var author = AUTHORS.indexOf(row.author) >= 0 ? row.author : "";
    return {
      id: String(row.id),
      text: text,
      author: author,
      nodeLabel: norm(row.nodeLabel),
      nodeIndex: Number(row.nodeIndex) || 0,
      at: typeof row.at === "string" ? row.at : new Date().toISOString()
    };
  }

  function mergeSpoken(current, incoming) {
    current = current || "";
    incoming = String(incoming || "");
    if (!incoming.trim()) return current;
    if (!current.trim()) return incoming;
    if (current.indexOf(incoming.trim()) !== -1) return current;
    return current.replace(/\s+$/, "") + "\n\n" + incoming.trim();
  }

  function cleanHistory(row) {
    if (!row || typeof row !== "object" || !row.id || !row.kind) return null;
    var author = AUTHORS.indexOf(row.author) >= 0 ? row.author : "";
    return {
      id: String(row.id),
      at: typeof row.at === "string" ? row.at : new Date().toISOString(),
      author: author,
      kind: String(row.kind),
      before: row.before == null ? "" : String(row.before),
      after: row.after == null ? "" : String(row.after),
      nodeLabel: row.nodeLabel ? norm(row.nodeLabel) : ""
    };
  }

  function cleanApproved(row) {
    if (!row || typeof row !== "object" || !row.source || !row.n) return null;
    var source = String(row.source).replace(/\r\n/g, "\n");
    var hash = hashText(source);
    if (row.hash && row.hash !== hash) return {conflict: true};
    var approver = "Mr. Salam";
    var reviewer = REVIEWERS.indexOf(row.reviewer) >= 0 ? row.reviewer : "";
    return {
      n: Number(row.n),
      at: typeof row.at === "string" ? row.at : new Date().toISOString(),
      approver: approver,
      reviewer: reviewer,
      hash: hash,
      source: source
    };
  }

  function importNotes(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      var bar = document.querySelector(".call-hint");
      try {
        data = JSON.parse(String(reader.result || ""));
      } catch (err) {
        if (bar) bar.textContent = "Import the JSON export. The markdown file is for reading.";
        return;
      }
      if (!data || typeof data.diagrams !== "object") return;
      var touched = [];
      var conflict = false;
      Object.keys(data.diagrams).forEach(function (id) {
        var incoming = data.diagrams[id];
        if (!incoming || typeof incoming !== "object") return;
        var item = bucket(id);
        var wasLocked = isLocked(item);
        var seen = {};
        item.comments.forEach(function (comment) { seen[comment.id] = comment; });
        (incoming.comments || []).forEach(function (row) {
          var comment = cleanComment(row);
          if (comment && !seen[comment.id]) {
            seen[comment.id] = comment;
            item.comments.push(comment);
          }
        });
        item.comments.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        item.spoken = mergeSpoken(item.spoken, incoming.spoken);
        var seenH = {};
        item.history.forEach(function (entry) { seenH[entry.id] = true; });
        (incoming.history || []).forEach(function (row) {
          var entry = cleanHistory(row);
          if (entry && !seenH[entry.id]) {
            seenH[entry.id] = true;
            item.history.push(entry);
          }
        });
        item.history.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        (incoming.approved || []).forEach(function (row) {
          var version = cleanApproved(row);
          if (!version) return;
          if (version.conflict) {
            conflict = true;
            return;
          }
          var local = null;
          item.approved.forEach(function (have) { if (have.n === version.n) local = have; });
          if (!local) item.approved.push(version);
          else if (local.hash !== version.hash) conflict = true;
        });
        item.approved.sort(function (a, b) { return a.n - b.n; });
        if (wasLocked) {
          item.draft = null;
          item.review = null;
        } else if (!item.draft && incoming.draft && latestApproved(item) && Number(incoming.draft.from) === latestApproved(item).n && Number(incoming.draft.n) === latestApproved(item).n + 1) {
          item.draft = {n: Number(incoming.draft.n), from: Number(incoming.draft.from), at: incoming.draft.at || ""};
          if (typeof incoming.edited === "string") item.edited = incoming.edited;
        } else if (isLocked(item)) {
          item.draft = null;
          item.review = null;
          item.edited = latestApproved(item).source !== (incoming.original || originals[id]) ? latestApproved(item).source : null;
        } else if (incoming.review && REVIEWERS.indexOf(incoming.review.reviewer) >= 0 && !item.review) {
          item.review = {reviewer: incoming.review.reviewer, at: incoming.review.at || "", by: incoming.review.by || ""};
          if (typeof incoming.edited === "string") item.edited = incoming.edited;
        } else if (incoming.edited && incoming.edited !== incoming.original) {
          var newer = !item.editedAt || String(incoming.editedAt || "") >= String(item.editedAt || "");
          if (newer) {
            item.edited = String(incoming.edited);
            item.editedAt = incoming.editedAt || new Date().toISOString();
          }
        }
        touched.push(id);
      });
      save();
      if (bar) {
        bar.textContent = conflict
          ? "Import kept the local approved text. A version number arrived with a different hash."
          : "Imported. Notes stay in this browser. Nothing is sent to Redis.";
      }
      sections().forEach(function (section) {
        var id = diagramId(section);
        if (touched.indexOf(id) === -1) return;
        delete section.dataset.viewing;
        applyStoredEdit(section);
        paint(section);
        placeMarkers(section);
        var item = bucket(id);
        if (isLocked(item)) renderSource(section, latestApproved(item).source, "Showing the approved text.");
        else if (item.edited) renderSource(section, item.edited, "Diagram redrawn on this screen.");
      });
    };
    reader.readAsText(file);
  }

  function bootSection(section) {
    layout(section);
    ensureSource(section);
    editToggle(section);
    applyStoredEdit(section);
    paint(section);
    watch(section);
    placeMarkers(section);
    var pre = section.querySelector(".diagram-src");
    if (pre && !pre.__callWatch) {
      pre.__callWatch = true;
      new MutationObserver(function () {
        captureOriginal(section);
        var box = sourceBox(section);
        var id = diagramId(section);
        if (box && !box.value && originals[id] && !bucket(id).edited) box.value = originals[id];
        applyStoredEdit(section);
      }).observe(pre, {childList: true, characterData: true, subtree: true});
    }
  }

  ready(function () {
    if (!sections().length) return;
    tools();
    sections().forEach(bootSection);
    window.addEventListener("resize", function () {
      sections().forEach(placeMarkers);
    });
  });
})();
