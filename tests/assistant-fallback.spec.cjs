const { test, expect } = require("@playwright/test");
const { createServer } = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let server;
let baseUrl;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      var pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      var target = path.resolve(ROOT, "." + pathname);
      if (!target.startsWith(ROOT + path.sep) && target !== ROOT) throw new Error("outside root");
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      var body = await readFile(target);
      response.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function healthyAssistant() {
  return `<!doctype html><html><body>
    <label>Stub composer <textarea></textarea></label>
    <script>
      const nonce = new URL(location.href).searchParams.get("ready_nonce");
      top.postMessage({ type: "sfdc24:assistant-ready", version: 1, nonce }, "*");
    </script>
  </body></html>`;
}

for (const scenario of [
  { name: "mobile network abort", viewport: { width: 320, height: 568 }, failure: "abort" },
  { name: "desktop Google error document", viewport: { width: 1280, height: 800 }, failure: "error-document" }
]) {
  test(scenario.name + " exposes recovery and a healthy retry", async ({ page }) => {
    await page.setViewportSize(scenario.viewport);
    await page.addInitScript(() => { window.__SFDC24_ASSISTANT_TIMEOUT_MS = 60; });

    let assistantRequests = 0;
    await page.route("https://script.google.com/**", async (route) => {
      assistantRequests += 1;
      if (assistantRequests === 1 && scenario.failure === "abort") {
        await route.abort("failed");
        return;
      }
      if (assistantRequests === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>Google error</title><p>Sorry, unable to open the file at this time.</p>"
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "text/html", body: healthyAssistant() });
    });

    await page.goto(baseUrl + "/");
    await expect(page.getByTestId("assistant-state-label")).toHaveText("The assistant is unavailable right now.");
    await expect(page.getByTestId("assistant-retry")).toBeVisible();
    await expect(page.locator(".assistant-actions a")).toHaveAttribute("href", "mailto:abdus@sfdc24.com");

    await page.getByTestId("assistant-retry").click();
    await expect(page.frameLocator("[data-testid='assistant-frame']").getByLabel("Stub composer")).toBeVisible();
    await expect(page.getByTestId("assistant-state-label")).toBeHidden();
    await expect(page.getByTestId("assistant-frame")).not.toHaveAttribute("aria-hidden", "true");
    expect(assistantRequests).toBe(2);
  });
}

test("a delayed ready signal shows recovery first and then recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { window.__SFDC24_ASSISTANT_TIMEOUT_MS = 50; });
  await page.route("https://script.google.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body><label>Delayed composer <textarea></textarea></label>
        <script>
          const nonce = new URL(location.href).searchParams.get("ready_nonce");
          setTimeout(() => top.postMessage({ type: "sfdc24:assistant-ready", version: 1, nonce }, "*"), 180);
        </script></body></html>`
    });
  });

  await page.goto(baseUrl + "/");
  await expect(page.getByTestId("assistant-state-label")).toHaveText("The assistant is unavailable right now.");
  await expect(page.frameLocator("[data-testid='assistant-frame']").getByLabel("Delayed composer")).toBeVisible();
  await expect(page.getByTestId("assistant-state-label")).toBeHidden();
});

test("a ready-shaped message with the wrong nonce is rejected", async ({ page }) => {
  await page.addInitScript(() => { window.__SFDC24_ASSISTANT_TIMEOUT_MS = 50; });
  await page.route("https://script.google.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><script>
        top.postMessage({ type: "sfdc24:assistant-ready", version: 1, nonce: "not-the-parent-nonce" }, "*");
      </script>`
    });
  });

  await page.goto(baseUrl + "/");
  await expect(page.getByTestId("assistant-state-label")).toHaveText("The assistant is unavailable right now.");
  await expect(page.getByTestId("assistant-frame")).toHaveAttribute("aria-hidden", "true");
});
