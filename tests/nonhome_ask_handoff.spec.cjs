// Real navigation and homepage submit; all external traffic intercepted.
// HANDOFF_SITE_URL permits the same acceptance test against published bytes.
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.env.HANDOFF_SOURCE_ROOT
  ? path.resolve(process.env.HANDOFF_SOURCE_ROOT) : path.resolve(__dirname, '..');
let server, origin;
test.beforeAll(async () => {
  if (process.env.HANDOFF_SITE_URL) {
    origin = new URL(process.env.HANDOFF_SITE_URL).origin;
    return;
  }
  server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function guard(page) {
  const asks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    const cb = url.searchParams.get('cb');
    const action = url.searchParams.get('action');
    if (action === 'say' && url.searchParams.has('q')) asks.push(Object.fromEntries(url.searchParams));
    const reply = { ok: true, reply: 'Synthetic handoff response.', by: 'claude', ct: 'synthetic-handoff-token', rows: [] };
    const body = cb && /^[A-Za-z_$][\w$]*$/.test(cb)
      ? `if(typeof ${cb}==='function') ${cb}(${JSON.stringify(reply)});`
      : JSON.stringify(reply);
    return route.fulfill({ status: 200, contentType: cb ? 'application/javascript' : 'application/json', body });
  });
  return { asks, errors };
}

for (const width of [390, 1280]) for (const from of ['/method/', '/voice/']) {
  test(`${width} ${from} Enter reaches homepage triage exactly once, including reload`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const observed = await guard(page);
    const question = 'Should our Salesforce team choose Flow or Apex for lead assignment?';
    await page.goto(origin + from);
    await page.locator('#chrome-box').fill(question);
    await page.locator('#chrome-box').press('Enter');
    await expect(page.locator('#tape')).toContainText(question);
    await expect(page.locator('#tape')).toContainText('Synthetic handoff response.');
    expect(observed.asks).toHaveLength(1);
    expect(observed.asks[0].q).toContain(question);
    expect(observed.asks[0].agent).toBe('claude');
    expect(await page.evaluate(() => sessionStorage.getItem('sfdc24_pending_ask'))).toBeNull();
    expect(new URL(page.url()).searchParams.has('ask')).toBe(false);
    await page.reload();
    await expect(page.locator('#box')).toHaveValue('');
    expect(observed.asks).toHaveLength(1);
    expect(observed.errors).toEqual([]);
  });
}

test('local-first handoff answers without any model request', async ({ page }) => {
  const observed = await guard(page);
  await page.goto(origin + '/method/');
  await page.locator('#chrome-box').fill('hello');
  await page.locator('#chrome-box').press('Enter');
  await expect(page.locator('#tape')).toContainText('hello');
  await expect(page.locator('#tape .turn.it')).toHaveCount(1);
  expect(observed.asks).toHaveLength(0);
  expect(observed.errors).toEqual([]);
});

test('URL-only question is a draft until explicit Enter; scrub only ask', async ({ page }) => {
  const observed = await guard(page);
  const question = 'Should we use Apex & Flow? café + <img src=x onerror=alert(1)>';
  await page.goto(origin + '/?keep=1&ask=' + encodeURIComponent(question) + '#handoff');
  await expect(page.locator('#box')).toHaveValue(question);
  await expect(page.locator('#box')).toBeVisible();          // the hidden ask bar comes back for a hand-off
  await expect(page.locator('#state')).toContainText('restored as a draft');
  expect(page.url()).toBe(origin + '/?keep=1#handoff');
  expect(observed.asks).toHaveLength(0);
  await page.locator('#box').press('Enter');
  await expect(page.locator('#tape')).toContainText(question);
  expect(observed.asks).toHaveLength(1);
  expect(observed.errors).toEqual([]);
});

test('stale saved text without matching URL is cleared and not sent', async ({ page }) => {
  const observed = await guard(page);
  await page.goto(origin + '/method/');
  await page.evaluate(() => sessionStorage.setItem('sfdc24_pending_ask', 'old unrelated question'));
  await page.goto(origin + '/?ask=new%20draft');
  await expect(page.locator('#box')).toHaveValue('new draft');
  expect(observed.asks).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem('sfdc24_pending_ask'))).toBeNull();
  await page.reload();
  await expect(page.locator('#box')).toHaveValue('');
  expect(observed.asks).toHaveLength(0);
});

test('blocked storage preserves the navigation draft without automatic send', async ({ page }) => {
  const observed = await guard(page);
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked'); } }));
  await page.goto(origin + '/method/');
  await page.locator('#chrome-box').fill('Should we use Apex or Flow?');
  await page.locator('#chrome-box').press('Enter');
  await expect(page.locator('#box')).toHaveValue('Should we use Apex or Flow?');
  expect(observed.asks).toHaveLength(0);
  await page.locator('#box').press('Enter');
  await expect(page.locator('#tape')).toContainText('Synthetic handoff response.');
  expect(observed.asks).toHaveLength(1);
  expect(observed.errors).toEqual([]);
});

test('a failed consume never automatically replays a saved question', async ({ page }) => {
  const observed = await guard(page);
  await page.addInitScript(() => { Storage.prototype.removeItem = function() { throw new Error('read only'); }; });
  await page.goto(origin + '/method/');
  await page.locator('#chrome-box').fill('Should we use Apex or Flow?');
  await page.locator('#chrome-box').press('Enter');
  await expect(page.locator('#box')).toHaveValue('Should we use Apex or Flow?');
  expect(observed.asks).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#box')).toHaveValue('');
  expect(observed.asks).toHaveLength(0);
});
