// Privacy and terms describe what the site does. Two descriptions went stale
// after the homepage chat left the page (merged PR 383) and after the
// conference room began requiring the owner's Google sign-in.
//
// This file fails if those descriptions return, and if a link in either
// page no longer points at a page in this repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

function read(rel) {
  const file = path.join(REPO, rel);
  assert.ok(fs.existsSync(file), `${rel} is missing`);
  return fs.readFileSync(file, 'utf8');
}

const OBSOLETE = [
  'The chat on the home page',
  'What you type there is sent to a language model',
  'Greg or Claude',
  'Signing in is optional',
  'nothing on the site requires it',
  'used to know who wrote a message',
  'your email address, your name and your Google account identifier',
  'The chat is not advice',
  'The assistant on the home page',
  'chat window',
  'The chat is rate limited',
  'What you write in the chat',
  'what the chat on the site is and is not',
];

function hrefs(html) {
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
}

function resolves(fromRel, href) {
  if (href.startsWith('mailto:')) {
    assert.equal(href, 'mailto:abdus@sfdc24.com', `${fromRel} mailto changed: ${href}`);
    return;
  }
  if (/^https?:\/\//.test(href)) {
    assert.match(href, /^https:\/\/www\.linkedin\.com\/in\/salams$/, `${fromRel} unexpected external link ${href}`);
    return;
  }
  const clean = href.split('#')[0].split('?')[0];
  assert.notEqual(clean, '', `${fromRel} has an empty link`);
  const base = path.dirname(path.join(REPO, fromRel));
  let target = clean.startsWith('/')
    ? path.join(REPO, clean)
    : path.resolve(base, clean);
  if (clean.endsWith('/') || !path.extname(target)) {
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) target = index;
  }
  assert.ok(fs.existsSync(target), `${fromRel} link ${href} does not resolve (${target})`);
}

test('privacy and terms no longer describe the removed homepage chat or an optional sign-in', () => {
  const privacy = read('privacy/index.html');
  const terms = read('terms/index.html');
  for (const page of [privacy, terms]) {
    for (const phrase of OBSOLETE) {
      assert.equal(page.includes(phrase), false, `obsolete phrase still present: ${phrase}`);
    }
  }

  assert.match(privacy, /The home page does not show a chat\./);
  assert.match(privacy, /Other pages can show an ask field\./);
  assert.match(privacy, /no model call/);
  assert.match(privacy, /reception endpoint/);
  assert.match(privacy, /Please do not paste anything confidential/);
  assert.match(privacy, /href="\/conference\/"/);
  assert.match(privacy, /the owner joins the room with Google sign-in/i);
  assert.match(privacy, /There is no public join on that page\./);
  assert.match(privacy, /Guest access is by invitation only, once the owner approves\./);
  assert.match(privacy, /Sign-in is not used for marketing, not sold, and not shared with anyone\./);
  assert.match(privacy, /stored in this business&rsquo;s own Google Workspace account/);
  assert.match(privacy, /A reply, when one is shown, names who wrote it\./);
  assert.match(privacy, /href="\/stream\/"/);
  assert.match(privacy, /href="\/stats\/"/);
  assert.match(privacy, /Question text still goes to the reception endpoint described above when a question is sent\./);
  assert.match(privacy, /href="mailto:abdus@sfdc24\.com"/);

  assert.match(terms, /sfdc24\.com has notes on assessment, automation and AI enablement/);
  assert.match(terms, /The home page does not offer a chat\./);
  assert.match(terms, /not professional advice/);
  assert.match(terms, /production Salesforce org/);
  assert.match(terms, /Paid work is agreed separately, in writing\./);
  assert.match(terms, /Please do not automate requests against the ask field/);
  assert.match(terms, /What you write in a question stays yours\./);
  assert.match(terms, /href="\.\.\/privacy\/"/);
  assert.match(terms, /href="mailto:abdus@sfdc24\.com"/);
});

test('privacy and terms links still point at pages in this repository', () => {
  for (const rel of ['privacy/index.html', 'terms/index.html']) {
    const links = hrefs(read(rel));
    assert.ok(links.length > 0, `${rel} has no links`);
    for (const href of links) resolves(rel, href);
  }
});

test('the legal copy stays tied to the homepage and the conference room', () => {
  const home = read('index.html');
  assert.match(home, /<div class="seek" hidden>/, 'homepage ask field is visible again; privacy and terms would be stale');
  assert.doesNotMatch(home, /id="voice-conversation"/, 'homepage voice chat returned; privacy and terms would be stale');
  assert.doesNotMatch(home, /Salesforce Design and Training Studio[\s\S]{0,400}chat window/);

  const chrome = read('assets/chrome.js');
  assert.match(chrome, /id="chrome-ask"/, 'non-home ask field is gone; the privacy page would overclaim');
  assert.match(chrome, /\/\?ask=/);

  const conference = read('conference/index.html');
  assert.match(conference, /Google sign-in, owner only/);
  assert.match(conference, /there is no public join/);
  assert.match(conference, /Guest access is by invitation only, once the owner approves|Guests: by invitation only, once the owner approves/);
});
