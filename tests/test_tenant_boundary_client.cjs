const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const voice = fs.readFileSync(path.join(__dirname, '..', 'voice', 'index.html'), 'utf8');

test('voice persists and returns only the server-signed conversation token', () => {
  assert.match(voice, /var CONVERSATION = "";/);
  assert.match(voice, /localStorage\.getItem\("sfdc_conv"\)/);
  assert.match(voice, /action:"say", ct:CONVERSATION, q:text, s:TOKEN/);
  assert.match(voice, /if \(res && res\.ct\)[\s\S]*CONVERSATION = res\.ct;[\s\S]*localStorage\.setItem\("sfdc_conv", CONVERSATION\)/);
  const sendAt = voice.indexOf('jsonp({ action:"say", ct:CONVERSATION');
  const persistAt = voice.indexOf('CONVERSATION = res.ct;', sendAt);
  const resultGateAt = voice.indexOf('if (!res || !res.ok)', sendAt);
  assert.ok(sendAt >= 0 && persistAt > sendAt && resultGateAt > persistAt,
    'replacement ct must be retained even when the model branch degrades');
  assert.doesNotMatch(voice, /sfdc_vsid/);
  assert.doesNotMatch(voice, /action:"say", vid:/);
  assert.doesNotMatch(voice, /var vid\s*=/);
});

test('the companion patch does not change the production backend target', () => {
  assert.match(voice, /var EXEC = "https:\/\/script\.google\.com\/macros\/s\/AKfycbx0D-5DAnMqOm9YbN3iKDwuiBApEi_xex60f6pwdvObEyQBF5jcOK715pl1mN-Nzn6gng\/exec";/);
});
