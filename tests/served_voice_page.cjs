/*
  THE VOICE PAGE THIS REPOSITORY SERVES.

  WHY THIS FILE EXISTS, AND IT IS NOT A HYPOTHETICAL
    There are TWO voice/index.html files.

      sfdc24-site/voice/index.html        <- published to www.sfdc24.com
      Blackboard/site/voice/index.html    <- what the tenant-boundary suite reads

    On 2026-09-23 the Governor endpoint moved to a signed conversation identity.
    Before shipping it I checked whether the voice page carried the token, saw
    `ct:CONVERSATION`, and shipped. I had grepped the Blackboard copy. The page
    actually being served still sent `vid`, so for the window between that
    deploy and this commit the live voice page opened a BRAND NEW conversation
    on every turn: no history, and a per-conversation cap that could never bind.

    test_governor_tenant_boundary.cjs was 12/12 throughout. It was reading a
    file nobody serves - the same defect as the nine suites that could not open
    the Apps Script source, wearing different clothes.

    So the assertion belongs HERE, in the repository that publishes the page.
    A suite in another repository cannot guard this one.
*/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const VOICE = fs.readFileSync(path.join(REPO, 'voice/index.html'), 'utf8');

test('the served voice page sends the signed conversation token', () => {
  assert.match(VOICE, /action:"say", ct:CONVERSATION/,
    'the say call does not carry ct - every turn will start a new conversation');
});

test('it adopts the token the server returns, on every branch', () => {
  // A refusal still carries a usable token. Reading it only on the ok path
  // means a single refused turn silently starts a new thread.
  assert.match(VOICE, /if \(res && res\.ct\)/,
    'res.ct is not read back');
  assert.match(VOICE, /localStorage\.setItem\("sfdc_conv"/,
    'the token is not persisted, so it dies with the page');
  const callAt = VOICE.indexOf('action:"say"');
  const adoptAt = VOICE.indexOf('if (res && res.ct)');
  const okCheck = VOICE.indexOf('if (!res || !res.ok)', callAt);
  assert.ok(adoptAt > callAt && adoptAt < okCheck,
    'the token must be adopted BEFORE the ok check, or a refusal loses the thread');
});

test('it does not mint its own conversation id', () => {
  // vid stays - it is this page's own label, not the endpoint's key. What must
  // not come back is a locally invented value standing in for the identity.
  assert.doesNotMatch(VOICE, /CONVERSATION\s*=\s*"[cv]?"?\s*\+\s*Date\.now/,
    'the page is inventing a conversation id instead of carrying the signed one');
});

test('the microphone is on a top-level page, not an iframe', () => {
  // An iframed mic can never work: the permissions policy is withheld by the
  // embedding frame, and no amount of retrying changes that. This page exists
  // at www.sfdc24.com/voice/ precisely so it is top-level.
  assert.doesNotMatch(VOICE, /<iframe[^>]*allow=["'][^"']*microphone/i,
    'a nested frame is being granted the microphone - that path does not work');
});

test('the two copies are known to differ, and this one is the published one', () => {
  // Not an equality check: the Blackboard copy is a different generation and
  // making them identical is not the goal. The goal is that nobody edits that
  // one believing it reaches a visitor.
  assert.ok(VOICE.includes('action:"say"'),
    'this file no longer looks like the voice page - has it moved?');
  assert.ok(fs.existsSync(path.join(REPO, 'voice/index.html')),
    'voice/index.html is what GitHub Pages publishes at /voice/');
});
