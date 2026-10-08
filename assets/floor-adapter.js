/* Redis floor adapter.
   The browser never opens a Redis socket and never sees AUTH.
   liveRedis in /data/floor/config.json defaults to false.
   Writes stay on this screen until writesEnabled is true. */
(function (root) {
  "use strict";
  var LOCAL_KEY = "floor-local-v1";

  function fetchJson(url, options) {
    return fetch(url, options || {credentials: "omit"}).then(function (res) {
      if (!res.ok) throw new Error("http");
      return res.json();
    });
  }

  function loadConfig() {
    return fetchJson("/data/floor/config.json");
  }

  function loadSample() {
    return fetchJson("/data/floor/sample.json");
  }

  function publicConfig(config) {
    return {
      liveRedis: config.liveRedis === true,
      writesEnabled: config.writesEnabled === true,
      readApi: config.readApi || "",
      writeApi: config.writeApi || ""
    };
  }

  function asSample(config, payload, notice) {
    var copy = JSON.parse(JSON.stringify(payload));
    copy.origin = "sample";
    copy.source = "sample";
    copy.gate = "held";
    delete copy.key_counts;
    copy.notice = notice || copy.banner || "Sample data. Not a live Redis read.";
    copy.config = publicConfig(config);
    return copy;
  }

  function sanitizeThread(row) {
    var comments = Array.isArray(row.comments) ? row.comments : [];
    return {
      id: String(row.id || ""),
      title: String(row.title || ""),
      project: String(row.project || ""),
      from: String(row.from || ""),
      to: String(row.to || ""),
      state: String(row.state || "requested"),
      assignee: String(row.assignee || ""),
      result: String(row.result || ""),
      sample: false,
      comments: comments.map(function (item) {
        return {text: String(item.text || ""), at: String(item.at || "")};
      })
    };
  }

  function acceptLive(config, body) {
    if (!body || body.source !== "redis" || body.gate !== "clear") return null;
    var counts = null;
    if (body.key_counts && typeof body.key_counts === "object") counts = body.key_counts;
    return {
      origin: "redis",
      source: "redis",
      gate: "clear",
      label: "live",
      observed_at: String(body.observed_at || ""),
      banner: "Live read. The comparison gate is clear.",
      notice: "Live read. The comparison gate is clear.",
      threads: Array.isArray(body.threads) ? body.threads.map(sanitizeThread) : [],
      key_counts: counts,
      config: publicConfig(config)
    };
  }

  function storage() {
    try {
      return root.sessionStorage;
    } catch (err) {
      return null;
    }
  }

  function readLocal() {
    var box = storage();
    if (!box) return {};
    try {
      var raw = box.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function writeLocal(map) {
    var box = storage();
    if (!box) return;
    try {
      box.setItem(LOCAL_KEY, JSON.stringify(map));
    } catch (err) {}
  }

  function applyLocal(payload) {
    var local = readLocal();
    var threads = (payload.threads || []).map(function (row) {
      var patch = local[row.id];
      if (!patch) return row;
      var next = Object.assign({}, row, {local: true});
      if (patch.state) next.state = patch.state;
      if (Object.prototype.hasOwnProperty.call(patch, "assignee")) next.assignee = patch.assignee;
      if (patch.comments && patch.comments.length) {
        next.comments = (row.comments || []).concat(patch.comments);
      }
      return next;
    });
    var copy = Object.assign({}, payload);
    copy.threads = threads;
    return copy;
  }

  function load() {
    return loadConfig().then(function (config) {
      function sample(notice) {
        return loadSample().then(function (payload) {
          return asSample(config, payload, notice);
        });
      }
      if (config.liveRedis !== true || !config.readApi) return sample("");
      return fetchJson(config.readApi).then(function (body) {
        var live = acceptLive(config, body);
        if (!live) return sample("Live read refused. The comparison gate is not clear. Showing the sample.");
        return live;
      }).catch(function () {
        return sample("Live read failed. Showing the sample.");
      });
    }).then(applyLocal);
  }

  function stub(action, id, extra) {
    extra = extra || {};
    return loadConfig().then(function (config) {
      var local = readLocal();
      var patch = local[id] || {comments: []};
      if (!patch.comments) patch.comments = [];
      if (action === "acknowledge") patch.state = "acknowledged";
      if (action === "escalate") patch.state = "escalated";
      if (action === "assign") patch.assignee = extra.assignee || "";
      if (action === "comment" && extra.text) {
        patch.comments = patch.comments.concat([{text: extra.text, at: ""}]);
      }
      local[id] = patch;
      writeLocal(local);
      var result = {
        ok: false,
        wired: false,
        local: true,
        action: action,
        id: id,
        reason: "Saved on this screen only. Not written to Redis."
      };
      if (config.writesEnabled !== true || !config.writeApi) return result;
      var url = String(config.writeApi).replace(/\/$/, "") + "/" + action;
      return fetch(url, {
        method: "POST",
        credentials: "omit",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          id: id,
          assignee: extra.assignee || "",
          text: extra.text || ""
        })
      }).then(function (res) {
        result.wired = !!res.ok;
        result.ok = !!res.ok;
        result.local = false;
        result.reason = res.ok
          ? "Sent through the write bridge."
          : "The write bridge refused the call. The screen copy remains.";
        return result;
      }).catch(function () {
        result.reason = "The write bridge did not answer. The screen copy remains.";
        return result;
      });
    });
  }

  root.FloorAdapter = {
    load: load,
    acknowledge: function (id) { return stub("acknowledge", id, {}); },
    assign: function (id, assignee) { return stub("assign", id, {assignee: assignee}); },
    comment: function (id, text) { return stub("comment", id, {text: text}); },
    escalate: function (id) { return stub("escalate", id, {}); }
  };
})(typeof window !== "undefined" ? window : globalThis);
