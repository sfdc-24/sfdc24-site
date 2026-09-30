const test = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../assets/ops-ci.js');

test('CI rows keep verdict, name, and time, and drop the actor', () => {
  const html = ci.renderCi({
    workflow_runs: [{
      name: 'site-positioning-test',
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.com/sfdc-24/sfdc24-site/actions/runs/42',
      updated_at: '2026-09-29T04:46:09Z',
      actor: {login: 'hidden-person'},
      head_branch: 'main'
    }, {
      name: '<script>',
      conclusion: null,
      status: 'in_progress',
      html_url: 'https://evil.example/runs/1',
      updated_at: '2026-09-29T04:46:00Z'
    }]
  });
  assert.match(html, /success/);
  assert.match(html, /site-positioning-test/);
  assert.match(html, /actions\/runs\/42/);
  assert.match(html, /2026-09-29T04:46:09Z/);
  assert.match(html, /in_progress/);
  assert.match(html, /class="is-live"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /evil\.example|hidden-person|head_branch|@/i);
});

test('an empty or failed read is not a green check', () => {
  assert.match(ci.renderCi({}), /No CI run recorded/);
  assert.match(ci.renderCi({workflow_runs: []}), /not a green check/);
  assert.equal(ci.safeLink('https://github.com/sfdc-24/sfdc24-site/actions/runs/1'), 'https://github.com/sfdc-24/sfdc24-site/actions/runs/1');
  assert.equal(ci.safeLink('javascript:alert(1)'), '');
});

test('load writes the rows and a failed fetch stays honest', async () => {
  const host = {innerHTML: ''};
  const doc = {getElementById(id) { return id === 'ci-status-rows' ? host : null; }};
  await ci.load(doc, {fetch: async () => ({ok: true, text: async () => JSON.stringify({workflow_runs: [{name: 'python-offload', conclusion: 'failure', status: 'completed', html_url: 'https://github.com/sfdc-24/sfdc24-site/actions/runs/9', updated_at: '2026-09-29T00:00:00Z'}]})})});
  assert.match(host.innerHTML, /failure/);
  assert.match(host.innerHTML, /python-offload/);
  await ci.load(doc, {fetch: async () => { throw Error('offline'); }});
  assert.match(host.innerHTML, /CI status not loaded/);
  assert.doesNotMatch(host.innerHTML, /success/);
});
