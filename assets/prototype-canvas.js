/* Homepage prototyping canvas: a live stage the agents build on while the
 * visitor talks.
 *
 * Each thing the visitor says is sent to the studio controller as an
 * utterance; the builder answers with typed patch events, which arrive here
 * over the session event stream and the command response. Website parts
 * (section, heading, form, field, button, card...) render as real, usable
 * elements. A "scene" node runs as a small game engine at 60 fps: its
 * "entity" children move, spin, pulse, orbit, fall under gravity, bounce,
 * wrap, emit particles, can be picked up and thrown, and react to taps. Every
 * change animates: new things spring in, edited things glide to their new
 * position, size and colour, and removed scene entities fade out (a removed
 * website part is simply gone on the next render).
 *
 * Nothing the model writes is markup or code. Labels are set as text, and an
 * entity is one closed statement checked here against the same grammar the
 * builder gate enforces (Blackboard cloud/studio-controller/workers/
 * claude_worker.py, visual_problem). A statement that fails is not drawn.
 */
(function () {
  "use strict";

  /* ---------- the closed grammar, kept in step with the builder gate ---------- */
  var N = "-?\\d{1,5}(?:\\.\\d{1,3})?";
  var NUM_RE = new RegExp("^" + N + "$");
  var COLOUR_RE = /^(?:#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}|none)$/;
  var POINTS_RE = new RegExp("^" + N + "," + N + "(?:;" + N + "," + N + "){1,39}$");
  var ORBIT_RE = new RegExp("^" + N + "," + N + "," + N + "," + N + "$");
  var PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz][MmLlHhVvCcSsQqTtAaZz0-9.,\-]{0,499}$/;
  var SCENE_RE = /^(\d{2,4})x(\d{2,4})((?: (?:bg=(?:#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}|none)|gravity=-?\d{1,4}))*)$/;
  // One statement is printable ASCII words joined by single spaces, checked
  // exactly as stored - never a trimmed copy (Blackboard #246).
  var STATEMENT_RE = /^[!-~]+(?: [!-~]+)*$/;

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (has(a, k)) o[k] = a[k];
    for (k in b) if (has(b, k)) o[k] = b[k];
    return o;
  }
  function oneOf(list) { return function (v) { return list.indexOf(v) >= 0; }; }

  var PAINT = { fill: "colour", stroke: "colour", "stroke-width": "pos", opacity: "unit", rotate: "num", glow: "colour" };
  var MOTION = { vx: "num", vy: "num", spin: "num", pulse: "unit", period: "pos", "float": "num", orbit: "orbit",
                 body: "bit", bounce: "bit", wrap: "bit", drag: "bit", tap: "tap", delay: "num",
                 solid: "bit", attach: "ref" };
  var BASE = merge(PAINT, MOTION);
  var SHAPES = {
    rect: merge(BASE, { x: "num", y: "num", width: "pos", height: "pos", rx: "pos" }),
    circle: merge(BASE, { cx: "num", cy: "num", r: "pos" }),
    ellipse: merge(BASE, { cx: "num", cy: "num", rx: "pos", ry: "pos" }),
    line: merge(BASE, { x1: "num", y1: "num", x2: "num", y2: "num" }),
    polygon: merge(BASE, { points: "points" }),
    path: merge(BASE, { d: "path" }),
    text: merge(BASE, { x: "num", y: "num", size: "pos", weight: "weight", anchor: "anchor", font: "font", spacing: "num" }),
    particles: merge(BASE, { x: "num", y: "num", rate: "pos", size: "pos", speed: "pos", angle: "num",
                             spread: "pos", life: "pos", shape: "dot" })
  };
  // The geometry each type cannot be drawn without.
  var REQUIRED = { rect: ["x", "y", "width", "height"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
                   line: ["x1", "y1", "x2", "y2"], polygon: ["points"], path: ["d"], text: ["x", "y"], particles: ["x", "y"] };
  var VALUES = {
    num: function (v) { return NUM_RE.test(v); },
    pos: function (v) { return NUM_RE.test(v) && +v >= 0; },
    colour: function (v) { return COLOUR_RE.test(v); },
    unit: function (v) { return NUM_RE.test(v) && +v >= 0 && +v <= 1; },
    bit: oneOf(["0", "1"]),
    ref: function (v) { return /^[A-Za-z0-9._:-]{1,80}$/.test(v); },
    points: function (v) { return POINTS_RE.test(v); },
    orbit: function (v) { return ORBIT_RE.test(v); },
    path: function (v) { return PATH_RE.test(v) && /^[Mm]/.test(v) && (v.match(/[0-9]+(?:[.][0-9]+)?/g) || []).length >= 2; },
    weight: oneOf(["400", "500", "600", "700", "800", "900"]),
    anchor: oneOf(["start", "middle", "end"]),
    font: oneOf(["sans", "serif", "mono", "display"]),
    tap: oneOf(["pulse", "spin", "burst", "jump", "hide"]),
    dot: oneOf(["circle", "square", "star"])
  };

  function parseScene(detail) {
    if (!STATEMENT_RE.test(String(detail || ""))) return null;
    var m = SCENE_RE.exec(String(detail || ""));
    if (!m) return null;
    var w = +m[1], h = +m[2];
    if (w < 16 || w > 2400 || h < 16 || h > 2400) return null;
    var out = { w: w, h: h, bg: "#0f172a", gravity: 0 }, seen = {};
    var parts = m[3].split(" ").filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (seen[kv[0]]) return null;
      seen[kv[0]] = true;
      if (kv[0] === "bg") out.bg = kv[1]; else out.gravity = +kv[1];
    }
    return out;
  }

  function parseEntity(detail) {
    if (!STATEMENT_RE.test(String(detail || ""))) return null;
    var parts = String(detail).split(" ");
    if (!has(SHAPES, parts[0])) return null;
    var allowed = SHAPES[parts[0]], spec = { type: parts[0] };
    for (var i = 1; i < parts.length; i++) {
      var at = parts[i].indexOf("=");
      if (at < 1) return null;
      var key = parts[i].slice(0, at), value = parts[i].slice(at + 1);
      if (!has(allowed, key) || has(spec, key) || !VALUES[allowed[key]](value)) return null;
      spec[key] = value;
    }
    for (var r = 0; r < REQUIRED[spec.type].length; r++) if (!has(spec, REQUIRED[spec.type][r])) return null;
    return spec;
  }

  /* ---------- small helpers ---------- */
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) if (has(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }
  function rgb(c) {
    if (!c || c === "none") return null;
    var h = c.slice(1);
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function css(c, a) {
    return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + (a == null ? 1 : a) + ")";
  }
  function light(c) { return c && (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 150; }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function backOut(p) { var c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
  function rad(d) { return d * Math.PI / 180; }
  function randomHex(bytes) {
    var a = new Uint8Array(bytes), out = "";
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < a.length; j++) out += ("0" + a[j].toString(16)).slice(-2);
    return out;
  }
  function parseJson(text) {
    try { var v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
  }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }

  var FONTS = {
    sans: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    serif: "Georgia, Cambria, Times New Roman, serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    display: "Fraunces, Georgia, serif"
  };
  var NUMERIC = ["x", "y", "width", "height", "rx", "cx", "cy", "r", "ry", "x1", "y1", "x2", "y2",
                 "size", "spacing", "stroke-width", "opacity", "rotate"];
  var COLOURS = ["fill", "stroke", "glow"];
  var TWEEN_S = 0.5;
  var SPAWN_S = 0.45;
  var FADE_S = 0.3;
  var reduced = false;
  try { reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  function targets(spec) {
    var v = {};
    NUMERIC.forEach(function (k) { if (has(spec, k)) v[k] = +spec[k]; });
    COLOURS.forEach(function (k) { if (has(spec, k)) v[k] = rgb(spec[k]); });
    return v;
  }

  /* ---------- the engine: one per scene node ---------- */
  var engines = [];
  var raf = 0, lastTs = 0;

  function frame(ts) {
    raf = 0;
    var dt = lastTs ? Math.min(0.05, Math.max(0, (ts - lastTs) / 1000)) : 0;
    lastTs = ts;
    for (var i = 0; i < engines.length; i++) {
      if (!document.hidden && engines[i].visible) { engines[i].step(dt); engines[i].draw(); }
    }
    if (engines.length) raf = requestAnimationFrame(frame);
    else lastTs = 0;
  }
  function wake() { if (!raf && engines.length) raf = requestAnimationFrame(frame); }

  function Engine(node) {
    var self = this;
    this.id = node.id;
    this.canvas = el("canvas", { "class": "pc-scene", role: "application", tabindex: "0", "data-pc-scene": node.id });
    this.ctx = this.canvas.getContext("2d");
    this.ents = {};
    this.order = [];
    this.bursts = [];
    this.t = 0;
    this.w = 1200; this.h = 600; this.bg = rgb("#0f172a"); this.gravity = 0;
    this.visible = true;
    this.grab = null;
    this.focused = null;
    this.canvas.__pc = this;
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver(function (entries) {
        self.visible = entries[entries.length - 1].isIntersecting;
        wake();
      });
      this.io.observe(this.canvas);
    }
    this.canvas.addEventListener("pointerdown", function (ev) { self.down(ev); });
    this.canvas.addEventListener("pointermove", function (ev) { self.move(ev); });
    this.canvas.addEventListener("pointerup", function (ev) { self.up(ev); });
    this.canvas.addEventListener("pointercancel", function () { self.release(); });
    this.canvas.addEventListener("keydown", function (ev) { self.key(ev); });
    this.canvas.addEventListener("focus", function () {
      if (self.focused) return;
      var list = self.interactive();
      if (list.length) self.setFocus(list[0]);
    });
    this.canvas.addEventListener("blur", function () { self.setFocus(null); });
    engines.push(this);
    this.update(node);
    wake();
  }

  Engine.prototype.destroy = function () {
    if (this.io) this.io.disconnect();
    engines = engines.filter(function (e) { return e !== this; }, this);
  };

  Engine.prototype.update = function (node) {
    var sc = parseScene(node.detail);
    if (!sc) {
      this.invalid = true;
      this.canvas.hidden = true;
      this.order = [];
      this.setFocus(null);
      return;
    }
    this.invalid = false;
    this.canvas.hidden = false;
    this.w = sc.w; this.h = sc.h; this.bg = rgb(sc.bg); this.gravity = sc.gravity;
    this.canvas.style.backgroundColor = this.bg ? "" : "transparent";
    this.canvas.style.aspectRatio = sc.w + " / " + sc.h;
    var self = this, seen = {}, order = [], labels = [], draggable = false;
    (node.children || []).forEach(function (child) {
      if (child.kind !== "entity") return;
      var spec = parseEntity(child.detail);
      if (!spec) return;
      seen[child.id] = true;
      order.push(child.id);
      labels.push(child.label);
      if (spec.drag === "1") draggable = true;
      var e = self.ents[child.id];
      if (!e || e.dying != null || e.spec.type !== spec.type) self.ents[child.id] = self.spawn(child, spec);
      else if (e.detail !== child.detail || e.label !== child.label) self.retarget(e, child, spec);
    });
    for (var id in this.ents) {
      if (has(this.ents, id) && !seen[id]) {
        if (this.ents[id].dying == null) this.ents[id].dying = this.t;
        order.push(id);
      }
    }
    this.order = order;
    if (this.focused && (!this.ents[this.focused.id] || this.focused.dying != null)) this.setFocus(null);
    this.canvas.style.touchAction = draggable ? "none" : "auto";
    this.canvas.setAttribute("aria-label", (node.label || "Scene") + (labels.length ? ": " + labels.join(", ") : ""));
    this.canvas.setAttribute("data-pc-entities", String(labels.length));
    wake();
  };

  Engine.prototype.spawn = function (node, spec) {
    var e = { id: node.id, label: node.label || "", detail: node.detail, spec: spec, cur: targets(spec),
              from: null, to: null, t0: 0, born: this.t + Math.max(0, +spec.delay || 0), dying: null,
              ox: 0, oy: 0, vx: +spec.vx || 0, vy: +spec.vy || 0, angle: 0, phase: Math.random() * 6.283,
              orbit0: Math.random() * 360, parts: [], acc: 0, tapT: null, tapKind: "", hiddenAt: null,
              drag: false, world: null };
    this.shape(e);
    return e;
  };

  Engine.prototype.retarget = function (e, node, spec) {
    var old = e.spec;
    e.from = copy(e.cur);
    e.to = targets(spec);
    e.t0 = this.t;
    e.spec = spec;
    e.label = node.label || "";
    e.detail = node.detail;
    if ((spec.vx || "") !== (old.vx || "")) e.vx = +spec.vx || 0;
    if ((spec.vy || "") !== (old.vy || "")) e.vy = +spec.vy || 0;
    this.shape(e);
  };

  Engine.prototype.shape = function (e) {
    e.points = null; e.path = null; e.pathBox = null;
    if (e.spec.type === "polygon") {
      e.points = e.spec.points.split(";").map(function (p) { var xy = p.split(","); return [+xy[0], +xy[1]]; });
    }
    if (e.spec.type === "path") {
      try { e.path = new Path2D(e.spec.d.replace(/,/g, " ")); } catch (err) { e.path = null; }
      var nums = (e.spec.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number), xs = [], ys = [];
      for (var i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
      if (xs.length) e.pathBox = { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
                                   w: Math.max.apply(null, xs) - Math.min.apply(null, xs),
                                   h: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
    }
  };

  Engine.prototype.box = function (e) {
    var v = e.cur;
    switch (e.spec.type) {
      case "rect": return { x: v.x || 0, y: v.y || 0, w: v.width || 0, h: v.height || 0 };
      case "circle": return { x: (v.cx || 0) - (v.r || 0), y: (v.cy || 0) - (v.r || 0), w: 2 * (v.r || 0), h: 2 * (v.r || 0) };
      case "ellipse": return { x: (v.cx || 0) - (v.rx || 0), y: (v.cy || 0) - (v.ry || 0), w: 2 * (v.rx || 0), h: 2 * (v.ry || 0) };
      case "line": return { x: Math.min(v.x1 || 0, v.x2 || 0), y: Math.min(v.y1 || 0, v.y2 || 0),
                            w: Math.abs((v.x2 || 0) - (v.x1 || 0)), h: Math.abs((v.y2 || 0) - (v.y1 || 0)) };
      case "polygon": {
        var xs = e.points.map(function (p) { return p[0]; }), ys = e.points.map(function (p) { return p[1]; });
        var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
        return { x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 };
      }
      case "path": return e.pathBox || { x: 0, y: 0, w: 0, h: 0 };
      case "text": {
        var size = v.size || 32;
        this.ctx.font = this.font(e);
        var w = this.ctx.measureText(e.label).width;
        var anchor = e.spec.anchor || "start";
        var x = (v.x || 0) - (anchor === "middle" ? w / 2 : anchor === "end" ? w : 0);
        return { x: x, y: (v.y || 0) - size * 0.8, w: w, h: size };
      }
      default: return { x: (v.x || 0) - 4, y: (v.y || 0) - 4, w: 8, h: 8 };
    }
  };

  Engine.prototype.font = function (e) {
    return (e.spec.weight || "600") + " " + (e.cur.size || 32) + "px " + FONTS[e.spec.font || "sans"];
  };

  Engine.prototype.step = function (dt) {
    this.t += dt;
    var t = this.t, g = this.gravity, amb = reduced ? 0 : 1;
    for (var i = 0; i < this.order.length; i++) {
      var e = this.ents[this.order[i]];
      if (!e || t < e.born) continue;
      if (e.to) {
        var p = Math.min(1, (t - e.t0) / TWEEN_S), q = easeOut(p), k;
        for (k in e.to) {
          if (!has(e.to, k)) continue;
          var a = e.from[k], b = e.to[k];
          if (typeof b === "number") e.cur[k] = typeof a === "number" ? lerp(a, b, q) : b;
          else if (b && a) e.cur[k] = [lerp(a[0], b[0], q), lerp(a[1], b[1], q), lerp(a[2], b[2], q)];
          else e.cur[k] = b;
        }
        for (k in e.cur) if (has(e.cur, k) && !has(e.to, k)) delete e.cur[k];
        if (p >= 1) { e.from = null; e.to = null; }
      }
      if (!e.drag && !e.spec.orbit && !this.parent(e)) {
        if (e.spec.body === "1") e.vy += g * dt;
        e.ox += e.vx * dt;
        e.oy += e.vy * dt;
        if (e.spec.body === "1") this.collide(e);
        this.bounds(e);
      }
      e.angle += (+e.spec.spin || 0) * dt * amb;
      if (e.spec.type === "particles") this.emit(e, dt * amb);
    }
    for (var j = this.bursts.length - 1; j >= 0; j--) {
      var b2 = this.bursts[j];
      b2.age += dt; b2.vy += g * 0.4 * dt + 60 * dt; b2.x += b2.vx * dt; b2.y += b2.vy * dt;
      if (b2.age >= b2.life) this.bursts.splice(j, 1);
    }
    for (var id in this.ents) {
      if (has(this.ents, id) && this.ents[id].dying != null && t - this.ents[id].dying > FADE_S) {
        delete this.ents[id];
        this.order = this.order.filter(function (x) { return x !== id; });
      }
    }
  };

  /* The entity this one is a part of (attach=), one level deep, or null. */
  Engine.prototype.parent = function (e) {
    var p = e.spec.attach ? this.ents[e.spec.attach] : null;
    return p && p !== e && !p.spec.attach && p.dying == null ? p : null;
  };

  /* A body meets a solid: push it out along the shallower overlap and bounce
     (or settle, when it is not bouncy) on that axis. */
  Engine.prototype.collide = function (e) {
    var bb = this.box(e);
    for (var i = 0; i < this.order.length; i++) {
      var s = this.ents[this.order[i]];
      if (!s || s === e || s.spec.solid !== "1" || s.dying != null || this.t < s.born) continue;
      var sb = this.box(s);
      var ex0 = bb.x + e.ox, ey0 = bb.y + e.oy, ex1 = ex0 + bb.w, ey1 = ey0 + bb.h;
      var sx0 = sb.x + s.ox, sy0 = sb.y + s.oy, sx1 = sx0 + sb.w, sy1 = sy0 + sb.h;
      var ox = Math.min(ex1, sx1) - Math.max(ex0, sx0), oy = Math.min(ey1, sy1) - Math.max(ey0, sy0);
      if (ox <= 0 || oy <= 0) continue;
      var rest = e.spec.bounce === "1" ? 0.78 : 0.2;
      if (oy <= ox) {
        if (ey0 + bb.h / 2 < sy0 + sb.h / 2) {
          e.oy -= oy;
          if (e.vy > 0) e.vy = -e.vy * rest;
          if (Math.abs(e.vy) < 40) e.vy = 0;
          e.vx *= 0.985;
        } else {
          e.oy += oy;
          if (e.vy < 0) e.vy = -e.vy * rest;
        }
      } else if (ex0 + bb.w / 2 < sx0 + sb.w / 2) {
        e.ox -= ox;
        if (e.vx > 0) e.vx = -e.vx * rest;
      } else {
        e.ox += ox;
        if (e.vx < 0) e.vx = -e.vx * rest;
      }
    }
  };

  Engine.prototype.bounds = function (e) {
    var bouncy = e.spec.bounce === "1", wraps = e.spec.wrap === "1";
    if (!bouncy && !wraps) return;
    var bb = this.box(e), x0 = bb.x + e.ox, y0 = bb.y + e.oy, x1 = x0 + bb.w, y1 = y0 + bb.h;
    if (bouncy) {
      var rest = e.spec.body === "1" ? 0.78 : 1;
      if (x0 < 0) { e.ox -= x0; e.vx = Math.abs(e.vx) * rest; }
      if (x1 > this.w) { e.ox -= x1 - this.w; e.vx = -Math.abs(e.vx) * rest; }
      if (y0 < 0) { e.oy -= y0; e.vy = Math.abs(e.vy) * rest; }
      if (y1 > this.h) {
        e.oy -= y1 - this.h;
        e.vy = -Math.abs(e.vy) * rest;
        if (e.spec.body === "1") {
          if (Math.abs(e.vy) < 40) e.vy = 0;
          e.vx *= 0.985;
        }
      }
    } else {
      if (x0 > this.w) e.ox -= this.w + bb.w;
      if (x1 < 0) e.ox += this.w + bb.w;
      if (y0 > this.h) e.oy -= this.h + bb.h;
      if (y1 < 0) e.oy += this.h + bb.h;
    }
  };

  Engine.prototype.emit = function (e, dt) {
    var s = e.spec, rate = Math.min(200, Math.max(0, +s.rate || 20)), life = Math.max(0.2, +s.life || 3);
    e.acc += rate * dt;
    while (e.acc >= 1) {
      e.acc -= 1;
      var a = rad((+s.angle || 0) + (Math.random() - 0.5) * (+s.spread || 30));
      var sp = (+s.speed || 60) * (0.6 + Math.random() * 0.8);
      e.parts.push({ x: (+s.x || 0) + e.ox, y: (+s.y || 0) + e.oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                     age: 0, life: life * (0.7 + Math.random() * 0.6), size: (+s.size || 4) * (0.6 + Math.random() * 0.8) });
    }
    if (e.parts.length > 400) e.parts.splice(0, e.parts.length - 400);
    for (var i = e.parts.length - 1; i >= 0; i--) {
      var p = e.parts[i];
      p.age += dt;
      p.vy += this.gravity * 0.3 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.age >= p.life) e.parts.splice(i, 1);
    }
  };

  Engine.prototype.draw = function () {
    if (this.invalid) return;
    var c = this.canvas, dpr = window.devicePixelRatio || 1;
    var cw = c.clientWidth || 600, ch = cw * this.h / this.w;
    var bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(ch * dpr));
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    var ctx = this.ctx, scale = bw / this.w;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (this.bg) { ctx.fillStyle = css(this.bg); ctx.fillRect(0, 0, this.w, this.h); }
    else ctx.clearRect(0, 0, this.w, this.h);
    for (var i = 0; i < this.order.length; i++) {
      var e = this.ents[this.order[i]];
      if (e) this.drawEntity(e);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    for (var j = 0; j < this.bursts.length; j++) {
      var b = this.bursts[j];
      ctx.globalAlpha = Math.max(0, 1 - b.age / b.life);
      ctx.fillStyle = css(b.colour);
      ctx.beginPath(); ctx.arc(b.x, b.y, b.size, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (this.focused && this.focused.world && document.activeElement === this.canvas) {
      var w = this.focused.world;
      ctx.save();
      ctx.strokeStyle = "#FFE14A";
      ctx.lineWidth = 4;
      ctx.strokeRect(w.x - 6, w.y - 6, w.w + 12, w.h + 12);
      ctx.restore();
    }
  };

  Engine.prototype.drawEntity = function (e) {
    var ctx = this.ctx, t = this.t, v = e.cur, amb = reduced ? 0 : 1;
    var age = t - e.born;
    if (age < 0) { e.world = null; return; }
    if (e.spec.type === "particles") { this.drawParticles(e); return; }
    var bb = this.box(e), cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    var ox = e.ox, oy = e.oy, per = Math.max(0.2, +e.spec.period || 2), s = 1, extra = 0;
    if (e.spec.orbit && !e.drag) {
      var o = e.spec.orbit.split(",").map(Number), th = rad(e.orbit0 + o[3] * t * amb);
      ox = o[0] + o[2] * Math.cos(th) - cx; oy = o[1] + o[2] * Math.sin(th) - cy;
      e.ox = ox; e.oy = oy;
    }
    if (+e.spec["float"]) oy += (+e.spec["float"]) * Math.sin(6.283 * t / per + e.phase) * amb;
    if (+e.spec.pulse) s *= 1 + (+e.spec.pulse) * 0.25 * Math.sin(6.283 * t / per + e.phase) * amb;
    if (age < SPAWN_S) s *= Math.max(0.01, backOut(age / SPAWN_S));
    if (e.tapT != null) {
      var ta = t - e.tapT;
      if (e.tapKind === "pulse") s *= 1 + 0.35 * Math.sin(Math.min(1, ta / 0.4) * Math.PI);
      if (e.tapKind === "spin") extra = 360 * easeOut(Math.min(1, ta / 0.6));
      if (e.tapKind === "jump" && e.spec.body !== "1") oy -= 40 * Math.sin(Math.min(1, ta / 0.5) * Math.PI);
    }
    var alpha = (v.opacity == null ? 1 : v.opacity) * Math.min(1, age / 0.25);
    if (e.dying != null) alpha *= Math.max(0, 1 - (t - e.dying) / FADE_S);
    if (e.hiddenAt != null) alpha *= Math.max(0, 1 - (t - e.hiddenAt) / FADE_S);
    var up = this.parent(e), px = up && up.xf;
    if (px) { ox = 0; oy = 0; alpha *= px.alpha; }
    e.xf = { cx: cx, cy: cy, ox: ox, oy: oy, rot: rad((v.rotate || 0) + e.angle + extra), s: s, alpha: alpha };
    e.world = px ? { x: bb.x + px.ox, y: bb.y + px.oy, w: bb.w, h: bb.h, s: s, part: true }
                 : { x: bb.x + ox, y: bb.y + oy, w: bb.w, h: bb.h, s: s };
    if (alpha <= 0) return;
    ctx.save();
    if (px) {
      ctx.translate(px.cx + px.ox, px.cy + px.oy);
      ctx.rotate(px.rot);
      ctx.scale(px.s, px.s);
      ctx.translate(-px.cx, -px.cy);
    }
    ctx.globalAlpha = alpha;
    ctx.translate(cx + ox, cy + oy);
    ctx.rotate(rad((v.rotate || 0) + e.angle + extra));
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    if (v.glow) { ctx.shadowColor = css(v.glow); ctx.shadowBlur = 24; }
    var fill = v.fill, stroke = v.stroke, lw = v["stroke-width"] == null ? 2 : v["stroke-width"];
    if (e.spec.type === "text") {
      if (!has(e.spec, "fill")) fill = (!this.bg || light(this.bg)) ? [17, 24, 39] : [255, 255, 255];
      ctx.font = this.font(e);
      ctx.textAlign = { start: "left", middle: "center", end: "right" }[e.spec.anchor || "start"];
      ctx.textBaseline = "alphabetic";
      if ("letterSpacing" in ctx) ctx.letterSpacing = (v.spacing || 0) + "px";
      if (fill) { ctx.fillStyle = css(fill); ctx.fillText(e.label, v.x || 0, v.y || 0); }
      if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = css(stroke); ctx.strokeText(e.label, v.x || 0, v.y || 0); }
      ctx.restore();
      return;
    }
    if (e.spec.type === "line") {
      if (!has(e.spec, "stroke")) stroke = (!this.bg || light(this.bg)) ? [17, 24, 39] : [255, 255, 255];
      fill = null;
    } else if (!has(e.spec, "fill") && !has(e.spec, "stroke")) {
      fill = [148, 163, 184];
    }
    if (e.spec.type === "path") {
      if (e.path) {
        if (fill) { ctx.fillStyle = css(fill); ctx.fill(e.path); }
        if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = css(stroke); ctx.stroke(e.path); }
      }
      ctx.restore();
      return;
    }
    ctx.beginPath();
    if (e.spec.type === "rect") {
      var r = Math.max(0, Math.min(v.rx || 0, (v.width || 0) / 2, (v.height || 0) / 2));
      var x = v.x || 0, y = v.y || 0, w = v.width || 0, h = v.height || 0;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    } else if (e.spec.type === "circle") {
      ctx.arc(v.cx || 0, v.cy || 0, Math.max(0, v.r || 0), 0, 6.283);
    } else if (e.spec.type === "ellipse") {
      ctx.ellipse(v.cx || 0, v.cy || 0, Math.max(0, v.rx || 0), Math.max(0, v.ry || 0), 0, 0, 6.283);
    } else if (e.spec.type === "line") {
      ctx.moveTo(v.x1 || 0, v.y1 || 0); ctx.lineTo(v.x2 || 0, v.y2 || 0);
    } else if (e.spec.type === "polygon") {
      e.points.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.closePath();
    }
    if (fill) { ctx.fillStyle = css(fill); ctx.fill(); }
    if (stroke) { ctx.lineWidth = e.spec.type === "line" && v["stroke-width"] == null ? 3 : lw; ctx.strokeStyle = css(stroke); ctx.stroke(); }
    ctx.restore();
  };

  Engine.prototype.drawParticles = function (e) {
    var ctx = this.ctx, colour = e.cur.fill || [255, 255, 255], shape = e.spec.shape || "circle";
    var alpha0 = e.cur.opacity == null ? 1 : e.cur.opacity;
    if (e.dying != null) alpha0 *= Math.max(0, 1 - (this.t - e.dying) / FADE_S);
    ctx.save();
    if (e.cur.glow) { ctx.shadowColor = css(e.cur.glow); ctx.shadowBlur = 12; }
    ctx.fillStyle = css(colour);
    for (var i = 0; i < e.parts.length; i++) {
      var p = e.parts[i];
      ctx.globalAlpha = alpha0 * Math.max(0, 1 - p.age / p.life);
      ctx.beginPath();
      if (shape === "square") ctx.rect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      else if (shape === "star") {
        for (var k = 0; k < 10; k++) {
          var rr = k % 2 ? p.size * 0.45 : p.size, aa = rad(k * 36 - 90);
          if (k) ctx.lineTo(p.x + Math.cos(aa) * rr, p.y + Math.sin(aa) * rr);
          else ctx.moveTo(p.x + Math.cos(aa) * rr, p.y + Math.sin(aa) * rr);
        }
        ctx.closePath();
      } else ctx.arc(p.x, p.y, p.size / 2, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
    e.world = { x: (+e.spec.x || 0) + e.ox - 6, y: (+e.spec.y || 0) + e.oy - 6, w: 12, h: 12, s: 1 };
  };

  /* ---------- keyboard: Tab cycles drag/tap entities, arrows nudge, Enter taps ---------- */
  Engine.prototype.interactive = function () {
    var list = [];
    for (var i = 0; i < this.order.length; i++) {
      var e = this.ents[this.order[i]];
      if (!e || e.world && e.world.part || e.dying != null || e.hiddenAt != null) continue;
      if (e.spec.drag === "1" || e.spec.tap) list.push(e);
    }
    return list;
  };

  Engine.prototype.setFocus = function (e) {
    this.focused = e || null;
    if (e) this.canvas.setAttribute("data-pc-focus", e.id);
    else this.canvas.removeAttribute("data-pc-focus");
    wake();
  };

  Engine.prototype.key = function (ev) {
    var list = this.interactive(), idx = list.indexOf(this.focused);
    if (ev.key === "Tab") {
      if (!list.length) return;
      if (ev.shiftKey) {
        if (idx <= 0) { this.setFocus(null); return; }
        this.setFocus(list[idx - 1]);
      } else {
        if (idx < 0) { this.setFocus(list[0]); ev.preventDefault(); return; }
        if (idx >= list.length - 1) { this.setFocus(null); return; }
        this.setFocus(list[idx + 1]);
      }
      ev.preventDefault();
      return;
    }
    var e = this.focused;
    if (!e) return;
    if (ev.key === "Enter" || ev.key === " ") {
      if (e.spec.tap) { ev.preventDefault(); this.tap(e); }
      return;
    }
    if (e.spec.drag !== "1") return;
    var dx = ev.key === "ArrowLeft" ? -10 : ev.key === "ArrowRight" ? 10 : 0;
    var dy = ev.key === "ArrowUp" ? -10 : ev.key === "ArrowDown" ? 10 : 0;
    if (!dx && !dy) return;
    ev.preventDefault();
    e.ox += dx;
    e.oy += dy;
    wake();
  };

  /* ---------- pointer: pick up, throw, tap ---------- */
  Engine.prototype.point = function (ev) {
    var r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * this.w / (r.width || 1), y: (ev.clientY - r.top) * this.h / (r.height || 1),
             at: ev.timeStamp || Date.now() };
  };

  Engine.prototype.hit = function (p) {
    for (var i = this.order.length - 1; i >= 0; i--) {
      var e = this.ents[this.order[i]];
      if (!e || !e.world || e.world.part || e.dying != null || e.hiddenAt != null) continue;
      if (e.spec.drag !== "1" && !e.spec.tap) continue;
      var w = e.world, pad = 8, cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      var hw = w.w * w.s / 2 + pad, hh = w.h * w.s / 2 + pad;
      if (Math.abs(p.x - cx) <= hw && Math.abs(p.y - cy) <= hh) return e;
    }
    return null;
  };

  Engine.prototype.down = function (ev) {
    var p = this.point(ev), e = this.hit(p);
    if (!e) return;
    ev.preventDefault();
    try { this.canvas.setPointerCapture(ev.pointerId); } catch (err) {}
    this.grab = { e: e, id: ev.pointerId, sx: p.x, sy: p.y, last: p, moved: false, ox0: e.ox, oy0: e.oy };
    if (e.spec.drag === "1") { e.drag = true; e.vx = 0; e.vy = 0; }
  };

  Engine.prototype.move = function (ev) {
    var gr = this.grab;
    if (!gr || ev.pointerId !== gr.id) return;
    var p = this.point(ev), e = gr.e;
    if (Math.abs(p.x - gr.sx) + Math.abs(p.y - gr.sy) > 6) gr.moved = true;
    if (e.drag) {
      var dt = Math.max(0.008, (p.at - gr.last.at) / 1000);
      e.ox = gr.ox0 + (p.x - gr.sx); e.oy = gr.oy0 + (p.y - gr.sy);
      e.vx = (p.x - gr.last.x) / dt; e.vy = (p.y - gr.last.y) / dt;
    }
    gr.last = p;
  };

  Engine.prototype.up = function (ev) {
    var gr = this.grab;
    if (!gr || ev.pointerId !== gr.id) return;
    if (!gr.moved && gr.e.spec.tap) this.tap(gr.e);
    this.release();
  };

  Engine.prototype.release = function () {
    var gr = this.grab;
    this.grab = null;
    if (!gr || !gr.e.drag) return;
    var e = gr.e;
    e.drag = false;
    var moves = e.spec.body === "1" || +e.spec.vx || +e.spec.vy || e.spec.bounce === "1" || e.spec.wrap === "1";
    if (!moves || !gr.moved) { e.vx = +e.spec.vx || 0; e.vy = +e.spec.vy || 0; }
    else { e.vx = Math.max(-2500, Math.min(2500, e.vx)); e.vy = Math.max(-2500, Math.min(2500, e.vy)); }
  };

  Engine.prototype.tap = function (e) {
    var kind = e.spec.tap;
    e.tapT = this.t; e.tapKind = kind;
    if (kind === "hide") e.hiddenAt = this.t;
    if (kind === "jump" && e.spec.body === "1") e.vy = -Math.max(420, Math.sqrt(Math.max(0, this.gravity) * this.h));
    if (kind === "burst" && e.world) {
      var colour = e.cur.fill || e.cur.stroke || [255, 255, 255];
      var cx = e.world.x + e.world.w / 2, cy = e.world.y + e.world.h / 2;
      for (var i = 0; i < 28; i++) {
        var a = Math.random() * 6.283, sp = 200 + Math.random() * 220;
        this.bursts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 0.9,
                           size: 3 + Math.random() * 3, colour: colour });
      }
    }
    wake();
  };

  /* A read-only view for tests and debugging. */
  Engine.prototype.snapshot = function () {
    var self = this;
    return this.order.map(function (id) {
      var e = self.ents[id];
      if (!e) return null;
      return { id: id, type: e.spec.type, x: e.world ? e.world.x : null, y: e.world ? e.world.y : null,
               w: e.world ? e.world.w : null, h: e.world ? e.world.h : null, s: e.world ? e.world.s : null,
               angle: e.angle, vx: e.vx, vy: e.vy, cur: copy(e.cur), parts: e.parts.length,
               hidden: e.hiddenAt != null, dying: e.dying != null };
    }).filter(Boolean).concat(this.bursts.length ? [{ id: "(bursts)", parts: this.bursts.length }] : []);
  };

  /* ---------- the data model: a live, draggable diagram ----------
   * Objects are cards (name, a few fields), relationships are links with a
   * label. A small force layout keeps them apart and pulls related ones
   * together; new cards spring in; any card can be dragged. Same frame loop
   * as the scenes. Every string is drawn with fillText, never as markup. */
  var MODEL_W = 1000, MODEL_H = 560, CARD_W = 200;

  function ModelView() {
    var self = this;
    this.canvas = el("canvas", { "class": "pc-model-canvas", role: "application", tabindex: "0", "data-pc-model": "" });
    this.canvas.style.aspectRatio = MODEL_W + " / " + MODEL_H;
    this.ctx = this.canvas.getContext("2d");
    this.nodes = {}; this.links = []; this.t = 0; this.visible = true; this.grab = null; this.focused = null;
    this.canvas.__pc = this;
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver(function (entries) { self.visible = entries[entries.length - 1].isIntersecting; wake(); });
      this.io.observe(this.canvas);
    }
    this.canvas.addEventListener("pointerdown", function (ev) {
      var p = self.point(ev), hit = null;
      for (var id in self.nodes) {
        if (!has(self.nodes, id)) continue;
        var n = self.nodes[id];
        if (Math.abs(p.x - n.x) <= CARD_W / 2 && Math.abs(p.y - n.y) <= n.h / 2) hit = n;
      }
      if (!hit) return;
      ev.preventDefault();
      try { self.canvas.setPointerCapture(ev.pointerId); } catch (err) {}
      self.grab = { n: hit, id: ev.pointerId, dx: hit.x - p.x, dy: hit.y - p.y };
      hit.pinned = true;
    });
    this.canvas.addEventListener("pointermove", function (ev) {
      if (!self.grab || ev.pointerId !== self.grab.id) return;
      var p = self.point(ev);
      self.grab.n.x = p.x + self.grab.dx; self.grab.n.y = p.y + self.grab.dy;
      self.grab.n.vx = 0; self.grab.n.vy = 0;
    });
    function drop() { if (self.grab) self.grab.n.pinned = false; self.grab = null; }
    this.canvas.addEventListener("pointerup", drop);
    this.canvas.addEventListener("pointercancel", drop);
    this.canvas.addEventListener("keydown", function (ev) { self.key(ev); });
    this.canvas.addEventListener("focus", function () {
      if (self.focused) return;
      var list = self.interactive();
      if (list.length) self.setFocus(list[0]);
    });
    this.canvas.addEventListener("blur", function () { self.setFocus(null); });
    this.canvas.style.touchAction = "none";
    engines.push(this);
    wake();
  }

  ModelView.prototype.point = Engine.prototype.point;
  ModelView.prototype.w = MODEL_W;
  ModelView.prototype.h = MODEL_H;

  ModelView.prototype.update = function (model) {
    var seen = {}, self = this, objects = (model && model.objects) || [], i = 0;
    objects.forEach(function (o) {
      if (!o || typeof o.id !== "string") return;
      seen[o.id] = true;
      var fields = (o.fields || []).slice(0, 6).map(function (f) { return String(f.name || "") + "  " + String(f.type || ""); });
      var n = self.nodes[o.id];
      if (!n) {
        var a = (i / Math.max(1, objects.length)) * 6.283;
        n = self.nodes[o.id] = { id: o.id, x: MODEL_W / 2 + Math.cos(a) * 220, y: MODEL_H / 2 + Math.sin(a) * 160,
                                 vx: 0, vy: 0, born: self.t, pinned: false };
      }
      n.name = String(o.name || o.id); n.standard = !!o.standard; n.fields = fields;
      n.h = 34 + fields.length * 18 + 8;
      i += 1;
    });
    for (var id in this.nodes) if (has(this.nodes, id) && !seen[id]) delete this.nodes[id];
    this.links = ((model && model.relationships) || []).filter(function (r) {
      return r && self.nodes[r.from] && self.nodes[r.to];
    }).map(function (r) { return { from: r.from, to: r.to, kind: r.kind, label: String(r.label || "") }; });
    this.canvas.setAttribute("aria-label", "Data model: " + objects.map(function (o) { return o && o.name; }).join(", "));
    this.canvas.setAttribute("data-pc-objects", String(Object.keys(this.nodes).length));
    if (this.focused && !this.nodes[this.focused.id]) this.setFocus(null);
    wake();
  };

  ModelView.prototype.interactive = function () {
    var self = this;
    return Object.keys(this.nodes).map(function (id) { return self.nodes[id]; });
  };

  ModelView.prototype.setFocus = function (n) {
    if (this.focused && this.focused !== n) this.focused.pinned = false;
    this.focused = n || null;
    if (n) {
      n.pinned = true;
      this.canvas.setAttribute("data-pc-focus", n.id);
    } else this.canvas.removeAttribute("data-pc-focus");
    wake();
  };

  ModelView.prototype.key = function (ev) {
    var list = this.interactive(), idx = list.indexOf(this.focused);
    if (ev.key === "Tab") {
      if (!list.length) return;
      if (ev.shiftKey) {
        if (idx <= 0) { this.setFocus(null); return; }
        this.setFocus(list[idx - 1]);
      } else {
        if (idx < 0) { this.setFocus(list[0]); ev.preventDefault(); return; }
        if (idx >= list.length - 1) { this.setFocus(null); return; }
        this.setFocus(list[idx + 1]);
      }
      ev.preventDefault();
      return;
    }
    var n = this.focused;
    if (!n) return;
    var dx = ev.key === "ArrowLeft" ? -10 : ev.key === "ArrowRight" ? 10 : 0;
    var dy = ev.key === "ArrowUp" ? -10 : ev.key === "ArrowDown" ? 10 : 0;
    if (!dx && !dy) return;
    ev.preventDefault();
    n.x = Math.max(CARD_W / 2 + 8, Math.min(MODEL_W - CARD_W / 2 - 8, n.x + dx));
    n.y = Math.max(n.h / 2 + 8, Math.min(MODEL_H - n.h / 2 - 8, n.y + dy));
    n.vx = 0; n.vy = 0;
    wake();
  };

  ModelView.prototype.step = function (dt) {
    this.t += dt;
    var ids = Object.keys(this.nodes), k, a, b, dx, dy, d, f;
    for (k = 0; k < ids.length; k++) {
      a = this.nodes[ids[k]];
      for (var m = k + 1; m < ids.length; m++) {
        b = this.nodes[ids[m]];
        dx = b.x - a.x; dy = b.y - a.y; d = Math.max(30, Math.sqrt(dx * dx + dy * dy));
        f = 260000 / (d * d);
        a.vx -= f * dx / d * dt; a.vy -= f * dy / d * dt; b.vx += f * dx / d * dt; b.vy += f * dy / d * dt;
      }
    }
    for (k = 0; k < this.links.length; k++) {
      a = this.nodes[this.links[k].from]; b = this.nodes[this.links[k].to];
      dx = b.x - a.x; dy = b.y - a.y; d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      f = (d - 340) * 2.2;
      a.vx += f * dx / d * dt; a.vy += f * dy / d * dt; b.vx -= f * dx / d * dt; b.vy -= f * dy / d * dt;
    }
    for (k = 0; k < ids.length; k++) {
      a = this.nodes[ids[k]];
      if (a.pinned) continue;
      a.vx += (MODEL_W / 2 - a.x) * 0.6 * dt; a.vy += (MODEL_H / 2 - a.y) * 0.6 * dt;
      a.vx *= 0.9; a.vy *= 0.9;
      a.x = Math.max(CARD_W / 2 + 8, Math.min(MODEL_W - CARD_W / 2 - 8, a.x + a.vx * dt * 60 / 60));
      a.y = Math.max(a.h / 2 + 8, Math.min(MODEL_H - a.h / 2 - 8, a.y + a.vy * dt * 60 / 60));
    }
  };

  ModelView.prototype.draw = function () {
    var c = this.canvas, dpr = window.devicePixelRatio || 1;
    var cw = c.clientWidth || 600, bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(cw * MODEL_H / MODEL_W * dpr));
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    var ctx = this.ctx, scale = bw / MODEL_W, self = this;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, MODEL_W, MODEL_H);
    ctx.font = "500 13px " + FONTS.sans; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    this.links.forEach(function (l) {
      var a = self.nodes[l.from], b = self.nodes[l.to];
      ctx.save();
      ctx.strokeStyle = l.kind === "master-detail" ? "#F7B267" : "#7DD3FC";
      ctx.lineWidth = l.kind === "master-detail" ? 4 : 2;
      if (l.kind === "many-to-many" && ctx.setLineDash) ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    });
    Object.keys(this.nodes).forEach(function (id) {
      var n = self.nodes[id], age = self.t - n.born, s = age < SPAWN_S ? Math.max(0.01, backOut(age / SPAWN_S)) : 1;
      ctx.save();
      ctx.translate(n.x, n.y); ctx.scale(s, s);
      var x = -CARD_W / 2, y = -n.h / 2;
      ctx.fillStyle = "#1E293B"; ctx.strokeStyle = n.standard ? "#38BDF8" : "#F472B6"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 10, y); ctx.arcTo(x + CARD_W, y, x + CARD_W, y + n.h, 10); ctx.arcTo(x + CARD_W, y + n.h, x, y + n.h, 10);
      ctx.arcTo(x, y + n.h, x, y, 10); ctx.arcTo(x, y, x + CARD_W, y, 10); ctx.closePath();
      ctx.fill(); ctx.stroke();
      if (n === self.focused && document.activeElement === self.canvas) {
        ctx.strokeStyle = "#FFE14A"; ctx.lineWidth = 4;
        ctx.strokeRect(x - 6, y - 6, CARD_W + 12, n.h + 12);
      }
      ctx.fillStyle = "#F8FAFC"; ctx.font = "700 15px " + FONTS.sans; ctx.textAlign = "left";
      ctx.fillText(n.name, x + 12, y + 18);
      ctx.fillStyle = n.standard ? "#38BDF8" : "#F472B6"; ctx.font = "600 10px " + FONTS.sans; ctx.textAlign = "right";
      ctx.fillText(n.standard ? "STANDARD" : "CUSTOM", x + CARD_W - 10, y + 18);
      ctx.fillStyle = "#CBD5E1"; ctx.font = "400 12px " + FONTS.mono; ctx.textAlign = "left";
      n.fields.forEach(function (f, i) { ctx.fillText(f.slice(0, 26), x + 12, y + 40 + i * 18); });
      ctx.restore();
    });
    // Link labels last, so a card never hides one.
    ctx.font = "600 13px " + FONTS.sans; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    this.links.forEach(function (l) {
      if (!l.label) return;
      var a = self.nodes[l.from], b = self.nodes[l.to];
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, w = ctx.measureText(l.label).width + 14;
      ctx.fillStyle = "rgba(15,23,42,.92)"; ctx.fillRect(mx - w / 2, my - 11, w, 22);
      ctx.strokeStyle = l.kind === "master-detail" ? "#F7B267" : "#7DD3FC"; ctx.lineWidth = 1; ctx.strokeRect(mx - w / 2, my - 11, w, 22);
      ctx.fillStyle = "#F8FAFC"; ctx.fillText(l.label, mx, my);
    });
  };

  ModelView.prototype.destroy = Engine.prototype.destroy;

  ModelView.prototype.snapshot = function () {
    var self = this;
    return Object.keys(this.nodes).map(function (id) {
      var n = self.nodes[id];
      return { id: id, name: n.name, x: n.x, y: n.y, h: n.h, fields: n.fields.length, standard: n.standard };
    });
  };

  /* ---------- the tree, as events change it ---------- */
  function applyOp(tree, op, fresh, changed) {
    var index = {}, parents = {};
    (function walk(n, parent) {
      index[n.id] = n; parents[n.id] = parent;
      (n.children || []).forEach(function (c) { walk(c, n); });
    })(tree, null);
    var node = index[op.node_id];
    if (!node) return;
    if (op.op === "set_label") { node.label = op.value; changed[node.id] = true; }
    else if (op.op === "set_detail") { node.detail = op.value; changed[node.id] = true; }
    else if (op.op === "insert_child" && op.node && op.node.id) {
      var added = copy(op.node);
      (node.children = node.children || []).push(added);
      (function mark(n) { fresh[n.id] = true; (n.children || []).forEach(mark); })(added);
    } else if (op.op === "remove" && parents[op.node_id]) {
      var parent = parents[op.node_id];
      parent.children = parent.children.filter(function (c) { return c.id !== op.node_id; });
    }
  }

  var CONTAINERS = { screen: 1, section: 1, form: 1, list: 1, card: 1, nav: 1 };

  function create(root, opts) {
    var base = String(opts.base || "").replace(/\/+$/, "");
    var speak = typeof opts.speak === "function" ? opts.speak : function () {};
    // The Muse (a third agent): says its spark in its own voice, and plays a
    // direction's sample line in that direction's tone.
    var museSay = typeof opts.museSay === "function" ? opts.museSay : function () {};
    var museHear = typeof opts.museHear === "function" ? opts.museHear : function () {};
    // The page's guide: something built moves the visitor to "Shape"; a question,
    // the Muse's directions or a second perspective asks for their eye.
    var progress = typeof opts.progress === "function" ? opts.progress : function () {};
    var attention = typeof opts.attention === "function" ? opts.attention : function () {};
    // A tapped design choice earns a word of thanks from the page (owner, 2026-09-25).
    var reward = typeof opts.reward === "function" ? opts.reward : function () {};
    var title = el("h3", { "class": "pc-title", "data-pc-title": "" });
    var stage = el("div", { "class": "pc-stage", "data-pc-stage": "" });
    var ask = el("div", { "class": "pc-ask", "data-pc-ask": "", hidden: "" });
    var status = el("p", { "class": "pc-status", "data-pc-status": "", role: "status", "aria-live": "polite" });
    var chips = el("div", { "class": "pc-agents", "data-pc-agents": "" });
    var chip = {
      builder: el("span", { "class": "pc-agent", "data-pc-agent": "builder" }, "Blueprint"),
      analyst: el("span", { "class": "pc-agent", "data-pc-agent": "analyst", hidden: "" }, "Analyst"),
      muse: el("span", { "class": "pc-agent", "data-pc-agent": "muse", hidden: "" }, "Creative"),
      advisor: el("span", { "class": "pc-agent", "data-pc-agent": "advisor", hidden: "" }, "Gemini")
    };
    var inspireButton = el("button", { type: "button", "class": "pc-inspire", "data-pc-inspire": "", hidden: "" }, "Inspire me");
    chips.appendChild(chip.builder); chips.appendChild(chip.analyst); chips.appendChild(chip.muse);
    chips.appendChild(chip.advisor);
    chips.appendChild(inspireButton);
    // Templates to start from, before anything is said: the set follows the
    // topic picked before Start.
    var STARTERS = {
      "": ["A logo", "A landing page", "A mobile app screen", "A sales dashboard", "A pitch slide"],
      logo: ["A logo", "A wordmark", "An app icon", "A brand palette"],
      website: ["A landing page", "A pricing page", "A contact form", "A product page"],
      app: ["A mobile app screen", "An onboarding flow", "A dashboard", "A settings screen"],
      salesforce_admin: ["A lead routing rule", "An approval flow", "A permission model", "A case escalation"],
      salesforce_data: ["A data model", "A sales dashboard", "A data import plan", "A duplicate cleanup"]
    };
    // Creative topics wake the Muse on the first thing said; the Salesforce
    // ones lead with the analyst, and the Muse waits for "Inspire me".
    var CREATIVE = { "": true, logo: true, website: true, app: true, other: true };
    var starters = el("div", { "class": "pc-starters", "data-pc-starters": "", hidden: "" });
    function fillStarters(topic) {
      starters.textContent = "";
      starters.appendChild(el("span", { "class": "pc-starters-label" }, "Start from"));
      (STARTERS[topic] || STARTERS[""]).forEach(function (label) {
        var b = el("button", { type: "button", "class": "pc-starter", "data-pc-starter": label }, label);
        b.addEventListener("click", function () { queue("Start me " + label.charAt(0).toLowerCase() + label.slice(1) + ".", "tap"); });
        starters.appendChild(b);
      });
    }
    fillStarters("");
    var musePane = el("section", { "class": "pc-muse", "data-pc-muse": "", "aria-label": "Ideas from the creative designer", hidden: "" });
    // The advisor's card (Codex plan R4): which agent says it, what it sees,
    // the next questions with a recommendation. It advises; a tapped option
    // goes to the builder like speech.
    var advicePane = el("section", { "class": "pc-advice", "data-pc-advice": "", "aria-label": "A second perspective", hidden: "" });
    var modelPane = el("section", { "class": "pc-model", "data-pc-model-pane": "", "aria-label": "Data model", hidden: "" });
    var modelTitle = el("h4", { "class": "pc-model-title" }, "Data model");
    var findings = el("ul", { "class": "pc-findings", "data-pc-findings": "" });
    modelPane.appendChild(modelTitle); modelPane.appendChild(findings);
    var modelView = null;
    // What asks for a choice sits above the canvas, so it is seen without scrolling past it.
    root.appendChild(chips); root.appendChild(starters); root.appendChild(title); root.appendChild(ask);
    root.appendChild(musePane); root.appendChild(advicePane); root.appendChild(stage);
    root.appendChild(modelPane); root.appendChild(status);

    function working(agent, on) {
      chip[agent].hidden = false;
      if (on) chip[agent].setAttribute("data-working", "1"); else chip[agent].removeAttribute("data-working");
    }

    var s = null;            // the open session, or null
    var gen = 0;
    var tree = null, lastSeq = 0, version = 1, generation = 0, held = {};
    var gapTimer = null, liveReader = null, listenGen = 0;
    var sceneEngines = {};
    var fresh = {}, changed = {};

    function post(path, body) {
      return fetch(base + path, {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: { "authorization": "Bearer " + s.token, "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.text().then(function (t) { return { status: r.status, body: parseJson(t) }; }); });
    }

    /* --- events: three lanes deliver them. They apply in seq order.
       A patch applies only at artifact_version === version + 1; a skip is held.
       A confirm applies only at the current version. version moves on a patch
       and when a snapshot replaces the tree — never from a command body, and
       never from confirm, question, or model.updated. A gap held for 2s aborts
       the stream and reconnects from Last-Event-ID. A snapshot rewinds the
       cursor only for a higher generation, or the first generation seen after
       the cursor has already moved. A foreign session_id is dropped. --- */
    function clearGap() {
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    }

    function hasLater() {
      for (var k in held) if (has(held, k) && +k > lastSeq) return true;
      return false;
    }

    function armGap() {
      if (gapTimer || !s) return;
      var ticket = s.gen;
      gapTimer = setTimeout(function () {
        gapTimer = null;
        if (!s || ticket !== s.gen) return;
        held = {};
        reopen(ticket);
      }, 2000);
    }

    function decision(ev) {
      if (ev.type === "artifact.patch") {
        if (ev.artifact_version === version + 1 && tree) return "apply";
        if (typeof ev.artifact_version === "number" && ev.artifact_version <= version) return "drop";
        return "hold";
      }
      if (ev.type === "confirm") {
        if (ev.artifact_version === version) return "apply";
        if (typeof ev.artifact_version === "number" && ev.artifact_version > version) return "hold";
        return "drop";
      }
      return "apply";
    }

    function pump() {
      var guard = 0;
      while (held[lastSeq + 1] && guard++ < 200) {
        var next = held[lastSeq + 1];
        var how = decision(next);
        if (how === "hold") { armGap(); return; }
        delete held[lastSeq + 1];
        lastSeq = next.seq;
        if (how === "apply") handle(next);
      }
      if (hasLater()) armGap();
      else clearGap();
    }

    /* true = keep the event. A higher generation applies only through its snapshot. */
    function adoptGeneration(ev) {
      var genNo = typeof ev.generation === "number" ? ev.generation : 0;
      if (!genNo) return true;
      if (!generation) {
        if (ev.type === "artifact.snapshot" && lastSeq > 0) {
          generation = genNo;
          lastSeq = ev.seq - 1;
          held = {};
          clearGap();
        } else generation = genNo;
        return true;
      }
      if (genNo < generation) return false;
      if (genNo > generation) {
        if (ev.type !== "artifact.snapshot") return false;
        generation = genNo;
        lastSeq = ev.seq - 1;
        held = {};
        clearGap();
      }
      return true;
    }

    function apply(ev) {
      if (!s || !ev || typeof ev.seq !== "number" || !isFinite(ev.seq)) return;
      if (typeof ev.session_id === "string" && ev.session_id !== s.id) return;
      if (!adoptGeneration(ev)) return;
      if (ev.seq <= lastSeq) return;
      held[ev.seq] = ev;
      pump();
    }

    function handle(ev) {
      var p = ev.payload || {};
      if (ev.type === "artifact.snapshot" && p.root) {
        tree = copy(p.root);
        if (typeof ev.artifact_version === "number") version = ev.artifact_version;
        fresh = {}; changed = {};
        render();
        if (adviceRev !== version) dropAdvice();
      } else if (ev.type === "artifact.patch" && tree && Array.isArray(p.ops) && ev.artifact_version === version + 1) {
        p.ops.forEach(function (op) { applyOp(tree, op, fresh, changed); });
        version = ev.artifact_version;
        render();
        dropAdvice();                     // advice is for one revision; this is a new one
        scheduleAdvice();
        progress("built");
      } else if (ev.type === "confirm" && p.text && ev.artifact_version === version) {
        status.textContent = String(p.text);
        speak(String(p.text));
      } else if (ev.type === "question.asked" && p.question) {
        showQuestions(null, [p.question]);
        speak(String(p.question.prompt || ""));
      } else if (ev.type === "decision.batch" && Array.isArray(p.questions)) {
        showQuestions(p, p.questions);
        speak(String(p.title || ""));
      } else if (ev.type === "question.answered" || ev.type === "question.superseded") {
        ask.hidden = true; ask.textContent = "";
      } else if (ev.type === "model.updated" && p.model) {
        showModel(p.model);
      }
    }

    function showModel(model) {
      if (!modelView) { modelView = new ModelView(); modelPane.insertBefore(modelView.canvas, findings); }
      modelView.update(model);
      modelTitle.textContent = "Data model" + (model.domain ? " - " + String(model.domain) : "");
      findings.textContent = "";
      (model.findings || []).forEach(function (f) { findings.appendChild(el("li", {}, String(f))); });
      modelPane.hidden = false;
      root.hidden = false;
    }

    /* --- the analyst: one request at a time; what is said meanwhile is kept
       and sent next, together --- */
    function analyze(ticket) {
      if (!s || s.analyzing || !s.toAnalyze.length || !s.analyst) return;
      var text = s.toAnalyze.splice(0, s.toAnalyze.length).join(" ").slice(0, 600);
      s.analyzing = true;
      working("analyst", true);
      post("/v1/session/" + encodeURIComponent(s.id) + "/analyze", { text: text, turn: 0 }).then(function (r) {
        if (!s || ticket !== s.gen) return;
        if (r.status === 200) (r.body.events || []).forEach(apply);
        else if (r.status === 429 && /every/.test(String(r.body.detail || ""))) s.toAnalyze.unshift(text);
        else if (r.status === 503 && /not available/.test(String(r.body.detail || ""))) s.analyst = false;
      }).catch(function () {}).then(function () {
        if (!s || ticket !== s.gen) return;
        s.analyzing = false;
        working("analyst", false);
        if (s.toAnalyze.length) setTimeout(function () { analyze(ticket); }, 3100);
      });
    }

    /* --- the Muse: a spark and three directions to pick from --- */
    function inspire(ticket, text) {
      if (!s || !s.muse || s.inspiring) return;
      s.inspiring = true;
      s.inspireTurn += 1;
      working("muse", true);
      post("/v1/session/" + encodeURIComponent(s.id) + "/inspire",
           { text: String(text || "").slice(0, 600), turn: s.inspireTurn }).then(function (r) {
        if (!s || ticket !== s.gen) return;
        if (r.status === 200 && r.body.muse) {
          showMuse(r.body.muse);
          if (r.body.muse.line) museSay(String(r.body.muse.line));
        } else if (r.status === 429 || (r.status === 503 && /not available/.test(String(r.body.detail || "")))) {
          s.muse = false;
          inspireButton.hidden = true;
        }
      }).catch(function () {}).then(function () {
        if (!s || ticket !== s.gen) return;
        s.inspiring = false;
        working("muse", false);
      });
    }

    var HEX = /^#[0-9A-Fa-f]{6}$/;
    var TYPEFACES = { serif: "Georgia, 'Times New Roman', serif", sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
                      mono: "ui-monospace, SFMono-Regular, Menlo, monospace", display: "var(--display)",
                      script: "'Segoe Script', 'Brush Script MT', cursive" };

    function part(card, label, node) {
      var row = el("div", { "class": "pc-muse-part" });
      row.appendChild(el("span", { "class": "pc-muse-label" }, label));
      row.appendChild(node);
      card.appendChild(row);
    }

    function showMuse(m) {
      // Everything on this pane belongs to the conversation that asked for it:
      // after End, or once another conversation starts, its buttons do nothing
      // (Cursor NO-GO on 378dd94: a Build or Hear in the window before the next
      // session opened was spoken on the new one).
      var ticket = s ? s.gen : -1;
      var mine = function () { return !!s && s.gen === ticket; };
      musePane.textContent = "";
      musePane.appendChild(el("h4", { "class": "pc-muse-title" }, "The creative designer"));
      if (m.line) musePane.appendChild(el("p", { "class": "pc-muse-line", "data-pc-muse-line": "" }, String(m.line)));
      var grid = el("div", { "class": "pc-muse-grid" });
      var picked = [];
      var build = el("button", { type: "button", "class": "pc-muse-build", "data-pc-muse-build": "", disabled: "" },
                     "Build with my picks");
      (Array.isArray(m.directions) ? m.directions : []).slice(0, 3).forEach(function (d) {
        var id = String((d && d.id) || "");
        if (!/^[abc]$/.test(id)) return;
        var see = d.see || {}, read = d.read || {}, hear = d.hear || {};
        var palette = (Array.isArray(see.palette) ? see.palette : []).map(String).filter(function (c) { return HEX.test(c); }).slice(0, 5);
        var card = el("article", { "class": "pc-muse-card", "data-pc-direction": id });
        if (palette.length) {                      // the direction's mood, at a glance
          var band = el("div", { "class": "pc-muse-band", "aria-hidden": "true" });
          band.style.background = palette.length > 1 ? "linear-gradient(90deg," + palette.join(",") + ")" : palette[0];
          card.appendChild(band);
        }
        card.appendChild(el("h5", {}, String(d.title || "")));
        var look = el("div", { "class": "pc-muse-see" });
        var swatches = el("div", { "class": "pc-swatches", "aria-hidden": "true" });
        palette.forEach(function (c) { var x = el("span", { "class": "pc-swatch" }); x.style.background = c; swatches.appendChild(x); });
        look.appendChild(swatches);
        look.appendChild(el("span", {}, String(see.motif || "")));
        part(card, "See", look);
        var words = el("div", { "class": "pc-muse-read" });
        var headline = el("b", {}, String(read.headline || ""));
        if (has(TYPEFACES, String(see.type || ""))) headline.style.fontFamily = TYPEFACES[String(see.type)];
        words.appendChild(headline);
        words.appendChild(el("span", {}, String(read.line || "")));
        part(card, "Read", words);
        var sound = el("div", { "class": "pc-muse-hear" });
        sound.appendChild(el("span", {}, String(hear.tone || "")));
        if (s && s.hear) {
          var play = el("button", { type: "button", "class": "pc-muse-play", "data-pc-hear": id }, "Hear it");
          play.addEventListener("click", function () { if (mine()) museHear(id); });
          sound.appendChild(play);
        }
        part(card, "Hear", sound);
        part(card, "Work", el("span", {}, String(d.work || "")));
        var like = el("button", { type: "button", "class": "pc-muse-like", "data-pc-like": id, "aria-pressed": "false" }, "I like this");
        like.addEventListener("click", function () {
          if (!mine()) return;
          var on = like.getAttribute("aria-pressed") !== "true";
          if (on && picked.length >= 2) return;          // one or two picks: the brief must fit one utterance
          like.setAttribute("aria-pressed", on ? "true" : "false");
          card.classList.toggle("pc-muse-picked", on);
          picked = picked.filter(function (p) { return p.id !== id; });
          if (on) picked.push({ id: id, title: String(d.title || ""), palette: palette, type: String(see.type || ""),
                                motif: String(see.motif || ""), headline: String(read.headline || ""), tone: String(hear.tone || "") });
          build.disabled = !picked.length;
          if (on) { reward(like); attention(build); }           // the pick is thanked; Build is next
          else attention(picked.length ? build : musePane);     // no picks left: back to the directions
          // With two picked, the other cards wait until one is unpicked.
          Array.prototype.forEach.call(grid.querySelectorAll("[data-pc-like]"), function (b) {
            b.disabled = picked.length >= 2 && b.getAttribute("aria-pressed") !== "true";
          });
        });
        card.appendChild(like);
        grid.appendChild(card);
      });
      build.addEventListener("click", function () {
        if (!picked.length || !mine()) return;
        // Compact, so two picks fit the 600-character utterance even at the
        // controller's longest fields: title, three colours, type, headline, tone.
        var parts = picked.map(function (p) {
          return "\"" + p.title + "\" (" + p.palette.slice(0, 3).join(" ") + ", " + p.type + " type, \"" +
                 p.headline + "\"; tone: " + p.tone + ")";
        });
        var text = picked.length === 1 ? "Go with the " + parts[0] + " direction." : "Blend these directions: " + parts.join(" and ") + ".";
        build.disabled = true;
        museSay("Love those picks. Over to the architect.");
        queue(text.slice(0, 600), "tap");
      });
      musePane.appendChild(grid);
      musePane.appendChild(build);
      musePane.hidden = false;
      attention(musePane);
      root.hidden = false;
    }

    /* --- the advisor: a second perspective on the committed canvas --- */
    var adviceTimer = null;
    var adviceRev = -1;                   // the revision the card on screen is about; -1 when none
    function dropAdvice() {
      adviceRev = -1;
      advicePane.hidden = true;
      advicePane.textContent = "";
    }

    function scheduleAdvice() {
      if (!s || !s.advisor) return;
      if (adviceTimer) clearTimeout(adviceTimer);
      var ticket = s.gen;
      adviceTimer = setTimeout(function () { adviceTimer = null; askAdvice(ticket); }, 1200);
    }

    function askAdvice(ticket) {
      if (!s || ticket !== s.gen || !s.advisor || s.advising) return;
      var asked = version;
      s.advising = true;
      working("advisor", true);
      post("/v1/session/" + encodeURIComponent(s.id) + "/advise", { revision: asked }).then(function (r) {
        if (!s || ticket !== s.gen) return;
        if (r.status === 200 && r.body.advice && r.body.advice.revision === version) showAdvice(r.body.advice);
        else if (r.status === 503) { s.advisor = false; dropAdvice(); }
      }).catch(function () {}).then(function () {
        if (!s || ticket !== s.gen) return;
        s.advising = false;
        working("advisor", false);
        if (version !== asked) scheduleAdvice();      // the canvas moved while it thought: ask about the new one
      });
    }

    function showAdvice(a) {
      var ticket = s ? s.gen : -1;
      var rev = a.revision;
      // A tap counts only in this session and while the canvas is still at the revision the advice read.
      var mine = function () { return !!s && s.gen === ticket && version === rev && adviceRev === rev; };
      adviceRev = rev;
      advicePane.textContent = "";
      var head = el("div", { "class": "pc-advice-head" });
      head.appendChild(el("span", { "class": "pc-advice-who" }, "Gemini"));
      head.appendChild(el("span", { "class": "pc-advice-kind" }, "a second perspective"));
      advicePane.appendChild(head);
      if (a.perspective) advicePane.appendChild(el("p", { "class": "pc-advice-line", "data-pc-advice-line": "" }, String(a.perspective)));
      (Array.isArray(a.questions) ? a.questions : []).slice(0, 2).forEach(function (q) {
        var box = el("div", { "class": "pc-advice-q", "data-pc-advice-q": String(q.id || "") });
        box.appendChild(el("p", { "class": "pc-advice-prompt" }, String(q.prompt || "")));
        if (q.why) box.appendChild(el("p", { "class": "pc-advice-why" }, String(q.why)));
        var row = el("div", { "class": "pc-advice-options" });
        (Array.isArray(q.options) ? q.options : []).slice(0, 4).forEach(function (o) {
          var id = String((o && o.id) || "");
          if (!/^[a-d]$/.test(id)) return;
          var recommended = id === q.recommended;
          var b = el("button", { type: "button", "class": "pc-advice-opt" + (recommended ? " pc-advice-rec" : ""),
                                 "data-pc-advice-option": id }, String(o.label || ""));
          if (recommended) b.appendChild(el("span", { "class": "pc-advice-star" }, " - recommended"));
          b.addEventListener("click", function () {
            if (!mine()) return;
            Array.prototype.forEach.call(row.querySelectorAll("button"), function (x) { x.disabled = true; });
            b.setAttribute("aria-pressed", "true");
            reward(b);
            queue(String(q.prompt || "").slice(0, 200) + " " + String(o.label || "").slice(0, 80) + ".", "tap");
          });
          row.appendChild(b);
        });
        box.appendChild(row);
        advicePane.appendChild(box);
      });
      var risks = (Array.isArray(a.risks) ? a.risks : []).slice(0, 3);
      if (risks.length) {
        var list = el("ul", { "class": "pc-advice-risks" });
        risks.forEach(function (r) { list.appendChild(el("li", {}, String(r))); });
        advicePane.appendChild(list);
      }
      advicePane.hidden = false;
      attention(advicePane);
      root.hidden = false;
    }

    /* Something to build, said or tapped: to the builder and the analyst, and
       the first one also wakes the Muse. */
    function queue(text, itemId) {
      if (!s || !text) return;
      starters.hidden = true;
      s.lastText = String(text);
      s.pending.push({ text: String(text), item_id: String(itemId === "tap" ? "tap-" + randomHex(6) : itemId) });
      s.toAnalyze.push(String(text));
      drain(s.gen);
      analyze(s.gen);
      if (!s.inspired && s.muse && s.autoMuse) { s.inspired = true; inspire(s.gen, text); }
    }

    inspireButton.addEventListener("click", function () { if (s) inspire(s.gen, s.lastText || ""); });

    function frames(text, ticket) {
      var chunks = text.split(/\r?\n\r?\n/), rest = chunks.pop();
      chunks.forEach(function (chunk) {
        var data = [];
        chunk.split(/\r?\n/).forEach(function (line) { if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^ /, "")); });
        if (data.length && s && ticket === s.gen) apply(parseJson(data.join("\n")));
      });
      return rest;
    }

    function reopen(ticket) {
      if (!s || ticket !== s.gen) return;
      listenGen += 1;
      var listenTicket = listenGen;
      if (liveReader) { try { liveReader.cancel(); } catch (e) {} liveReader = null; }
      listen(ticket, listenTicket);
    }

    function listen(ticket, listenTicket) {
      if (!s || ticket !== s.gen || listenTicket !== listenGen) return;
      fetch(base + "/v1/session/" + encodeURIComponent(s.id) + "/events", {
        credentials: "omit", cache: "no-store",
        headers: { "authorization": "Bearer " + s.token, "accept": "text/event-stream", "Last-Event-ID": String(lastSeq) }
      }).then(function (r) {
        if (!s || ticket !== s.gen || listenTicket !== listenGen) return "stop";
        if (r.status === 404 || r.status === 410 || r.status === 401) return "stop";
        if (!r.ok || !r.body || !r.body.getReader) return "retry";
        var reader = r.body.getReader(), decoder = new TextDecoder(), buffer = "";
        liveReader = reader;
        function pull() {
          return reader.read().then(function (part) {
            if (!s || ticket !== s.gen || listenTicket !== listenGen) { try { reader.cancel(); } catch (e) {} return "stop"; }
            if (part.done) { frames(buffer + decoder.decode() + "\n\n", ticket); return "again"; }
            buffer = frames(buffer + decoder.decode(part.value, { stream: true }), ticket);
            return pull();
          });
        }
        return pull();
      }).catch(function () { return "retry"; }).then(function (why) {
        if (!s || ticket !== s.gen || listenTicket !== listenGen || why === "stop") return;
        setTimeout(function () {
          if (!s || ticket !== s.gen || listenTicket !== listenGen) return;
          listen(ticket, listenTicket);
        }, why === "again" ? 300 : 2000);
      });
    }

    /* --- commands: one in flight; what is said meanwhile waits and is sent together --- */
    function send(command, ticket, tries) {
      command.session_id = s.id;
      command.expected_version = version;
      s.busy = true;
      working("builder", true);
      if (command.type === "utterance") status.textContent = "Building";
      return post("/v1/session/" + encodeURIComponent(s.id) + "/commands", command).then(function (r) {
        if (!s || ticket !== s.gen) return;
        if (r.status === 200) {
          (r.body.events || []).forEach(apply);
          if (status.textContent === "Building") status.textContent = "";
        } else if (r.status === 409 && tries < 4) {
          // Another command or a newer version: take the version the stream
          // has reached and try the same command again.
          command.command_id = "cmd-" + randomHex(8);
          return new Promise(function (resolve) { setTimeout(resolve, 900); })
            .then(function () { if (s && ticket === s.gen) return send(command, ticket, tries + 1); });
        } else if (r.status === 410) {
          status.textContent = "This conversation has ended.";
        } else {
          status.textContent = "That change could not be built. Say it another way.";
        }
      }).catch(function () {
        if (s && ticket === s.gen) status.textContent = "That change could not be built. Say it another way.";
      }).then(function () {
        if (!s || ticket !== s.gen) return;
        s.busy = false;
        working("builder", false);
        drain(ticket);
      });
    }

    function drain(ticket) {
      if (!s || s.busy || !s.pending.length) return;
      var items = s.pending.splice(0, s.pending.length);
      var text = items.map(function (i) { return i.text; }).join(" ").slice(0, 600);
      send({ command_id: "cmd-" + randomHex(8), type: "utterance", transcript: text,
             item_id: items[items.length - 1].item_id }, ticket, 0);
    }

    function answer(question, option, batch) {
      if (!s) return;
      var ticket = s.gen;
      if (batch) {
        s.picks[question.question_id] = option.option_id;
        var all = batch.questions.every(function (q) { return has(s.picks, q.question_id); });
        if (!all || s.busy) return;
        var answers = batch.questions.map(function (q) { return { question_id: q.question_id, option_id: s.picks[q.question_id] }; });
        s.picks = {};
        ask.hidden = true;
        send({ command_id: "cmd-" + randomHex(8), type: "answer_batch", batch_id: batch.batch_id,
               answers: answers, answer_source: "tap" }, ticket, 0);
        return;
      }
      if (s.busy) return;
      ask.hidden = true;
      send({ command_id: "cmd-" + randomHex(8), type: "answer", question_id: question.question_id,
             option_id: option.option_id, answer_source: "tap" }, ticket, 0);
    }

    function showQuestions(batch, questions) {
      ask.textContent = "";
      if (s) s.picks = {};
      if (batch && batch.title) ask.appendChild(el("p", { "class": "pc-ask-title" }, String(batch.title)));
      questions.forEach(function (q) {
        var box = el("div", { "class": "pc-q", "data-pc-question": String(q.question_id || "") });
        box.appendChild(el("p", { "class": "pc-q-prompt" }, String(q.prompt || "")));
        var row = el("div", { "class": "pc-q-options" });
        (q.options || []).forEach(function (o) {
          var b = el("button", { type: "button", "class": "pc-opt", "data-pc-option": String(o.option_id || "") });
          b.appendChild(el("b", {}, String(o.label || "")));
          if (o.consequence) b.appendChild(el("span", {}, String(o.consequence)));
          b.addEventListener("click", function () {
            Array.prototype.forEach.call(row.children, function (x) { x.removeAttribute("aria-pressed"); });
            b.setAttribute("aria-pressed", "true");
            reward(b);
            answer(q, o, batch);
          });
          row.appendChild(b);
        });
        box.appendChild(row);
        ask.appendChild(box);
      });
      ask.hidden = false;
      attention(ask);
    }

    /* --- rendering --- */
    function mark(node, n) {
      n.setAttribute("data-pc-id", node.id);
      n.setAttribute("data-pc-kind", node.kind);
      if (fresh[node.id]) n.classList.add("pc-enter");
      else if (changed[node.id]) n.classList.add("pc-changed");
      return n;
    }

    function renderNode(node, used) {
      var k = node.kind, label = String(node.label || ""), detail = String(node.detail || ""), n;
      if (k === "scene") {
        if (!parseScene(detail)) {
          if (sceneEngines[node.id]) { sceneEngines[node.id].destroy(); delete sceneEngines[node.id]; }
          return null;
        }
        var eng = sceneEngines[node.id];
        if (eng) eng.update(node); else eng = sceneEngines[node.id] = new Engine(node);
        used[node.id] = true;
        n = el("figure", { "class": "pc-scene-wrap" });
        n.appendChild(eng.canvas);
        return mark(node, n);
      }
      if (k === "entity") return null;
      if (k === "heading") n = el("h4", { "class": "pc-heading" }, label);
      else if (k === "text") n = el("p", { "class": "pc-text" }, label);
      else if (k === "button") {
        n = el("button", { type: "button", "class": "pc-button" }, label);
        n.addEventListener("click", function () {
          n.classList.remove("pc-pressed"); void n.offsetWidth; n.classList.add("pc-pressed");
        });
      } else if (k === "field") {
        n = el("label", { "class": "pc-field" });
        n.appendChild(el("span", {}, label));
        var input = el("input", { type: "text", placeholder: detail, "aria-label": label });
        n.appendChild(input);
      } else if (k === "image-placeholder") {
        // The builder describes what the picture shows; the owner's run had it
        // in detail and the canvas showed only the label.
        n = el("div", { "class": "pc-image" }, label);
        if (detail) n.appendChild(el("small", {}, detail));
      } else if (k === "process-step") {
        // A step's description is its content (137-180 characters in the
        // owner's 2026-09-26 run), not metadata: show it under the title.
        n = el("div", { "class": "pc-step" });
        n.appendChild(el("strong", {}, label));
        if (detail) n.appendChild(el("p", {}, detail));
      }
      else if (k === "edge") n = el("div", { "class": "pc-edge" }, label + (detail ? " - " + detail : ""));
      else if (k === "form") {
        n = el("form", { "class": "pc-form" });
        n.addEventListener("submit", function (ev) { ev.preventDefault(); });
        if (label) n.appendChild(el("p", { "class": "pc-form-title" }, label));
      } else if (k === "list") {
        n = el("ul", { "class": "pc-list" });
      } else if (k === "card") {
        n = el("div", { "class": "pc-card" });
        if (label) n.appendChild(el("strong", {}, label));
        if (detail) n.appendChild(el("p", {}, detail));
      } else if (k === "nav") {
        n = el("nav", { "class": "pc-nav", "aria-label": label || "Navigation" });
        n.appendChild(el("strong", {}, label));
      } else {
        n = el("section", { "class": "pc-section" });
        if (label && k !== "screen") n.setAttribute("aria-label", label);
      }
      if (has(CONTAINERS, k)) {
        (node.children || []).forEach(function (c) {
          var child = renderNode(c, used);
          if (!child) return;
          if (k === "list") { var li = el("li", {}); li.appendChild(child); n.appendChild(li); }
          else n.appendChild(child);
        });
      }
      return mark(node, n);
    }

    function render() {
      if (!tree) return;
      var kept = {};
      Array.prototype.forEach.call(stage.querySelectorAll("[data-pc-kind=field]"), function (f) {
        var input = f.querySelector("input");
        if (input && input.value) kept[f.getAttribute("data-pc-id")] = input.value;
      });
      var used = {};
      stage.textContent = "";
      title.textContent = String(tree.label || "");
      (tree.children || []).forEach(function (c) { var n = renderNode(c, used); if (n) stage.appendChild(n); });
      for (var id in sceneEngines) {
        if (has(sceneEngines, id) && !used[id]) { sceneEngines[id].destroy(); delete sceneEngines[id]; }
      }
      for (var fid in kept) {
        var f = stage.querySelector('[data-pc-id="' + fid.replace(/["\\]/g, "") + '"] input');
        if (f) f.value = kept[fid];
      }
      fresh = {}; changed = {};
      root.hidden = !(tree.children || []).length && !title.textContent;
      if ((tree.children || []).length) starters.hidden = true;
      if (!musePane.hidden || (s && !starters.hidden)) root.hidden = false;
    }

    function reset() {
      for (var id in sceneEngines) if (has(sceneEngines, id)) sceneEngines[id].destroy();
      sceneEngines = {};
      if (modelView) { modelView.destroy(); if (modelView.canvas.parentNode) modelView.canvas.parentNode.removeChild(modelView.canvas); }
      modelView = null; modelPane.hidden = true; findings.textContent = "";
      chip.analyst.hidden = true; chip.builder.removeAttribute("data-working"); chip.analyst.removeAttribute("data-working");
      tree = null; lastSeq = 0; version = 1; generation = 0; held = {};
      clearGap();
      listenGen += 1;
      if (liveReader) { try { liveReader.cancel(); } catch (e) {} liveReader = null; }
      stage.textContent = ""; title.textContent = ""; status.textContent = "";
      ask.hidden = true; ask.textContent = "";
      musePane.hidden = true; musePane.textContent = "";
      chip.muse.hidden = true; chip.muse.removeAttribute("data-working");
      dropAdvice();
      chip.advisor.hidden = true; chip.advisor.removeAttribute("data-working");
      if (adviceTimer) { clearTimeout(adviceTimer); adviceTimer = null; }
      inspireButton.hidden = true; starters.hidden = true;
    }

    return {
      open: function (session) {
        reset();
        gen += 1;
        s = { gen: gen, id: String(session.id), token: String(session.token), busy: false, pending: [], picks: {},
              analyst: session.analyst !== false, analyzing: false, toAnalyze: [],
              muse: !!session.muse, hear: !!session.hear, inspiring: false, inspired: false, inspireTurn: 0, lastText: "",
              autoMuse: has(CREATIVE, String(session.topic || "")),
              advisor: !!session.advisor, advising: false };
        fillStarters(String(session.topic || ""));
        inspireButton.hidden = !s.muse;
        starters.hidden = false;
        version = typeof session.version === "number" ? session.version : 1;
        generation = typeof session.generation === "number" ? session.generation : 0;
        root.hidden = false;
        status.textContent = "Say what you want to build.";
        listenGen += 1;
        listen(s.gen, listenGen);
      },
      heard: function (text, itemId) {
        if (!s || !text) return;
        queue(String(text), String(itemId));
      },
      /* For the host's facilitator: is another agent about to speak (a build in
         flight or queued, the creative thinking), or a question waiting? */
      busy: function () { return !!s && (!!s.busy || s.pending.length > 0 || !!s.inspiring); },
      asking: function () { return !!s && !ask.hidden && !!ask.querySelector("button:not([disabled])"); },
      /* The final design as a PNG data URL (the first running scene), or "". */
      snapshot: function () {
        for (var id in sceneEngines) {
          if (!has(sceneEngines, id) || sceneEngines[id].invalid) continue;
          try { return sceneEngines[id].canvas.toDataURL("image/png"); } catch (e) { return ""; }
        }
        return "";
      },
      close: function () {
        s = null; gen += 1;
        // The last Muse set stays on screen with the design; its buttons and
        // the templates go quiet with the conversation.
        Array.prototype.forEach.call(musePane.querySelectorAll("button"), function (b) { b.disabled = true; });
        Array.prototype.forEach.call(advicePane.querySelectorAll("button"), function (b) { b.disabled = true; });
        if (adviceTimer) { clearTimeout(adviceTimer); adviceTimer = null; }
        inspireButton.hidden = true; starters.hidden = true;
        clearGap();
        listenGen += 1;
        if (liveReader) { try { liveReader.cancel(); } catch (e) {} liveReader = null; }
        if (status.textContent === "Building") status.textContent = "";
      }
    };
  }

  window.SFDC24Canvas = { create: create, parseEntity: parseEntity, parseScene: parseScene };
})();
