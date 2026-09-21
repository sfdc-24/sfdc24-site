const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const question of ['What have you actually built?', 'What does this site do?']) {
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
    await expect(reply.locator('.said')).toContainText(question.includes('built') ? 'session-only tally, not a fitted model' : 'Local rules answer');
    await expect(page.locator('#recovery')).toHaveCount(0);
    expect(modelRequests).toEqual([]);
  });
}
