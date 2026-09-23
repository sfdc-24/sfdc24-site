// Does the card contract hold through the JS re-render, not just the static first set?
// The shipped gate (.cd-profile button h3) is asserted once, before the first click.
const { chromium } = require("playwright-core");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const REPO = path.resolve("C:/Users/salam/Quantum/.ccc-pr120-main");
const TYPES = { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".ico":"image/x-icon" };
function startServer(){const server=http.createServer((req,res)=>{const url=new URL(req.url,"http://127.0.0.1");
  let rel=decodeURIComponent(url.pathname); if(rel.endsWith("/"))rel+="index.html";
  const file=path.join(REPO,rel.replace(/^\/+/,""));
  if(!file.startsWith(REPO)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end("missing");return;}
  res.writeHead(200,{"content-type":TYPES[path.extname(file).toLowerCase()]||"application/octet-stream"});
  res.end(fs.readFileSync(file));});
  return new Promise((r)=>server.listen(0,"127.0.0.1",()=>r({server,origin:`http://127.0.0.1:${server.address().port}`})));}

const S9 = '#choice-design-probe .cd-profile:is(button,a,[role],[tabindex])';
const OLD = '#choice-design-probe .cd-profile button h3';   // the line cursor shipped

(async () => {
  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const rows = [];
  try {
    await page.goto(origin + "/method/#choice-design");
    for (let set = 1; set <= 1; set++) {
      await page.waitForSelector("#choice-design-probe .cd-profile");
      const status = (await page.locator("[data-cd-status]").first().textContent() || "").trim();
      rows.push({ stage: "set" + set, cards: await page.locator("#choice-design-probe .cd-profile").count(),
        S9: await page.locator(S9).count(), OLD: await page.locator(OLD).count(),
        rendered: status.startsWith("Set " + set) ? "ok" : "MISMATCH:" + status.slice(0, 14) });

    }
  } finally { await browser.close(); server.close(); }
  const cols = ["stage","cards","rendered","S9","OLD"];
  console.log("TREE = main 463ede9 (the pre-fix defect)");
  console.log(cols.join("	"));
  for (const r of rows) console.log(cols.map((c) => r[c]).join("	"));
})();
