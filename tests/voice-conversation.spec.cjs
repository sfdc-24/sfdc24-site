const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = 'https://sfdc24.test/voice/';
const HTML = fs.readFileSync(path.join(__dirname, '..', 'voice', 'index.html'), 'utf8');

async function fixture(page, replies, options = {}) {
  const requests = [];
  await page.addInitScript(({ blockedStorage }) => {
    // No microphone, operating-system speech or paid audio is used by this suite.
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined });
    Object.defineProperty(window, 'speechSynthesis', { value: undefined });
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
    if (blockedStorage) {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage disabled', 'SecurityError'); }
      });
    }
  }, { blockedStorage: Boolean(options.blockedStorage) });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(PAGE).origin) {
      await route.fulfill({ contentType: 'text/html', body: HTML });
      return;
    }
    if (url.hostname === 'script.google.com' && url.searchParams.get('action') === 'say') {
      requests.push(Object.fromEntries(url.searchParams));
      const reply = replies[requests.length - 1];
      if (!reply) { await route.abort(); return; }
      const response = typeof reply === 'function' ? await reply() : reply;
      await route.fulfill({ contentType: 'application/javascript',
        body: `${url.searchParams.get('cb')}(${JSON.stringify(response)});` });
      return;
    }
    // Fonts and every unrecognised request are blocked. Nothing reaches Google
    // or an external provider, including on an accidental endpoint change.
    await route.abort();
  });
  await page.goto(PAGE);
  return requests;
}

async function send(page, text) {
  await page.getByRole('textbox', { name: 'Type a message' }).fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.locator('#stateword')).toHaveText('ready');
}

test('retains a returned conversation across replies and a reload, including a failed provider reply', async ({ page }) => {
  const requests = await fixture(page, [
    { ok: true, reply: 'First response', ct: 'fixture-conversation-one' },
    { ok: false, ct: 'fixture-conversation-replacement' },
    { ok: true, reply: 'Recovered', ct: 'fixture-conversation-replacement' }
  ]);
  await send(page, 'First turn');
  await expect(page.locator('#tape')).toContainText('First response');
  await send(page, 'Second turn');
  await expect(page.locator('#tape')).toContainText('couldn’t reach the assistant');
  await page.reload();
  await send(page, 'Third turn');
  expect(requests.map(r => r.ct || '')).toEqual([
    '', 'fixture-conversation-one', 'fixture-conversation-replacement'
  ]);
  expect(requests.every(r => !('vid' in r) && !('sid' in r))).toBe(true);
});

test('uses the replacement conversation after a signed-in session change', async ({ page }) => {
  const requests = await fixture(page, [
    { ok: true, reply: 'Anonymous', ct: 'fixture-anonymous' },
    { ok: true, reply: 'Signed in', ct: 'fixture-subject-b' },
    { ok: true, reply: 'Same subject', ct: 'fixture-subject-b' }
  ]);
  await send(page, 'Before sign in');
  // A real OAuth round-trip creates a new document, unlike hash-only navigation.
  await page.goto(PAGE + '?auth-return=1#s=fixture-auth-b');
  await send(page, 'After sign in');
  await send(page, 'Next signed-in turn');
  expect(requests.map(r => [r.s || '', r.ct || ''])).toEqual([
    ['', ''], ['fixture-auth-b', 'fixture-anonymous'], ['fixture-auth-b', 'fixture-subject-b']
  ]);
  expect(new URL(page.url()).hash).toBe('');
});

test('retains conversation identity in memory when browser storage is unavailable', async ({ page }) => {
  const requests = await fixture(page, [
    { ok: true, reply: 'First', ct: 'fixture-memory-only' },
    { ok: true, reply: 'Second', ct: 'fixture-memory-only' }
  ], { blockedStorage: true });
  await send(page, 'First turn');
  await send(page, 'Second turn');
  expect(requests.map(r => r.ct || '')).toEqual(['', 'fixture-memory-only']);
});

test('Enter during a pending turn preserves the draft and sends it only after the first identity arrives', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const requests = await fixture(page, [
    () => pending,
    { ok: true, reply: 'Second response', ct: 'fixture-established' }
  ]);
  const input = page.getByRole('textbox', { name: 'Type a message' });
  const button = page.getByRole('button', { name: 'send', exact: true });
  await input.fill('First turn');
  await input.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  await input.fill('Keep this draft');
  await expect(button).toBeDisabled();
  await expect(page.locator('#mic')).toBeDisabled();
  await input.press('Enter');
  try {
    await expect(input).toHaveValue('Keep this draft');
    expect(requests).toHaveLength(1);
  } finally {
    release({ ok: true, reply: 'First response', ct: 'fixture-established' });
  }
  await expect(page.locator('#stateword')).toHaveText('ready');
  await expect(button).toBeEnabled();
  await expect(page.locator('#mic')).toBeEnabled();
  await button.click();
  await expect(page.locator('#tape')).toContainText('Second response');
  expect(requests.map(r => [r.q, r.ct || ''])).toEqual([
    ['First turn', ''], ['Keep this draft', 'fixture-established']
  ]);
});
