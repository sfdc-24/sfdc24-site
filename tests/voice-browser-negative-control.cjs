const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Mutate disposable copies only. The checked-out page is never rewritten.
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'voice/index.html'));
const spec = fs.readFileSync(path.join(__dirname, 'voice-browser.spec.cjs'));
const parent = path.join(root, 'test-results');
fs.mkdirSync(parent, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(parent, 'voice-control-'));
const cli = require.resolve('@playwright/test/cli');
const results = [];

function run(name, html, grep, expectedCount, expectedFailed) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(path.join(dir, 'voice'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'voice/index.html'), html);
  fs.writeFileSync(path.join(dir, 'tests/voice-browser.spec.cjs'), spec);
  const config = path.join(dir, 'playwright.config.cjs');
  fs.writeFileSync(config, `module.exports = {
    ...require(${JSON.stringify(path.join(root, 'playwright.config.cjs'))}),
    testDir: ${JSON.stringify(path.join(dir, 'tests'))},
    outputDir: ${JSON.stringify(path.join(dir, 'artifacts'))},
    retries: 0, workers: 1, expect: { timeout: 1500 }
  };`);
  const args = [cli, 'test', '--config', config, '--reporter=json'];
  if (grep) args.push('--grep', grep);
  const execution = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(execution.error);
  assert.equal(execution.signal, null, `${name}: interrupted browser run`);
  const report = JSON.parse(execution.stdout);
  assert.deepEqual(report.errors, [], `${name}: browser infrastructure failed`);
  const found = [];
  function visit(suite) {
    for (const item of suite.specs || []) {
      for (const test of item.tests) found.push({ title: item.title, test });
    }
    for (const child of suite.suites || []) visit(child);
  }
  report.suites.forEach(visit);
  assert.equal(found.length, expectedCount, `${name}: missing or additional tests`);
  for (const { title, test } of found) {
    assert.equal(test.expectedStatus, 'passed', `${name}: test marked as expected failure`);
    assert.equal(test.results.length, 1, `${name}: retries mask the result`);
    assert.equal(test.results[0].status, expectedFailed ? 'failed' : 'passed', `${name}: ${title}`);
    if (grep) assert.ok(title.includes(grep), `${name}: wrong failure`);
    if (expectedFailed) assert.match(test.results[0].error.message, /expect\(/, `${name}: not an assertion failure`);
  }
  assert.equal(execution.status, expectedFailed ? 1 : 0, `${name}: wrong exit`);
  results.push({ name, passed: expectedFailed ? 0 : found.length, failed: expectedFailed ? found.length : 0 });
  console.log(`${name}: ${expectedFailed ? 'caught' : 'passed'} ${found.length} browser cases`);
}

try {
  const original = source.toString('utf8');
  run('baseline', original, null, 12, false);
  for (const [name, before, after, grep] of [
    ['keyboard-guard-removed', '    if (mode === "thinking") return;', '',
      'Enter cannot submit a second request'],
    ['recognizer-abort-removed', 'if (stopped) stopped.abort()', 'if (stopped) { /* disabled by control */ }',
      'draft input aborts capture'],
    ['interim-cleanup-disabled', '  function clearInterim(){', '  function clearInterim(){ return;',
      'Stop clears interim text with delayed abort'],
  ]) {
    assert.equal(original.split(before).length, 2, `${name}: mutation anchor must occur exactly once`);
    run(name, original.replace(before, after), grep, 2, true);
  }
  assert.ok(fs.readFileSync(path.join(root, 'voice/index.html')).equals(source), 'source page changed');
  console.log(JSON.stringify({ baseline: 12, controlsCaught: 3, sourceUnchanged: true, results }));
} finally {
  // Verify the resolved target before recursive cleanup on Windows as well.
  const resolvedParent = fs.realpathSync(parent);
  const resolvedSandbox = fs.realpathSync(sandbox);
  assert.equal(path.dirname(resolvedSandbox), resolvedParent);
  assert.ok(path.basename(resolvedSandbox).startsWith('voice-control-'));
  fs.rmSync(resolvedSandbox, { recursive: true, force: true });
}
