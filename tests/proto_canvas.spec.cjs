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
  await expect(page.locator('#proto-canvas')).toHaveAttribute('data-live', '0');
  await expect(page.locator('.pcv-note')).toContainText('Not live.');
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

test('namespaced foreign content cannot become an iframe', async ({ page }) => {
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  const report = await page.evaluate(() => {
    const api = window.ProtoCanvas;
    function mount(markup) {
      const node = api.safeSvg(markup);
      const host = document.createElement('div');
      if (node) host.appendChild(node);
      return {
        html: host.innerHTML,
        iframes: host.querySelectorAll('iframe').length,
        foreign: host.querySelectorAll('foreignObject').length,
        hrefs: [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((attr) => attr.name + '=' + attr.value))
      };
    }
    const ns = 'xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xhtml" xmlns:y="http://www.example.com/ns" xmlns:xlink="http://www.w3.org/1999/xlink"';
    return {
      prefixed: mount('<svg ' + ns + '><foreignObject width="120" height="40"><x:iframe src="https://evil.example/one"></x:iframe></foreignObject><rect width="4" height="4"/></svg>'),
      nested: mount('<svg ' + ns + '><svg><foreignObject width="120" height="40"><y:iframe src="https://evil.example/two"></y:iframe></foreignObject></svg><rect width="4" height="4"/></svg>'),
      svgIframe: mount('<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.example/three"></iframe><rect width="4" height="4"/></svg>'),
      xlink: mount('<svg ' + ns + '><a xlink:href=" javascript:alert(1)" href="https://example.com/ok"><text>kept</text></a></svg>'),
      xlinkTab: mount('<svg ' + ns + '><a xlink:href="java\tscript:alert(1)"><text>kept</text></a></svg>'),
      html: api.safeHtml('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><x:iframe src="https://evil.example/four"></x:iframe></foreignObject></svg><div>wire</div>')
    };
  });
  for (const view of [report.prefixed, report.nested, report.svgIframe]) {
    expect(view.iframes).toBe(0);
    expect(view.foreign).toBe(0);
    expect(view.html).not.toMatch(/iframe/i);
    expect(view.html).not.toMatch(/foreignObject/i);
    expect(view.html).toContain('<rect');
  }
  expect(report.xlink.hrefs.join(' ')).not.toMatch(/javascript:/i);
  expect(report.xlink.hrefs.join(' ')).toContain('https://example.com/ok');
  expect(report.xlink.html).toContain('kept');
  expect(report.xlinkTab.hrefs.join(' ')).not.toMatch(/javascript:/i);
  expect(report.html).not.toMatch(/iframe/i);
  expect(report.html).not.toMatch(/foreignObject/i);
  expect(report.html).toContain('wire');
});

test('untrusted svg cannot request an outside image', async ({ page }) => {
  const hits = [];
  page.on('request', (req) => {
    if (/evil\.example/.test(req.url())) hits.push(req.url());
  });
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  const report = await page.evaluate(() => {
    const markup = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<image href="https://evil.example/pixel.png" xlink:href="https://evil.example/pixel2.png"/>',
      '<style>@import url(https://evil.example/a.css); .n { fill: url(https://evil.example/b.png); } .k { fill: url(#ink); }</style>',
      '<rect width="8" height="8" fill="url(https://evil.example/c.png)"/>',
      '<use href="https://evil.example/icon.svg#a"/>',
      '<text>kept label</text>',
      '</svg>'
    ].join('');
    const node = window.ProtoCanvas.safeSvg(markup);
    const host = document.createElement('div');
    if (node) host.appendChild(node);
    const html = window.ProtoCanvas.safeHtml('<img src="https://evil.example/wire.png"><img src="/assets/icon-32.png" alt="local">');
    return { svg: host.innerHTML, html: html };
  });
  expect(hits).toEqual([]);
  expect(report.svg).toContain('kept label');
  expect(report.svg).not.toMatch(/evil\.example/i);
  expect(report.svg).not.toMatch(/<image/i);
  expect(report.svg).not.toMatch(/<style/i);
  expect(report.html).not.toMatch(/evil\.example/i);
  expect(report.html).toContain('/assets/icon-32.png');
});

test('a feed svg style cannot change the page outline', async ({ page }) => {
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  await page.evaluate(() => { document.body.style.outline = '3px solid black'; });
  const before = await page.evaluate(() => getComputedStyle(document.body).outlineWidth);
  expect(before).toBe('3px');
  const mounted = await page.evaluate(() => {
    const attack = 'body { outline: 4px solid red !important; }';
    function mount(markup) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const node = window.ProtoCanvas.safeSvg(markup);
      if (node) host.appendChild(node);
      return {
        outline: getComputedStyle(document.body).outlineWidth,
        html: host.innerHTML,
        styles: host.querySelectorAll('style').length
      };
    }
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    const direct = mount('<svg ' + ns + '><style>' + attack + '</style><rect class="leak" style="fill:red" width="8" height="8"/></svg>');
    const nested = mount('<svg ' + ns + '><svg><style>' + attack + '</style></svg><rect width="8" height="8"/></svg>');
    const html = window.ProtoCanvas.safeHtml([
      '<style>' + attack + '</style>',
      '<div style="color:blue">kept</div>',
      '<p style="@import url(https://evil.example/a.css)">i</p>',
      '<p style="width: expression(alert(1))">e</p>',
      '<p style="background:\\75 rl(https://evil.example/b.png)">u</p>',
      '<div>wire</div>'
    ].join(''));
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return {
      direct: direct,
      nested: nested,
      html: html,
      afterHtml: getComputedStyle(document.body).outlineWidth
    };
  });
  expect(mounted.direct.outline).toBe('3px');
  expect(mounted.nested.outline).toBe('3px');
  expect(mounted.afterHtml).toBe('3px');
  expect(mounted.direct.styles).toBe(0);
  expect(mounted.nested.styles).toBe(0);
  expect(mounted.direct.html).not.toMatch(/<style/i);
  expect(mounted.nested.html).not.toMatch(/<style/i);
  expect(mounted.direct.html).not.toMatch(/\sstyle=/i);
  expect(mounted.direct.html).not.toMatch(/\sclass=/i);
  expect(mounted.direct.html).toContain('<rect');
  expect(mounted.nested.html).toContain('<rect');
  expect(mounted.html).not.toMatch(/<style/i);
  expect(mounted.html).not.toMatch(/@import/i);
  expect(mounted.html).not.toMatch(/url\s*\(/i);
  expect(mounted.html).not.toMatch(/expression\s*\(/i);
  expect(mounted.html).not.toContain('evil.example');
  expect(mounted.html).toContain('color:blue');
  expect(mounted.html).toContain('wire');

  await page.evaluate(() => {
    window.mermaid = {
      initialize() {},
      mermaidAPI: { getConfig() { return { securityLevel: 'strict' }; } },
      render() {
        return Promise.resolve({
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><style>body { outline: 4px solid red !important; }</style><text class="leak" style="fill:red">kept-label</text></svg>'
        });
      }
    };
  });
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('.pcv-a svg text')).toContainText('kept-label');
  const drawn = await page.evaluate(() => {
    const svg = document.querySelector('.pcv-a svg');
    return {
      outline: getComputedStyle(document.body).outlineWidth,
      styles: document.querySelectorAll('#proto-canvas style').length,
      html: svg ? svg.outerHTML : ''
    };
  });
  expect(drawn.outline).toBe('3px');
  expect(drawn.html).not.toMatch(/<style/i);
  expect(drawn.html).not.toMatch(/\sstyle=/i);
  expect(drawn.html).not.toMatch(/\sclass=/i);
  expect(drawn.html).toContain('kept-label');
});

test('a late mermaid render does not replace the approved drawing', async ({ page }) => {
  await page.goto('http://site.test/conference/', { waitUntil: 'load' });
  await page.evaluate(() => {
    window.__draws = [];
    window.mermaid = {
      initialize() {},
      mermaidAPI: { getConfig() { return { securityLevel: 'strict' }; } },
      render(id, text) {
        return new Promise((resolve) => { window.__draws.push({ id: id, text: text, resolve: resolve }); });
      }
    };
  });
  expect(await page.evaluate(() => typeof window.ProtoCanvas.loadCanvasItems)).toBe('function');
  await page.locator('#conf-canvas-toggle').click();
  await page.waitForFunction(() => window.__draws.length >= 1);
  await page.locator('.pcv-source').fill('flowchart LR\n  late[LATE-DRAW]\n');
  await page.getByRole('tab', { name: 'Mark' }).click();
  await expect(page.locator('.pcv-a')).toContainText('Approved');
  await page.waitForTimeout(700);
  for (let i = 0; i < 4; i++) {
    const pending = await page.evaluate(() => window.__draws.some((draw) => !draw.done));
    if (!pending) break;
    await page.evaluate(() => {
      const draw = window.__draws.find((item) => !item.done);
      if (!draw) return;
      draw.done = true;
      const label = draw.text.indexOf('LATE-DRAW') !== -1 ? 'LATE-DRAW' : 'OLD-DRAW';
      draw.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>' + label + '</text></svg>' });
    });
    await page.waitForTimeout(30);
  }
  const html = await page.locator('.pcv-a').innerHTML();
  expect(html).not.toContain('LATE-DRAW');
  expect(html).not.toContain('OLD-DRAW');
  expect(html).toContain('<circle');
  await expect(page.locator('.pcv-a')).toContainText('Approved');
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

const BUCKET = 'https://storage.googleapis.com/sfdc24-canvas';

async function stubMermaid(page) {
  await page.evaluate(() => {
    window.mermaid = {
      initialize() {},
      mermaidAPI: { getConfig() { return { securityLevel: 'strict' }; } },
      render() {
        return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>stub</text></svg>' });
      }
    };
  });
}

test('a room file shows each agent and drops a private or unknown item', async ({ page }) => {
  const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/canvas-room.json'));
  await page.route(BUCKET + '/**', (route) => route.fulfill({
    body: fixture,
    contentType: 'application/json'
  }));
  await page.goto('http://site.test/conference/?room=demo', { waitUntil: 'load' });
  expect(await page.evaluate(() => window.ProtoCanvas.bucket)).toBe(BUCKET);
  await stubMermaid(page);
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('#proto-canvas')).toHaveAttribute('data-live', '1');
  await expect(page.locator('.pcv-note')).not.toContainText('Not live.');
  const roster = page.locator('.pcv-roster');
  await expect(roster).toContainText('Posted by grok');
  await expect(roster).toContainText('Posted by gemini');
  await expect(roster).toContainText('Posted by claude-code-cli');
  await expect(roster).toContainText('Posted by chatgpt-codex-desktop');
  await expect(roster).toContainText('Posted by unknown');
  await expect(roster).toContainText('Working');
  await expect(roster).toContainText('In review');
  await expect(roster).toContainText('Claimed');
  await expect(roster).toContainText('Done');
  const pageText = await page.locator('#proto-canvas').innerText();
  expect(pageText).not.toContain('PRIVATE-CANVAS-ITEM');
  expect(pageText).not.toContain('DROP-UNKNOWN-TYPE');
  expect(pageText).not.toContain('http-only-mark');
  expect(pageText).not.toContain('javascript:');
  expect(pageText).not.toContain('evil.example');
  expect(pageText).not.toContain('Outside image');
  await expect(roster).toContainText('Unsigned note');

  await page.getByRole('tab', { name: 'Unsigned note' }).click();
  await expect(page.locator('.pcv-a')).toContainText('UNSIGNED-NOTE');
  await expect(page.locator('.pcv-a')).toContainText('Posted by unknown');
  await page.getByRole('tab', { name: 'Sketch', exact: true }).click();
  const sketch = page.locator('.pcv-a img.pcv-image');
  await expect(sketch).toHaveAttribute('src', 'https://storage.googleapis.com/sfdc24-canvas/gemini-sketch.png');
  await expect(sketch).toHaveAttribute('referrerpolicy', 'no-referrer');
  await page.getByRole('tab', { name: 'Desk sketch' }).click();
  const srcdoc = await page.locator('.pcv-a iframe.pcv-wire').getAttribute('srcdoc');
  expect(srcdoc).toContain('Codex wire');
  expect(srcdoc).not.toMatch(/<script/i);
  await expect(page.locator('.pcv-a')).toContainText('Done');
  await expect(page.locator('.pcv-a')).toContainText('Posted by chatgpt-codex-desktop');
});

test('a newer room version replaces an item and an older one is ignored', async ({ page }) => {
  let step = 0;
  await page.route(BUCKET + '/**', (route) => {
    step += 1;
    const version = step === 1 ? 2 : (step === 2 ? 1 : 3);
    const body = step === 1 ? 'NEWER-NOTE' : (step === 2 ? 'OLDER-NOTE' : 'NEWEST-NOTE');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        format: 'proto-canvas/1',
        room: 'demo',
        generated: '2026-10-20T21:40:00Z',
        items: [{
          v: 1,
          id: 'n1',
          type: 'note',
          title: 'Versioned note',
          body: body,
          status: 'working',
          version: version,
          public: true,
          ts: '2026-10-20T21:40:00Z',
          agent: 'grok'
        }]
      })
    });
  });
  await page.goto('http://site.test/conference/?room=demo', { waitUntil: 'load' });
  await page.clock.install();
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('.pcv-a')).toContainText('NEWER-NOTE');
  await expect(page.locator('.pcv-roster')).toContainText('Posted by grok');
  const second = page.waitForRequest((req) => req.url().includes('/rooms/demo.json'));
  await page.clock.fastForward(5000);
  await second;
  await expect(page.locator('.pcv-a')).toContainText('NEWER-NOTE');
  await expect(page.locator('.pcv-a')).not.toContainText('OLDER-NOTE');
  const third = page.waitForRequest((req) => req.url().includes('/rooms/demo.json'));
  await page.clock.fastForward(5000);
  await third;
  await expect(page.locator('.pcv-a')).toContainText('NEWEST-NOTE');
  await expect(page.locator('.pcv-a')).not.toContainText('NEWER-NOTE');
  await expect(page.locator('.pcv-a')).not.toContainText('OLDER-NOTE');
});

test('a wrong room format or a failed fetch falls back to the static canvas', async ({ page }) => {
  await page.route(BUCKET + '/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      format: 'not-the-canvas',
      room: 'demo',
      generated: '2026-10-20T21:45:00Z',
      items: [{
        v: 1,
        id: 'bad',
        type: 'note',
        title: 'WRONG-FORMAT-ITEM',
        body: 'WRONG-FORMAT-ITEM',
        status: 'working',
        version: 1,
        public: true,
        ts: '2026-10-20T21:45:00Z',
        agent: 'grok'
      }]
    })
  }));
  await page.goto('http://site.test/conference/?room=demo', { waitUntil: 'load' });
  await stubMermaid(page);
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('#proto-canvas')).toHaveAttribute('data-live', '0');
  await expect(page.locator('.pcv-note')).toContainText('Not live.');
  await expect(page.getByRole('tab', { name: 'Access' })).toBeVisible();
  await expect(page.locator('#proto-canvas')).not.toContainText('WRONG-FORMAT-ITEM');
  await expect(page.locator('#proto-canvas')).not.toContainText('Feed missing');
  await expect(page.locator('.pcv-roster')).toBeHidden();

  await page.unroute(BUCKET + '/**');
  await page.route(BUCKET + '/**', (route) => route.fulfill({ status: 500, body: '' }));
  await page.reload({ waitUntil: 'load' });
  await stubMermaid(page);
  await expect(page.locator('#proto-canvas')).toBeVisible();
  await expect(page.locator('.pcv-note')).toContainText('Not live.');
  await expect(page.getByRole('tab', { name: 'Access' })).toBeVisible();
  await expect(page.locator('#proto-canvas')).not.toContainText('Feed missing');
});

async function expectReadableDiagram(page) {
  const report = await page.evaluate(() => {
    function lum(color) {
      const parts = String(color).match(/[\d.]+/g);
      if (!parts || parts.length < 3) return 0;
      return (0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2])) / 255;
    }
    const svg = document.querySelector('.pcv-a svg');
    if (!svg) return { missing: true };
    const labels = [];
    svg.querySelectorAll('text').forEach((text) => {
      const value = text.textContent.replace(/\s+/g, ' ').trim();
      if (!value) return;
      const box = text.getBoundingClientRect();
      let node = text.parentElement;
      let behind = null;
      let behindArea = Infinity;
      while (node && node.tagName.toLowerCase() !== 'svg') {
        const shapes = node.querySelectorAll('rect, path, polygon, circle, ellipse');
        for (const shape of shapes) {
          if (shape === text || shape.closest('marker')) continue;
          const fill = getComputedStyle(shape).fill;
          if (!fill || fill === 'none') continue;
          const area = shape.getBoundingClientRect();
          const covers = box.width > 0 && area.width + 1 >= box.width && area.height + 1 >= box.height
            && box.left >= area.left - 2 && box.right <= area.right + 2
            && box.top >= area.top - 2 && box.bottom <= area.bottom + 2;
          const size = area.width * area.height;
          if (covers && size < behindArea) {
            behind = { fill: fill, lum: lum(fill) };
            behindArea = size;
          }
        }
        node = node.parentElement;
      }
      labels.push({
        value: value,
        fill: getComputedStyle(text).fill,
        lum: lum(getComputedStyle(text).fill),
        behind: behind
      });
    });
    const lines = [...svg.querySelectorAll('[data-pcv-line]')].map((line) => {
      const style = getComputedStyle(line);
      return {
        stroke: style.stroke,
        width: parseFloat(style.strokeWidth),
        fill: style.fill
      };
    });
    return {
      styles: svg.querySelectorAll('style').length,
      html: svg.outerHTML,
      labels: labels,
      lines: lines
    };
  });
  expect(report.missing).toBeFalsy();
  expect(report.styles).toBe(0);
  expect(report.html).not.toMatch(/<style/i);
  expect(report.labels.length).toBeGreaterThan(0);
  for (const label of report.labels) {
    expect(label.lum, label.value).toBeLessThan(0.35);
    expect(label.behind, label.value).toBeTruthy();
    expect(label.behind.lum, label.value).toBeGreaterThan(0.75);
  }
  expect(report.lines.length).toBeGreaterThan(0);
  const stroked = report.lines.filter((line) => {
    const filled = line.fill && line.fill !== 'none';
    return !filled && line.stroke !== 'none' && line.width > 0;
  });
  expect(stroked.length).toBeGreaterThan(0);
  for (const line of report.lines) {
    const filled = line.fill && line.fill !== 'none';
    if (filled) {
      const parts = String(line.fill).match(/[\d.]+/g);
      const lum = parts && parts.length >= 3
        ? (0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2])) / 255
        : 0;
      expect(lum).toBeGreaterThan(0.15);
    } else {
      expect(line.stroke).not.toBe('none');
      expect(line.width).toBeGreaterThan(0);
    }
  }
}

test('diagram labels are readable and relationship lines are stroked', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    try { sessionStorage.removeItem('conference-canvas-open'); } catch (err) {}
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp.push(event.violatedDirective + ' ' + event.blockedURI);
    });
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width: width, height: 800 });
    await page.goto('http://site.test/conference/', { waitUntil: 'load' });
    await expect(page.locator('#proto-canvas')).toBeHidden();
    await page.locator('#conf-canvas-toggle').click();
    await expect(page.locator('.pcv-a svg')).toContainText('Public page', { timeout: 20000 });
    await page.waitForFunction(() => {
      const text = [...document.querySelectorAll('.pcv-a svg text')].find((node) => node.textContent.includes('Public page'));
      return text && text.getBoundingClientRect().width > 20;
    });
    await expectReadableDiagram(page);
    await page.getByRole('button', { name: 'Salesforce', exact: true }).click();
    await expect(page.locator('.pcv-a svg text', { hasText: 'Account' }).first()).toBeVisible({ timeout: 20000 });
    await expectReadableDiagram(page);
  }
  const violations = await page.evaluate(() => window.__csp);
  expect(violations).toEqual([]);
});

test('a new card opens as it lands, a working card counts up, a done card says when', async ({ page }) => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  let step = 0;
  const card = (id, title, status, ts, version) => ({
    v: 1, id: id, type: 'note', title: title, body: title + ' BODY', status: status,
    version: version || 1, public: true, ts: ts, agent: 'claude-mobile'
  });
  await page.route(BUCKET + '/**', (route) => {
    step += 1;
    const items = [card('old', 'Old card', 'done', iso(now - 600000))];
    if (step >= 2) items.push(card('fresh', 'In the making: fresh card', 'working', iso(now - 65000)));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      format: 'proto-canvas/1', room: 'demo', generated: iso(now), items: items }) });
  });
  await page.goto('http://site.test/conference/?room=demo', { waitUntil: 'load' });
  await stubMermaid(page);
  await page.locator('#conf-canvas-toggle').click();
  await expect(page.locator('#proto-canvas')).toHaveAttribute('data-live', '1');
  await expect(page.locator('.pcv-a .pcv-pane-h')).toContainText('Old card');
  await expect(page.locator('.pcv-a .pcv-badge').first()).toContainText(/Done at \d\d:\d\d/);
  await expect(page.locator('.pcv-toggle', { hasText: 'Follow' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pcv-a .pcv-pane-h')).toContainText('In the making: fresh card', { timeout: 15000 });
  await expect(page.locator('.pcv-a .pcv-badge[data-since]')).toContainText(/Working [1-9]:\d\d/);
});
