const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const [question, expected] of [
  ['What have you actually built?', 'session-only tally, not a fitted model'],
  ['What does this site do?', 'Local rules answer'],
  ["What's next?", 'This release describes shipped work'],
  ['roadmap', 'This release describes shipped work'],
  ['Does ProductItem have a SerialNumber field?', 'Yes. ProductItem has a standard SerialNumber field.'],
  ['What object holds on-hand serial numbers?', 'V1 can use ProductItem.SerialNumber'],
  ['What is the difference between Product2 and SerializedProduct?', 'Product2 is the catalogue entry'],
]) {
  test(`public FAQ answers locally with no model request: ${question}`, async ({page}) => {
    const modelRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('action') === 'say') modelRequests.push(url.searchParams.get('action'));
      if (url.origin !== 'https://site.test') return route.abort();
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
      const types = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json'};
      return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)] || 'text/plain'});
    });
    await page.goto('https://site.test/');
    await page.waitForFunction(() => !!window.__TRIAGE);
    await page.locator('#box').fill(question);
    await page.locator('#box').press('Enter');
    const reply = page.locator('#tape .turn.it').last();
    await expect(reply.locator('.who')).toHaveText('python');
    await expect(reply.locator('.said')).toContainText(expected);
    if (expected.includes('shipped work')) {
      await expect(page.locator('#nextDeploy b')).toHaveText('This release');
      await expect(reply.locator('.said')).not.toContainText('next ship');
    }
    await expect(page.locator('#recovery')).toHaveCount(0);
    expect(modelRequests).toEqual([]);
  });
}

// Real homepage and generated triage; synthetic backend, no paid model calls.
for (const [question, expectedHint, answerer] of [
  ['How should a sales operations team prioritize its first Salesforce automation?', 'claude', 'claude'],
  ['Can you help me set up Salesforce?', 'claude', 'grok'],
  ['What should our Salesforce pricing strategy be?', 'grok', 'grok'],
  ['How do I serialize Product2 to JSON in Apex?', 'claude', 'claude'],
  ['Does ProductItem have a SerialNumber field? Also explain Apex permissions.', 'claude', 'claude'],
]) {
  test(`routed question uses the intended hint and credits the actual answerer: ${question}`, async ({page}) => {
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('action') === 'say') {
        calls.push({agent:url.searchParams.get('agent'), question:url.searchParams.get('q')});
        const callback = url.searchParams.get('cb');
        expect(callback).toMatch(/^sfdch[0-9a-z]+$/);
        return route.fulfill({contentType:'application/javascript', body:
          `${callback}(${JSON.stringify({ok:true,reply:'Start with one bounded workflow and measure its outcome.',by:answerer})});`});
      }
      if (url.origin !== 'https://site.test') return route.abort();
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
      const types = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json'};
      return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)] || 'text/plain'});
    });
    await page.goto('https://site.test/');
    await page.waitForFunction(() => !!window.__TRIAGE);
    await page.locator('#box').fill(question);
    await page.locator('#box').press('Enter');
    const reply = page.locator('#tape .turn.it').last();
    await expect(reply.locator('.who')).toHaveText(answerer);
    await expect(reply.locator('.said')).toContainText('Start with one bounded workflow');
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe(expectedHint);
    expect(calls[0].question).toContain(question);
    await expect(page.locator('#recovery')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
