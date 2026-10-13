// The release record is data/releases.json. This fails when that record
// renders blank: no live release, no next weekly date, no manifest summary,
// or no history.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const WEEK = 7 * 24 * 60 * 60 * 1000;
const DISCLAIMER = "sfdc24.com is an independent community resource for Salesforce customers, consultants and developers, run by Abdus Salam, a certified Salesforce Sales Cloud Consultant, with help from AI agents. It is not affiliated with, endorsed by, or sponsored by Salesforce, Inc., and does not represent or speak for Salesforce. Salesforce, Sales Cloud and related marks are trademarks of Salesforce, Inc.";

const releases = require("../assets/releases.js");
const data = JSON.parse(fs.readFileSync(path.join(REPO, "data/releases.json"), "utf8"));

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

function assertCommit(entry) {
  assert.match(entry.sha, /^[0-9a-f]{40}$/);
  git(["merge-base", "--is-ancestor", entry.sha, "HEAD"]);
  assert.equal(entry.title, git(["log", "-1", "--format=%s", entry.sha]));
  assert.equal(Date.parse(entry.date), Date.parse(git(["log", "-1", "--format=%cI", entry.sha])));
  if (entry.pr != null) assert.match(entry.title, new RegExp("#" + entry.pr + "\\b"));
}

function visible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("the committed release record is the live release and the next weekly target", () => {
  assert.equal(data.cadence, "weekly");
  assert.equal(String(data.current.version), String(data.current.pr));
  assertCommit(data.current);
  assert.equal(data.next.cadence, "weekly");
  assert.equal(Date.parse(data.next.date) - Date.parse(data.current.date), WEEK);
  assert.ok(String(data.next.summary).trim().length > 0);
  assert.ok(Array.isArray(data.history) && data.history.length > 0);
  for (const row of data.history) assertCommit(row);
});

test("the release page render includes the live release, next date, summary, and history", () => {
  const html = releases.renderReleasePage(data);
  const text = visible(html);
  assert.ok(text.length > 0, "release page rendered empty");
  assert.match(html, new RegExp(data.current.sha));
  assert.match(text, new RegExp(data.current.sha.slice(0, 7)));
  assert.match(text, new RegExp("#" + data.current.pr + "\\b"));
  assert.match(html, new RegExp(data.next.date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(text.includes(data.next.summary.trim()));
  for (const row of data.history) {
    assert.match(text, new RegExp(row.sha.slice(0, 7)));
  }
});

test("a blank release record throws instead of rendering an empty page", () => {
  const blank = [
    null,
    {},
    { ...data, current: null },
    { ...data, current: { ...data.current, sha: "" } },
    { ...data, current: { ...data.current, pr: "" } },
    { ...data, current: { ...data.current, date: "" } },
    { ...data, current: { ...data.current, title: "" } },
    { ...data, next: null },
    { ...data, next: { ...data.next, date: "" } },
    { ...data, next: { ...data.next, summary: "" } },
    { ...data, next: { ...data.next, summary: "   " } },
    { ...data, history: [] },
    { ...data, history: null },
    { ...data, history: [{ sha: "", title: "x", date: data.current.date }] },
  ];
  for (const bad of blank) {
    assert.throws(() => releases.renderReleasePage(bad), /empty/);
  }
});

test("the releases page keeps the disclaimer and paints the record into the mount", () => {
  const page = fs.readFileSync(path.join(REPO, "releases/index.html"), "utf8");
  const src = fs.readFileSync(path.join(REPO, "assets/releases.js"), "utf8");
  assert.ok(page.includes(DISCLAIMER));
  assert.match(visible(page), /automation|AI enablement/i);
  assert.match(page, /id="release-record"/);
  assert.match(page, /data-releases="\/data\/releases\.json"/);
  assert.match(page, /\/assets\/releases\.js/);
  assert.match(src, /innerHTML\s*=\s*html/);
  assert.match(src, /renderReleasePage/);

  const rendered = releases.renderReleasePage(data);
  const composed = page.replace(
    /<div id="release-record"[\s\S]*?<\/div>/,
    '<div id="release-record">' + rendered + "</div>",
  );
  const text = visible(composed);
  assert.ok(text.includes(DISCLAIMER));
  assert.match(text, new RegExp(data.current.sha.slice(0, 7)));
  assert.ok(text.includes(data.next.summary.trim()));
  assert.match(composed, new RegExp(data.next.date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /Release record loading/);
});
