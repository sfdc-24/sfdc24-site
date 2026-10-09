// /experience/ as one screen (owner, 2026-10-09 05:5x: "way too many things to
// scroll through ... make it more interactive"; "I'm not seeing any process map
// on my screen"): no page scroll, one diagram at a time with tabs, the newest
// brought forward, flows drawn as Mermaid flowcharts from the builder's nodes
// (strict labels), details on tap, and the builder's questions as large chips
// in the rail. The homepage canvas is unchanged.
const { test, expect } = require('@playwright/test');
const h = require('./helpers/experience-harness.cjs');

const ALLOWED_LINE = /^(flowchart (LR|TD)|  s\d+\["[A-Za-z0-9 ,.:;?!'()\/+_-]*"\]|  s\d+ (-->|-->\|"[A-Za-z0-9 ,.:;?!'()\/+_-]*"\|) s\d+)$/;
const question = (seq) => ({ seq, type: 'question.asked', artifact_version: 1, generation: 1, session_id: 's-1',
  payload: { question: { question_id: 'q1', prompt: 'Which part first?', options: [
    { option_id: 'a', label: 'The gateway', consequence: 'Entry gets fixed before anything else.' },
    { option_id: 'b', label: 'The bus' }, { option_id: 'c', label: 'The chair' }, { option_id: 'd', label: 'The audio' }] } } });
const noScroll = page => page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
const visibleDiagrams = page => page.locator('[data-pc-diagram]').evaluateAll(els => els.filter(e => !e.hidden && e.offsetParent).map(e => e.getAttribute('data-pc-id')));

for (const [w, hgt] of [[1280, 800], [390, 844]]) {
  test(`one screen, no page scroll at ${w}x${hgt}, before and during a session`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: hgt });
    const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree()), question(2)] });
    await expect(page.locator('#experience-voice [data-vc-start]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await noScroll(page)).toBeLessThanOrEqual(2);
    await h.startStudio(page, calls);
    await expect(page.locator('[data-pc-diagram]:not([hidden])')).toHaveCount(1);
    await expect(page.locator('#xp-rail-ask [data-pc-option]')).toHaveCount(4);
    await page.waitForTimeout(300);
    expect(await noScroll(page)).toBeLessThanOrEqual(2);
    // The diagram is on screen, not below the fold.
    const box = await page.locator('[data-pc-diagram]:not([hidden]) [data-pc-flow]').boundingBox();
    expect(box && box.height).toBeGreaterThan(80);
    expect(box.y + 40).toBeLessThan(hgt);
  });
}

test('one diagram at a time, a tab per diagram, the latest first; a tab switches', async ({ page }) => {
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree())] });
  await h.startStudio(page, calls);
  await expect(page.locator('[data-pc-tab]')).toHaveText(['Architecture: the call path', 'Process: one turn on the line']);
  await expect(page.locator('[data-pc-tab="proc"]')).toHaveAttribute('aria-selected', 'true');
  expect(await visibleDiagrams(page)).toEqual(['proc']);
  await page.locator('[data-pc-tab="arch"]').click();
  expect(await visibleDiagrams(page)).toEqual(['arch']);
  await expect(page.locator('[data-pc-tab="arch"]')).toHaveAttribute('aria-selected', 'true');
});

test('the diagram a change lands in is brought forward', async ({ page }) => {
  const events = [h.snapshot(h.conferenceTree()),
    { seq: 2, type: 'artifact.patch', artifact_version: 2, generation: 1, session_id: 's-1',
      payload: { ops: [{ op: 'set_detail', node_id: 'gw', value: 'Admits the owner, then the guests.' }] } }];
  const calls = await h.load(page, '/experience/', { events });
  await h.startStudio(page, calls);
  await expect(page.locator('[data-pc-tab="arch"]')).toHaveAttribute('aria-selected', 'true');
  expect(await visibleDiagrams(page)).toEqual(['arch']);
});

test('a data model from the analyst gets its own tab and is brought forward', async ({ page }) => {
  const model = { domain: 'Conference', objects: [
    { id: 'room', name: 'Room', fields: [{ name: 'Name', type: 'Text' }] },
    { id: 'turn', name: 'Turn', fields: [{ name: 'Speaker', type: 'Text' }] }],
    relationships: [{ from: 'turn', to: 'room', kind: 'master-detail' }] };
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree()),
    { seq: 2, type: 'model.updated', generation: 1, session_id: 's-1', payload: { model } }] });
  await h.startStudio(page, calls);
  await expect(page.locator('[data-pc-tab="__model"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-pc-model-pane]')).toBeVisible();
  await expect(page.locator('[data-pc-stage]')).toBeHidden();
  await page.locator('[data-pc-tab="arch"]').click();
  await expect(page.locator('[data-pc-model-pane]')).toBeHidden();
  expect(await visibleDiagrams(page)).toEqual(['arch']);
});

test('a flow is drawn by Mermaid from the steps and edges, left to right, in strict mode', async ({ page }) => {
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree())] });
  await h.startStudio(page, calls);
  await expect(page.locator('[data-pc-diagram]:not([hidden]) [data-pc-flow-svg] svg')).toHaveCount(1);
  const sources = await page.evaluate(() => window.__mermaidSources);
  const arch = sources.find(src => src.includes('Gateway'));
  expect(arch.split('\n')).toEqual([
    'flowchart LR', '  s0["Gateway"]', '  s1["Message bus"]', '  s2["Chair"]',
    '  s0 -->|"Turn request"| s1', '  s1 -->|"Next speaker"| s2']);
  // Steps with no edge between them still follow each other.
  const proc = sources.find(src => src.includes('Owner speaks'));
  expect(proc).toContain('  s0 --> s1');
  expect(proc).toContain('  s1 --> s2');
  expect(await page.evaluate(() => window.__mermaidConfig.securityLevel)).toBe('strict');
  expect(await page.evaluate(() => window.__mermaidConfig.startOnLoad)).toBe(false);
});

test('nothing the builder sends becomes Mermaid syntax or markup', async ({ page }) => {
  const tree = { id: 'screen', kind: 'screen', label: 'x', children: [{ id: 'evil', kind: 'section', label: 'e', children: [
    { id: 'eh', kind: 'heading', label: 'Evil' },
    { id: 'a', kind: 'process-step', label: 'A"]; click s0 call alert(1); s9["', detail: '<img src=x onerror=alert(1)>' },
    { id: 'ea', kind: 'edge', label: 'x|"]-->s9{{"<b>', detail: 'A -> B' },
    { id: 'b', kind: 'process-step', label: '<script>alert(1)</script>%%{init: {"securityLevel":"loose"}}%%', detail: '' },
    { id: 'c', kind: 'process-step', label: '`markdown` **bold** #35; &amp; \\n end', detail: '' }] }] };
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(tree)] });
  await h.startStudio(page, calls);
  await expect(page.locator('[data-pc-flow-svg] svg')).toHaveCount(1);
  const src = (await page.evaluate(() => window.__mermaidSources))[0];
  for (const line of src.split('\n')) expect(line).toMatch(ALLOWED_LINE);
  expect(src).not.toMatch(/%%|<|`|#|&|\{|\}|\*|\\/);
  await expect(page.locator('img, [data-pc-diagram] script')).toHaveCount(0);
});

test('step details appear on tap, not inline', async ({ page }) => {
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree())] });
  await h.startStudio(page, calls);
  await page.locator('[data-pc-tab="arch"]').click();
  const detail = page.locator('[data-pc-diagram]:not([hidden]) [data-pc-flow-detail]');
  await expect(detail).toHaveText('Tap a step for what it does.');
  // Not inline: no step box carries its detail as text (it is the hover title and the tap line).
  await expect(page.locator('[data-pc-diagram] :is(p, button, li)', { hasText: 'Admits the owner and opens the room.' })).toHaveCount(0);
  await expect(page.locator('.pc-step')).toHaveCount(0);
  await page.locator('[data-pc-diagram]:not([hidden]) g[data-pc-step="gw"]').click();
  await expect(detail).toHaveText('Gateway: Admits the owner and opens the room.');
  await page.locator('[data-pc-card="risk"]').click();
  await expect(detail).toContainText('A watchdog ends a turn after 30 seconds.');
});

test('without Mermaid the flow still shows as tappable boxes and arrows', async ({ page }) => {
  const calls = await h.load(page, '/experience/', { mermaid: 'none', events: [h.snapshot(h.conferenceTree())] });
  await h.startStudio(page, calls);
  await page.locator('[data-pc-tab="arch"]').click();
  const steps = page.locator('[data-pc-diagram]:not([hidden]) [data-pc-flow-plain] .pc-flow-step');
  await expect(steps).toHaveText(['Gateway', 'Message bus', 'Chair']);
  await steps.nth(1).click();
  await expect(page.locator('[data-pc-diagram]:not([hidden]) [data-pc-flow-detail]'))
    .toHaveText('Message bus: Carries every turn between the parts.');
});

test("the builder's question shows as large chips in the rail, and a tap answers it", async ({ page }) => {
  const calls = await h.load(page, '/experience/', { events: [h.snapshot(h.conferenceTree()), question(2)] });
  await h.startStudio(page, calls);
  const options = page.locator('#xp-rail-ask [data-pc-option]');
  await expect(options).toHaveText(['The gateway', 'The bus', 'The chair', 'The audio']);
  await expect(options.first()).toHaveAttribute('title', 'Entry gets fixed before anything else.');
  const box = await options.first().boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await options.first().click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'answer').length).toBe(1);
  const sent = calls.find(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'answer').body;
  expect(sent).toMatchObject({ question_id: 'q1', option_id: 'a', answer_source: 'tap' });
});

test('the homepage canvas is not in diagrams mode and loads no Mermaid', async ({ page }) => {
  await h.load(page, '/', { mermaid: 'none' });
  await expect(page.locator('#prototype-canvas')).not.toHaveAttribute('data-pc-mode', /.*/);
  await expect(page.locator('[data-pc-tabs]')).toHaveCount(0);
  await expect(page.locator('script[data-pc-mermaid]')).toHaveCount(0);
});
