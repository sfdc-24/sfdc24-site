const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net') return route.continue();
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'application/octet-stream',
    });
  });
});

async function openCanvas(page) {
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  await expect(page.locator('#proto-canvas')).toBeHidden();
  await expect(page.locator('script[data-proto-mermaid]')).toHaveCount(0);
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('#proto-canvas')).toBeVisible();
  await expect(page.locator('.pcv-source')).toBeVisible();
}

test('editing a diagram redraws it, and the prototype pane stays honest', async ({ page }) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openCanvas(page);
  const close = page.locator('#conf-canvas-toggle');
  const salesforce = page.getByRole('button', { name: 'Salesforce', exact: true });
  await expect(close).toHaveText('Close the canvas');
  for (const locator of [close, salesforce, page.getByRole('tab', { name: 'Access' })]) {
    const box = await locator.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  }

  const source = page.locator('.pcv-source');
  await expect(source).toHaveValue(/Public page/);
  await source.fill('flowchart LR\n  edited[Edited step]\n');
  await expect(page.locator('.pcv-a svg')).toContainText('Edited step', { timeout: 20000 });
  await expect(page.locator('script[data-proto-mermaid]')).toHaveCount(1);
  expect(await page.evaluate(() => window.mermaid.mermaidAPI.getConfig().securityLevel)).toBe('strict');

  await page.getByRole('tab', { name: 'Prototype' }).click();
  await expect(page.locator('.pcv-b')).toContainText('No Penpot file is published.');
  await expect(page.locator('.pcv-b iframe.pcv-wire')).toHaveCount(1);
  await expect(page.locator('.pcv-b iframe.pcv-frame')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Mark' }).click();
  await expect(page.locator('.pcv-source')).toHaveAttribute('readonly', '');
  await expect(page.locator('.pcv-a')).toContainText('Approved');
  await expect(page.locator('.pcv-a')).toContainText('Example');
});

test('Salesforce shows the snapshot fields and saves a local request', async ({ page }) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openCanvas(page);
  await page.getByRole('button', { name: 'Salesforce', exact: true }).click();
  const pane = page.locator('.pcv-a');
  await expect(pane).toContainText('Not live.');
  await expect(pane).toContainText('Account');
  await expect(pane).toContainText('Contact');
  await expect(pane).toContainText('Opportunity');
  await expect(pane).toContainText('AnnualRevenue');
  await expect(pane).not.toContainText('Email');
  await expect(pane.locator('.pcv-graph svg')).toBeVisible({ timeout: 20000 });
  await page.locator('#pcv-change').fill('Add a stage note');
  await page.getByRole('button', { name: 'Save request' }).click();
  await expect(pane).toContainText('Account: Add a stage note');
  await expect(pane).toContainText('Not sent to the org.');
  await page.reload();
  await expect(page.locator('#proto-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Salesforce', exact: true }).click();
  await expect(page.locator('.pcv-a')).toContainText('Account: Add a stage note');
});

test('feed markup cannot carry a script URL', async ({ page }) => {
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  const report = await page.evaluate(() => {
    const api = window.ProtoCanvas;
    const html = api.safeHtml([
      '<a href=" javascript:alert(1)">j</a>',
      '<a href="java\tscript:alert(1)">t</a>',
      '<a href="\njavascript:alert(1)">n</a>',
      '<a href="data:text/html,1">d</a>',
      '<a href="vbscript:msgbox(1)">v</a>',
      '<a href="//evil.example/x">p</a>',
      '<a href="https://example.com/ok">h</a>',
      '<a href="/room">r</a>',
      '<div style="background:url( javascript:alert(1))"></div>',
      '<img src="x" onerror="alert(1)">'
    ].join(''));
    const host = document.createElement('div');
    host.appendChild(api.safeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><a href=" javascript:alert(1)"><text>x</text></a></svg>'));
    return {
      html: html,
      svg: host.innerHTML,
      model: api.modelSource({
        objects: [{ name: 'Account\nclick A href "javascript:alert(1)"', fields: [{ name: 'Name', type: 'string' }] }],
        relationships: [{ from: 'Contact', to: 'Account', label: 'javascript:alert(1)' }]
      }),
      penpot: {
        ok: api.penpotUrl('https://design.penpot.app/embed/1'),
        space: api.penpotUrl(' javascript:alert(1)'),
        tab: api.penpotUrl('\tjavascript:alert(1)'),
        evil: api.penpotUrl('https://evil.example/prototype'),
        suffix: api.penpotUrl('https://design.penpot.app.evil.example/'),
        user: api.penpotUrl('https://user:pass@design.penpot.app/x'),
        data: api.penpotUrl('data:text/html,1'),
        http: api.penpotUrl('http://design.penpot.app/x'),
        vbscript: api.penpotUrl('vbscript:msgbox(1)')
      }
    };
  });
  expect(report.html).not.toMatch(/javascript:/i);
  expect(report.html).not.toMatch(/vbscript:/i);
  expect(report.html).not.toMatch(/data:/i);
  expect(report.html).not.toMatch(/onerror/i);
  expect(report.html).not.toContain('//evil.example');
  expect(report.html).toContain('https://example.com/ok');
  expect(report.html).toContain('href="/room"');
  expect(report.svg).not.toMatch(/onload/i);
  expect(report.svg).not.toMatch(/javascript:/i);
  expect(report.model).not.toMatch(/javascript:/i);
  expect(report.model).not.toContain('click');
  expect(report.penpot.ok).toBe('https://design.penpot.app/embed/1');
  for (const key of ['space', 'tab', 'evil', 'suffix', 'user', 'data', 'http', 'vbscript']) {
    expect(report.penpot[key]).toBe('');
  }

  await page.route('http://site.test/data/proto-canvas.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      format: 'proto-canvas/1',
      public_status: 'examples',
      items: [
        {
          id: 'mark',
          set: 'mark',
          set_label: 'Mark',
          type: 'logo',
          title: 'Bad mark',
          horizon: 'current',
          status: 'wip',
          example: true,
          by: 'example',
          source: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><a href=" javascript:alert(1)"><text>x</text></a></svg>',
          penpot: 'https://evil.example/prototype'
        },
        {
          id: 'wire',
          set: 'prototype',
          set_label: 'Prototype',
          type: 'ui',
          title: 'Bad wire',
          horizon: 'current',
          status: 'wip',
          example: true,
          by: 'example',
          source: '<a href=" javascript:alert(1)">j</a><a href="data:text/html,1">d</a><a href="https://example.com/ok">ok</a>',
          penpot: ' javascript:alert(1)'
        }
      ]
    })
  }));
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  await page.locator('#conf-canvas-toggle').click();
  await page.getByRole('tab', { name: 'Mark' }).click();
  const drawn = await page.locator('.pcv-a').innerHTML();
  expect(drawn).not.toMatch(/onload/i);
  expect(drawn).not.toMatch(/javascript:/i);
  await page.getByRole('tab', { name: 'Prototype' }).click();
  await expect(page.locator('.pcv-b iframe.pcv-frame')).toHaveCount(0);
  await expect(page.locator('.pcv-b')).toContainText('No Penpot file is published.');
  const srcdoc = await page.locator('.pcv-wire').getAttribute('srcdoc');
  expect(srcdoc).not.toMatch(/javascript:/i);
  expect(srcdoc).not.toMatch(/data:/i);
  expect(srcdoc).toContain('https://example.com/ok');
});

test('the canvas fits a phone without pushing the controls off or scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCanvas(page);
  const sideways = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(sideways).toBeLessThanOrEqual(0);
  const close = await page.locator('#conf-canvas-toggle').boundingBox();
  expect(close.y + close.height).toBeLessThanOrEqual(844);
  await page.locator('.pcv-pane-toggle', { hasText: 'Prototype' }).click();
  await expect(page.locator('.pcv-b')).toBeVisible();
  await page.locator('#conf-brochure-toggle').click();
  await expect(page.locator('#conf-brochure')).toContainText('No public join');
});
