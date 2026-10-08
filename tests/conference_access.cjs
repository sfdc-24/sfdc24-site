const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const access = require("../conference/access.js");
const pagePath = path.join(root, "conference", "index.html");
const configPath = path.join(root, "conference", "access-config.js");
const scriptPath = path.join(root, "conference", "access.js");
const fixturePath = path.join(root, "tests", "fixtures", "conference_brochure_visible.txt");

const VENDOR = ["Claudia", "Grok", "Gemini", "Codex", "Cursor", "Copilot", "OpenAI", "Anthropic", "ChatGPT", "Deepgram", "LiveKit", "xAI"];

function words(count) {
  return Array.from({ length: count }, (_, i) => "w" + (i + 1)).join(" ");
}

function loadConfig() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(configPath, "utf8"), sandbox);
  return sandbox.window.SFDC24_CONFERENCE_ACCESS;
}

class El {
  constructor(id) {
    this.id = id;
    this._hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.attrs = {};
    this.listeners = {};
  }
  get hidden() { return this._hidden; }
  set hidden(value) {
    this._hidden = Boolean(value);
    if (this._hidden) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === "hidden") this._hidden = true;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  removeAttribute(name) {
    delete this.attrs[name];
    if (name === "hidden") this._hidden = false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }
  dispatch(type) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
}

function dom() {
  const els = {
    "conference-access": new El("conference-access"),
    "conference-access-form": new El("conference-access-form"),
    "access-email": new El("access-email"),
    "access-name": new El("access-name"),
    "access-use-case": new El("access-use-case"),
    "access-use-case-count": new El("access-use-case-count"),
    "access-use-case-error": new El("access-use-case-error"),
    "fax_number": new El("fax_number"),
    "access-submit": new El("access-submit"),
    "access-status": new El("access-status"),
    "access-gateway-link": new El("access-gateway-link")
  };
  els["conference-access"].hidden = true;
  els["access-use-case-error"].hidden = true;
  els["access-submit"].disabled = true;
  return {
    els,
    getElementById(id) { return els[id] || null; }
  };
}

function stripUnrendered(html) {
  const HIDDEN = /^<([a-z][\w-]*)\b[^>]*?(?:\shidden(?=[\s/>])|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*display\s*:\s*none)/i;
  let out = "";
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") { out += html[i++]; continue; }
    const gt = html.indexOf(">", i);
    if (gt < 0) { out += html.slice(i); break; }
    const tag = html.slice(i, gt + 1);
    const match = tag.match(HIDDEN);
    if (!match || tag.endsWith("/>")) { out += tag; i = gt + 1; continue; }
    const name = match[1].toLowerCase();
    const open = new RegExp(`<${name}\\b`, "ig");
    const close = new RegExp(`</${name}\\s*>`, "ig");
    let depth = 1;
    let cursor = gt + 1;
    while (depth > 0 && cursor < html.length) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const opened = open.exec(html);
      const closed = close.exec(html);
      if (!closed) { cursor = html.length; break; }
      if (opened && opened.index < closed.index) { depth += 1; cursor = opened.index + 1; }
      else { depth -= 1; cursor = closed.index + closed[0].length; }
    }
    i = cursor;
  }
  return out;
}

function visible(html) {
  return stripUnrendered(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("19 words is allowed and 20 or more, or a blank use case, is blocked", () => {
  const nineteen = words(19);
  const twenty = words(20);
  assert.equal(access.wordCount(nineteen), 19);
  assert.equal(access.useCaseState(nineteen).ok, true);
  assert.equal(access.counterText(19), "19 words. Fewer than 20.");
  assert.equal(access.canSubmit({ email: "a@b.co", name: "", use_case: nineteen, fax_number: "" }).ok, true);

  for (const value of [twenty, words(21), nineteen + " extra"]) {
    const state = access.useCaseState(value);
    assert.equal(state.ok, false);
    assert.equal(state.reason, "over");
    assert.ok(state.count >= 20);
    const decision = access.canSubmit({ email: "a@b.co", use_case: value, fax_number: "" });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "over");
  }
  assert.equal(access.OVER_LIMIT, "Over the limit. Use fewer than 20 words.");

  for (const blank of ["", "   ", "\n\t  "]) {
    const state = access.useCaseState(blank);
    assert.equal(state.ok, false);
    assert.equal(state.reason, "blank");
    assert.equal(state.count, 0);
    const decision = access.canSubmit({ email: "a@b.co", use_case: blank, fax_number: "" });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "blank");
  }
  assert.match(access.counterText(0), /Add a use case before sending/);
});

test("a filled fax_number honeypot blocks the post and an empty one is sent", async () => {
  const cfg = {
    enabled: true,
    requestUrl: "https://access.invalid/api/conference/access/request",
    gatewaySignInUrl: "https://gateway.invalid/sign-in"
  };
  const page = dom();
  const calls = [];
  page.els["access-email"].value = "visitor@example.invalid";
  page.els["access-name"].value = "Ada";
  page.els["access-use-case"].value = words(19);
  page.els["fax_number"].value = "555-0100";
  const mounted = access.mount(page, cfg, (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, status: 202 });
  });
  assert.equal(mounted.shown, true);
  assert.equal(page.els["conference-access"].hidden, false);
  assert.equal(page.els["access-gateway-link"].getAttribute("href"), cfg.gatewaySignInUrl);

  const blocked = page.els["conference-access-form"].dispatch("submit");
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(calls.length, 0);
  assert.equal(access.canSubmit({
    email: "visitor@example.invalid",
    use_case: words(19),
    fax_number: " "
  }).reason, "honeypot");

  page.els["fax_number"].value = "";
  page.els["conference-access-form"].dispatch("submit");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, cfg.requestUrl);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    email: "visitor@example.invalid",
    name: "Ada",
    use_case: words(19),
    fax_number: ""
  });
  assert.equal(page.els["access-status"].textContent, access.SENT);
});

test("the live counter blocks 20 words and a blank use case in the form", () => {
  const cfg = {
    enabled: true,
    requestUrl: "https://access.invalid/api/conference/access/request",
    gatewaySignInUrl: "https://gateway.invalid/sign-in"
  };
  const page = dom();
  access.mount(page, cfg, () => Promise.resolve({ ok: true }));
  const useCase = page.els["access-use-case"];
  const count = page.els["access-use-case-count"];
  const error = page.els["access-use-case-error"];
  const button = page.els["access-submit"];
  page.els["access-email"].value = "visitor@example.invalid";
  page.els["access-email"].dispatch("input");

  useCase.value = words(19);
  useCase.dispatch("input");
  assert.equal(count.textContent, "19 words. Fewer than 20.");
  assert.equal(error.hidden, true);
  assert.equal(button.disabled, false);
  assert.equal(useCase.getAttribute("aria-invalid"), null);

  useCase.value = words(20);
  useCase.dispatch("input");
  assert.equal(count.textContent, "20 words.");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, access.OVER_LIMIT);
  assert.equal(button.disabled, true);
  assert.equal(useCase.getAttribute("aria-invalid"), "true");

  useCase.value = "   ";
  useCase.dispatch("input");
  assert.equal(count.textContent, access.BLANK_MESSAGE);
  assert.equal(error.hidden, true);
  assert.equal(button.disabled, true);

  page.els["conference-access-form"].dispatch("submit");
  assert.equal(page.els["access-status"].textContent, "Add a use case before sending.");
});

test("with the flag off the brochure text is unchanged and the section stays hidden", () => {
  const html = fs.readFileSync(pagePath, "utf8");
  const cfg = loadConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.requestUrl, "https://access.invalid/api/conference/access/request");
  assert.equal(cfg.gatewaySignInUrl, "https://gateway.invalid/sign-in");

  const section = html.match(/<section class="card" id="conference-access"[^>]*>/);
  assert.ok(section, "request section missing");
  assert.match(section[0], /\shidden[\s>]/);
  assert.match(html, /name="fax_number"/);
  assert.match(html, /id="fax_number"/);
  assert.doesNotMatch(html, /access\.invalid|gateway\.invalid|\/api\/conference\/access\/request/);
  assert.doesNotMatch(fs.readFileSync(scriptPath, "utf8"), /\/api\/conference\/access\/request/);
  assert.match(html, /<script src="\/conference\/access-config\.js"><\/script>\s*<script src="\/conference\/access\.js"><\/script>/);

  assert.match(html, /Request access/);
  assert.match(html, /Claude chairs the line/);
  const shown = visible(html);
  assert.equal(shown, fs.readFileSync(fixturePath, "utf8").trim());
  assert.doesNotMatch(shown, /Request access|fax number|Use fewer than 20 words/i);

  const page = dom();
  const calls = [];
  const result = access.mount(page, cfg, (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true });
  });
  assert.equal(result.shown, false);
  assert.equal(page.els["conference-access"].hidden, true);
  page.els["access-email"].value = "visitor@example.invalid";
  page.els["access-use-case"].value = words(19);
  page.els["conference-access-form"].dispatch("submit");
  assert.equal(calls.length, 0);
  assert.equal(page.els["access-gateway-link"].getAttribute("href"), null);
});

test("public conference copy uses persona names only", () => {
  const files = [pagePath, configPath, scriptPath];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of VENDOR) {
      assert.equal(text.includes(name), false, `${path.basename(file)} names ${name}`);
    }
  }
  assert.match(fs.readFileSync(pagePath, "utf8"), /Claude chairs the line/);
});

test("a rejected response does not claim the request was sent", async () => {
  const page = dom();
  access.mount(page, {
    enabled: true,
    requestUrl: "https://access.invalid/api/conference/access/request",
    gatewaySignInUrl: "https://gateway.invalid/sign-in"
  }, () => Promise.resolve({ ok: false, status: 400 }));
  page.els["access-email"].value = "visitor@example.invalid";
  page.els["access-use-case"].value = words(3);
  page.els["fax_number"].value = "";
  page.els["conference-access-form"].dispatch("submit");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.els["access-status"].textContent, access.NOT_SENT);
  assert.doesNotMatch(page.els["access-status"].textContent, /Request sent/);
});
