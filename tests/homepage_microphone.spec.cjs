// Real homepage DOM; synthetic recognizer, no physical microphone or backend.
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const HOME = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

async function load(page) {
  await page.route(/^https?:/, route => route.abort());
  await page.clock.install();
  await page.addInitScript(() => {
    window.testRecognizers = [];
    window.SpeechRecognition = class {
      constructor() { window.testRecognizers.push(this); }
      start() { this.onstart?.(); }
      abort() { this.aborted = true; this.onend?.(); }
    };
    window.sayForTest = (segments, resultIndex = 0) => {
      const rec = window.testRecognizers.at(-1);
      rec.onresult({ resultIndex, results: segments.map(([transcript, isFinal]) =>
        Object.assign([{ transcript }], { isFinal })) });
    };
  });
  await page.goto(HOME);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

for (const width of [390, 1280]) {
  test(`homepage microphone accumulates phrases until a pause (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await load(page);
    expect(await page.evaluate(() => testRecognizers.length)).toBe(0);
    await page.locator('#mic').click();
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => sayForTest([['I need automation', true]]));
    await page.clock.fastForward(2000);
    await expect(page.locator('#box')).toHaveValue('I need automation');
    await page.evaluate(() => sayForTest([['I need automation', true], ['for case', false]], 1));
    await page.clock.fastForward(5000);
    await expect(page.locator('#box')).toHaveValue('I need automation for case');
    await page.evaluate(() => sayForTest([['I need automation', true], ['for case routing', true]], 1));
    await page.clock.fastForward(2499);
    await expect(page.locator('#box')).toHaveValue('I need automation for case routing');
    await page.clock.fastForward(1);
    await expect(page.locator('#box')).toHaveValue('');
    await expect(page.locator('#tape')).toContainText('I need automation for case routing');
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => testRecognizers[0].aborted)).toBe(true);
  });

  test(`homepage stop and typing cancel capture without losing draft (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await load(page);
    await page.locator('#mic').click();
    await page.evaluate(() => sayForTest([['Keep my words', true]]));
    await page.locator('#mic').click();
    await page.clock.fastForward(6000);
    await expect(page.locator('#box')).toHaveValue('Keep my words');
    expect(await page.evaluate(() => testRecognizers.length)).toBe(1);
    await page.locator('#mic').click();
    await page.locator('#box').fill('Edited question');
    await page.clock.fastForward(6000);
    await expect(page.locator('#box')).toHaveValue('Edited question');
    expect(await page.evaluate(() => testRecognizers[1].aborted)).toBe(true);
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false');
  });
}
