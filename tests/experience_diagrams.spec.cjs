// /experience/ as one screen (owner, 2026-10-09 05:5x: "way too many things to
// scroll through ... make it more interactive"; "I'm not seeing any process map
// on my screen"): no page scroll, one diagram at a time with tabs, the newest
// brought forward, flows drawn as Mermaid flowcharts from the builder's nodes
// (strict labels), details on tap, and the builder's questions as large chips
// in the rail. The homepage canvas is unchanged.
const { test, expect } = require('@playwright/test');
const h = require('./helpers/experience-harness.cjs');

const LABEL = String.raw`(?:\\[_.\-+():\/!?;,']|[A-Za-z0-9 ])*`;
// Every line of a generated flow: the header, a step box, a label node on an
// arrow, a plain arrow, and the fixed class lines for the label nodes. A label
// is letters, digits and spaces, with each allowed punctuation mark escaped.
const ALLOWED_LINE = new RegExp(String.raw`^(flowchart (LR|TD)|  s\d+\["` + LABEL + String.raw`"\]|  s\d+ --> s\d+|  s\d+ --- e\d+\["` + LABEL +
  String.raw`"\] --> s\d+|  classDef pclbl fill:#ffffff,stroke:#ffffff,color:#555555|  class e\d+(,e\d+)* pclbl)$`);
const question = (seq) => ({ seq, type: 'question.asked', artifact_version: 1, generation: 1, session_id: 's-1',
  payload: { question: { question_id: 'q1', prompt: 'Which part first?', options: [
    { option_id: 'a', label: 'The gateway', consequence: 'Entry gets fixed before anything else.' },
    { option_id: 'b', label: 'The bus' }, { option_id: 'c', label: 'The chair' }, { option_id: 'd', label: 'The audio' }] } } });
// What a box shows: its text without the hover title the page adds to a step.
const drawnText = gs => gs.map(g => { const c = g.cloneNode(true); c.querySelectorAll('title').forEach(t => t.remove()); return c.textContent; });
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
    '  s0 --- e0["Turn request"] --> s1', '  s1 --- e1["Next speaker"] --> s2',
    '  classDef pclbl fill:#ffffff,stroke:#ffffff,color:#555555', '  class e0,e1 pclbl']);
  // Steps with no edge from the builder follow each other in order.
  const proc = sources.find(src => src.includes('Owner speaks'));
  expect(proc).toContain('  s0 --> s1');
  expect(proc).toContain('  s1 --> s2');
  for (const src of sources) for (const line of src.split('\n')) expect(line).toMatch(ALLOWED_LINE);
  expect(await page.evaluate(() => window.__mermaidConfig.securityLevel)).toBe('strict');
  expect(await page.evaluate(() => window.__mermaidConfig.startOnLoad)).toBe(false);
});

// Cursor on bda06c9: an edge end matched a step by substring, the longest
// label winning, and the neighbour pass then added arrows the builder never
// drew, even closing a loop. Ends now match exactly, or the edge is not drawn.
test('edge ends match step names exactly; an unmatched edge is a note, not a guessed arrow', async ({ page }) => {
  await h.load(page, '/experience/', { mermaid: 'none' });
  const parts = await page.evaluate(() => {
    const S = (id, label) => ({ id, kind: 'process-step', label, detail: '' });
    const E = (id, label, detail) => ({ id, kind: 'edge', label, detail });
    const f = window.SFDC24Canvas.flowParts;
    return {
      email: f({ kind: 'section', children: [S('a', 'A1'), S('b', 'Backup'), S('c', 'Email'), E('e', 'Send', 'A -> Email')] }),
      wait: f({ kind: 'section', children: [S('w', 'Wait'), S('s', 'Start'), E('e', 'Go', 'Start -> Wait, then decide')] }),
      spaced: f({ kind: 'section', children: [S('a', 'Message  Bus'), S('b', 'chair'), E('e', 'Turn', '  message bus ->   Chair , on every turn')] }),
      twins: f({ kind: 'section', children: [S('a', 'Queue'), S('b', 'Queue'), S('c', 'Worker'), E('e', 'Job', 'Queue -> Worker')] }),
      plain: f({ kind: 'section', children: [S('a', 'One'), S('b', 'Two'), S('c', 'Three')] }),
      // Cursor on 30559d0: a step whose own name has a comma or a clause word.
      clause: f({ kind: 'section', children: [S('s', 'Start'), S('w', 'Wait, then decide'), E('e', 'Next', 'Start -> Wait, then decide')] }),
      ready: f({ kind: 'section', children: [S('s', 'Start'), S('r', 'Ready for launch'), E('e', 'Go', 'Start -> Ready for launch')] }),
      leftClause: f({ kind: 'section', children: [S('r', 'Ready for launch'), S('l', 'Launch'), E('e', 'Fire', 'Ready for launch -> Launch')] }),
      // The whole text names two steps: ambiguous, not cut down to a guess.
      wholeTwins: f({ kind: 'section', children: [S('a', 'Wait, then decide'), S('b', 'Wait, then decide'), S('c', 'Wait'), S('s', 'Start'),
                                                  E('e', 'X', 'Start -> Wait, then decide')] }),
    };
  });
  const arrows = p => p.edges.map(e => e.from + '>' + e.to);
  // The whole end text is tried first, on both sides; the clause cut only after.
  expect(arrows(parts.clause)).toEqual(['0>1']);
  expect(arrows(parts.ready)).toEqual(['0>1']);
  expect(arrows(parts.leftClause)).toEqual(['0>1']);
  expect(arrows(parts.wholeTwins)).toEqual([]);
  // "A" names no step: nothing is drawn for it, and no arrow is invented around it.
  expect(arrows(parts.email)).toEqual([]);
  expect(parts.email.unlinked.map(e => e.label)).toEqual(['Send']);
  // Start -> Wait with Wait listed first: that one arrow, and no reverse arrow (no loop).
  expect(arrows(parts.wait)).toEqual(['1>0']);
  expect(parts.wait.unlinked).toEqual([]);
  // Case and spacing do not matter; the words after a comma are not part of the name.
  expect(arrows(parts.spaced)).toEqual(['0>1']);
  // Two steps with the same name: ambiguous, so not drawn.
  expect(arrows(parts.twins)).toEqual([]);
  expect(parts.twins.unlinked.map(e => e.label)).toEqual(['Job']);
  // No edges from the builder at all: the order is the flow.
  expect(arrows(parts.plain)).toEqual(['0>1', '1>2']);
});

// Cursor on 30559d0: the right-hand end was cut at a comma or clause word
// before the exact compare, so a step whose own name had one got no arrow.
test('drawn by the real Mermaid, an end that is a whole step name links, and a trailing clause is still cut', async ({ page }) => {
  const file = await h.realMermaidFile();
  const S = (id, label) => ({ id, kind: 'process-step', label, detail: '' });
  const section = (id, kids) => ({ id, kind: 'section', label: id, children: [{ id: id + '-h', kind: 'heading', label: id }].concat(kids) });
  const tree = { id: 'screen', kind: 'screen', label: 'x', children: [
    section('clause', [S('c1', 'Start'), S('c2', 'Wait, then decide'), { id: 'ce', kind: 'edge', label: 'Next', detail: 'Start -> Wait, then decide' }]),
    section('ready', [S('r1', 'Start'), S('r2', 'Ready for launch'), { id: 're', kind: 'edge', label: 'Go', detail: 'Start -> Ready for launch' }]),
    section('bus', [S('b1', 'Gateway'), S('b2', 'Message bus'), { id: 'be', kind: 'edge', label: 'Turn request', detail: 'Gateway -> Message bus, on every turn' }]),
  ] };
  const calls = await h.load(page, '/experience/', { mermaid: 'real', realMermaidFile: file, events: [h.snapshot(tree)] });
  await h.startStudio(page, calls);
  for (const id of ['clause', 'ready', 'bus']) {
    await page.locator(`[data-pc-tab="${id}"]`).click();
    const svg = page.locator(`[data-pc-id="${id}"] [data-pc-flow-svg] svg`);
    await expect(svg).toHaveCount(1);
    // One labelled arrow: step -> label node -> step, so two edge paths, and no note chip.
    expect(await svg.locator('g.edgePaths path').count(), id).toBe(2);
    await expect(page.locator(`[data-pc-id="${id}"] [data-pc-edge-note]`)).toHaveCount(0);
  }
  const src = await page.locator('[data-pc-id="bus"] [data-pc-flow]').getAttribute('data-pc-flow-source');
  expect(src).toContain('  s0 --- e0["Turn request"] --> s1');
  const drawn = await page.locator('[data-pc-id="clause"] [data-pc-flow-svg] svg g.node').evaluateAll(drawnText);
  expect(drawn).toContain('Wait, then decide');
});

test('drawn by the real Mermaid, an unmatched edge shows as a note chip and adds no arrow', async ({ page }) => {
  const file = await h.realMermaidFile();
  const S = (id, label) => ({ id, kind: 'process-step', label, detail: 'What ' + label + ' does.' });
  const tree = { id: 'screen', kind: 'screen', label: 'x', children: [
    { id: 'mail', kind: 'section', label: 'm', children: [{ id: 'mh', kind: 'heading', label: 'Mail' },
      S('a1', 'A1'), S('bk', 'Backup'), S('em', 'Email'), { id: 'e', kind: 'edge', label: 'Send', detail: 'A -> Email' }] },
    { id: 'loop', kind: 'section', label: 'l', children: [{ id: 'lh', kind: 'heading', label: 'Loop' },
      S('wt', 'Wait'), S('st', 'Start'), { id: 'g', kind: 'edge', label: 'Go', detail: 'Start -> Wait, then decide' }] }] };
  const calls = await h.load(page, '/experience/', { mermaid: 'real', realMermaidFile: file, events: [h.snapshot(tree)] });
  await h.startStudio(page, calls);
  const svgIn = id => page.locator(`[data-pc-id="${id}"] [data-pc-flow-svg] svg`);
  await expect(svgIn('loop')).toHaveCount(1);
  expect(await svgIn('loop').locator('g.edgePaths path').count()).toBe(2);       // Start -> label -> Wait
  await page.locator('[data-pc-tab="mail"]').click();
  await expect(svgIn('mail')).toHaveCount(1);
  expect(await svgIn('mail').locator('g.edgePaths path').count()).toBe(0);
  const note = page.locator('[data-pc-edge-note="e"]');
  await expect(note).toHaveText('Send');
  await note.click();
  await expect(page.locator('[data-pc-id="mail"] [data-pc-flow-detail]'))
    .toHaveText('Send: A -> Email. Not drawn: its ends do not name two steps exactly.');
});

// Cursor's table on bda06c9: Mermaid 11.4.1 reads labels as Markdown even in
// strict mode. Against the real render, every box and every arrow label shows
// exactly the text the builder sent.
test('the real Mermaid draws every label as exactly the text sent, Markdown and URLs included', async ({ page }) => {
  const file = await h.realMermaidFile();
  const LABELS = ['_private_', '__init__', 'a _b_ c', 'http://evil.example/a', 'See https://sfdc24.com/x',
                  '1. Gateway', '- dash', 'www.example.com', 'snake_case_name', "it's (ok): 2+2; yes? no!"];
  const kids = [{ id: 'h', kind: 'heading', label: 'Labels' }];
  LABELS.forEach((l, i) => {
    kids.push({ id: 'n' + i, kind: 'process-step', label: l, detail: '' });
    kids.push({ id: 'x' + i, kind: 'process-step', label: 'To ' + i, detail: '' });
    kids.push({ id: 'e' + i, kind: 'edge', label: l, detail: l + ' -> To ' + i });
  });
  const tree = { id: 'screen', kind: 'screen', label: 'x', children: [{ id: 'md', kind: 'section', label: 'Labels', children: kids }] };
  const calls = await h.load(page, '/experience/', { mermaid: 'real', realMermaidFile: file, events: [h.snapshot(tree)] });
  await h.startStudio(page, calls);
  const svg = page.locator('[data-pc-id="md"] [data-pc-flow-svg] svg');
  await expect(svg).toHaveCount(1);
  const drawn = await svg.locator('g.node').evaluateAll(drawnText);
  for (const l of LABELS) {
    // Once as its step box, once as its arrow's label.
    expect(drawn.filter(t => t === l).length, l + ' in ' + JSON.stringify(drawn)).toBe(2);
  }
  expect(drawn.join(' ')).not.toContain('Unsupported markdown');
  expect(await svg.locator('em, strong, a, [href], [xlink\\:href]').count()).toBe(0);
});

test('nothing the builder sends becomes Mermaid syntax or markup (real Mermaid)', async ({ page }) => {
  const file = await h.realMermaidFile();
  const tree = { id: 'screen', kind: 'screen', label: 'x', children: [{ id: 'evil', kind: 'section', label: 'e', children: [
    { id: 'eh', kind: 'heading', label: 'Evil' },
    { id: 'a', kind: 'process-step', label: 'A"]; click s0 call alert(1); s9["', detail: '<img src=x onerror=alert(1)>' },
    { id: 'ea', kind: 'edge', label: 'x|"]-->s9{{"<b>', detail: 'A -> B' },
    { id: 'b', kind: 'process-step', label: '<script>alert(1)</script>%%{init: {"securityLevel":"loose"}}%%', detail: '' },
    { id: 'c', kind: 'process-step', label: '`markdown` **bold** #35; &amp; \\n end', detail: '' }] }] };
  const calls = await h.load(page, '/experience/', { mermaid: 'real', realMermaidFile: file, events: [h.snapshot(tree)] });
  await h.startStudio(page, calls);
  const svg = page.locator('[data-pc-id="evil"] [data-pc-flow-svg] svg');
  await expect(svg).toHaveCount(1);
  const src = await page.locator('[data-pc-id="evil"] [data-pc-flow]').getAttribute('data-pc-flow-source');
  for (const line of src.split('\n')) expect(line).toMatch(ALLOWED_LINE);
  expect(src).not.toMatch(/%%|<|`|#|&|\{|\}|\*/);
  // What is drawn is the allowlisted text, character for character.
  const drawn = await svg.locator('g.node').evaluateAll(drawnText);
  const allowed = await page.evaluate(ls => ls.map(l => window.SFDC24Canvas.flowLabel(l, 40)),
    ['A"]; click s0 call alert(1); s9["', '<script>alert(1)</script>%%{init: {"securityLevel":"loose"}}%%', '`markdown` **bold** #35; &amp; \\n end']);
  expect(drawn).toEqual(allowed);
  await expect(page.locator('img, [data-pc-diagram] script')).toHaveCount(0);
  expect(await svg.locator('script, a, [href], [onerror], [onclick], [onload]').count()).toBe(0);
  expect(await page.evaluate(() => window.mermaid && window.mermaid.mermaidAPI.getConfig().securityLevel)).toBe('strict');
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
