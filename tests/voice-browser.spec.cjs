const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Render the complete shipped page. Only browser speech/audio and the JSONP
// boundary are replaced; clicks, keyboard events, DOM and controller are real.
// Every request is intercepted, so these tests cannot contact the provider.
const html = fs.readFileSync(path.join(__dirname, '../voice/index.html'), 'utf8');

async function openVoice(page, { synchronousAbort = false } = {}) {
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://voice.test/voice/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.hostname === 'script.google.com' && url.searchParams.has('cb')) {
      requests.push(url);
      return route.fulfill({ contentType: 'application/javascript', body: '/* synthetic response pending */' });
    }
    return route.abort();
  });
  await page.addInitScript(({ synchronousAbort }) => {
    const probe = window.__voiceProbe = { starts: 0, aborts: 0, recognizers: [], spoken: [], audio: [] };
    class Recognition {
      constructor() { probe.recognizers.push(this); }
      start() { probe.starts++; }
      abort() { probe.aborts++; if (synchronousAbort && this.onend) this.onend(); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { value: Recognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: Recognition });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices() { return []; }, cancel() {},
      speak(utterance) { if (utterance.text.trim()) probe.spoken.push(utterance); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.Audio = class {
      constructor() { probe.audio.push(this); }
      play() { return Promise.resolve(); }
      pause() {}
    };
  }, { synchronousAbort });
  await page.goto('https://voice.test/voice/');
  await expect(page.locator('#stateword')).toHaveText('ready');
  return {
    requests,
    async counts() { return page.evaluate(() => ({ starts: __voiceProbe.starts, aborts: __voiceProbe.aborts })); },
    async result(text, final = false, index = -1) {
      await page.evaluate(({ text, final, index }) => {
        const result = [{ transcript: text }]; result.isFinal = final;
        __voiceProbe.recognizers.at(index).onresult({ resultIndex: 0, results: [result] });
      }, { text, final, index });
    },
    async end(index = -1) { await page.evaluate(index => __voiceProbe.recognizers.at(index).onend(), index); },
    async reply(text = 'A synthetic answer.') {
      await expect.poll(() => requests.filter(url => url.searchParams.get('action') === 'say').length).toBeGreaterThan(0);
      const url = requests.filter(url => url.searchParams.get('action') === 'say').at(-1);
      await page.evaluate(({ cb, text }) => window[cb]({ ok: true, reply: text }), { cb: url.searchParams.get('cb'), text });
    },
    async finishSpeech() { await page.evaluate(() => __voiceProbe.spoken.at(-1).onend()); },
    async clean() { expect(errors).toEqual([]); },
  };
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test.describe(`${viewport.width}px voice page`, () => {
    test.use({ viewport, serviceWorkers: 'block' });

    test('typed exchange and replay never start the microphone', async ({ page }) => {
      const h = await openVoice(page);
      await page.locator('#box').fill('Please explain the service.');
      await page.getByRole('button', { name: 'send', exact: true }).click();
      await expect(page.locator('#stateword')).toHaveText('thinking');
      await h.reply();
      await expect(page.locator('.turn.it.now .body')).toHaveText('A synthetic answer.');
      await h.finishSpeech();
      await page.getByRole('button', { name: /say that again/ }).click();
      await h.finishSpeech();
      await expect(page.getByRole('button', { name: 'Start talking', exact: true })).toBeVisible();
      expect((await h.counts()).starts).toBe(0);
      await h.clean();
    });

    test('draft input aborts capture and clearing the draft does not restart it', async ({ page }) => {
      const h = await openVoice(page);
      await page.getByRole('button', { name: 'Start talking', exact: true }).click();
      await h.result('Unfinished speech.');
      await expect(page.locator('.turn.live .body')).toHaveText('Unfinished speech.');
      await page.locator('#box').fill('I am typing now.');
      await expect(page.locator('#stateword')).toHaveText('ready');
      await expect(page.locator('.turn.live')).toHaveCount(0);
      expect(await h.counts()).toEqual({ starts: 1, aborts: 1 });
      await h.end();
      await page.locator('#box').fill('');
      await expect(page.locator('#send')).toBeDisabled();
      expect((await h.counts()).starts).toBe(1);
      expect(h.requests).toHaveLength(0);
      await h.clean();
    });

    for (const synchronousAbort of [false, true]) {
      test(`Stop clears interim text with ${synchronousAbort ? 'synchronous' : 'delayed'} abort`, async ({ page }) => {
        const h = await openVoice(page, { synchronousAbort });
        await page.getByRole('button', { name: 'Start talking', exact: true }).click();
        await h.result('Discard this interim text.');
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(page.locator('.turn.live')).toHaveCount(0);
        expect(await h.counts()).toEqual({ starts: 1, aborts: 1 });
        await page.getByRole('button', { name: 'Start talking', exact: true }).click();
        await h.result('The new interim text.');
        await h.end(0);
        await h.result('Stale text must not replace this.', false, 0);
        await expect(page.locator('.turn.live .body')).toHaveText('The new interim text.');
        expect((await h.counts()).starts).toBe(2);
        await h.clean();
      });
    }

    test('draft preserves the pending spoken answer and disables automatic listening', async ({ page }) => {
      const h = await openVoice(page);
      await page.getByRole('button', { name: 'Start talking', exact: true }).click();
      await h.result('A spoken question.', true);
      await h.end();
      await page.locator('#box').fill('The next draft.');
      await expect(page.locator('#stateword')).toHaveText('thinking');
      await expect(page.locator('#send')).toBeDisabled();
      await h.reply();
      await expect(page.locator('#stateword')).toHaveText('speaking');
      await expect(page.locator('#box')).toHaveValue('The next draft.');
      await expect(page.locator('#send')).toBeEnabled();
      await h.finishSpeech();
      await expect(page.locator('#stateword')).toHaveText('ready');
      expect((await h.counts()).starts).toBe(1);
      await h.clean();
    });

    test('Enter cannot submit a second request while the first answer is pending', async ({ page }) => {
      const h = await openVoice(page);
      await page.locator('#box').fill('The first question.');
      await page.locator('#box').press('Enter');
      await expect.poll(() => h.requests.length).toBe(1);
      await page.locator('#box').fill('Keep this draft until the reply arrives.');
      await expect(page.locator('#send')).toBeDisabled();
      await page.locator('#box').press('Enter');
      await expect(page.locator('#box')).toHaveValue('Keep this draft until the reply arrives.');
      expect(h.requests).toHaveLength(1);
      await h.reply('The first answer is preserved.');
      await expect(page.locator('.turn.it.now .body')).toHaveText('The first answer is preserved.');
      await expect(page.locator('#send')).toBeEnabled();
      await page.locator('#box').press('Enter');
      await expect.poll(() => h.requests.length).toBe(2);
      expect(h.requests[1].searchParams.get('q')).toBe('Keep this draft until the reply arrives.');
      expect((await h.counts()).starts).toBe(0);
      await h.clean();
    });
  });
}
