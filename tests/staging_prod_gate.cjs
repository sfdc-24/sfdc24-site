#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.join(__dirname, "..");
const SKIP_NETWORK = process.env.SKIP_NETWORK === "1";

const STAGING_URL =
  process.env.STAGING_URL ||
  "https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/index.html";
const PROD_URL = process.env.PROD_URL || "https://www.sfdc24.com/";

/**
 * Labeled thresholds (ms). Cold CDN first-hit can be slow; warm should be well under.
 * Fail closed: exceeding these blocks promote.
 */
const THRESHOLDS = {
  STAGING_TTFB_MAX_MS: Number(process.env.STAGING_TTFB_MAX_MS || 5000),
  PROD_TTFB_MAX_MS: Number(process.env.PROD_TTFB_MAX_MS || 3000),
  HTTP_OK: 200,
};

/**
 * Required GitHub check contexts (job `name:`) that must exist in .github/workflows.
 * Sourced from overnight ruleset wiring comments (ruleset 23679990) + site doctrine
 * "six required checks". Fail closed if any string is absent from workflow YAML.
 */
const REQUIRED_CHECK_NAMES = [
  "honesty-dom-test / dom",
  "site-positioning-test / test",
  "homepage-recovery-test / test",
  "intake-contract / intake",
  "xray-page-test / test",
  "site-manifest / test",
];

/** Present-tense live-org claim phrases - inventing these blocks the gate. */
const LIVE_ORG_CLAIM_RES = [
  /scores?\s+a\s+live\s+org/i,
  /reading\s+your\s+(live\s+)?org/i,
  /connected\s+to\s+your\s+(salesforce\s+)?org/i,
  /scans?\s+your\s+(live\s+)?org/i,
  /pulls?\s+from\s+your\s+(salesforce\s+)?org/i,
  /imports?\s+metadata\s+from\s+live\s+customer/i,
  /grades?\s+your\s+production\s+(salesforce\s+)?org/i,
];

const LOCAL_FIRST_MARKERS = [
  {
    file: "assets/local-first-boot.js",
    mustInclude: ["__localFirstWrapped", "__postLocalAsk", "__TRIAGE"],
  },
  {
    file: "index.html",
    mustInclude: ["local-first-boot.js", "local-first"],
  },
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function listWorkflowYaml() {
  const dir = path.join(ROOT, ".github", "workflows");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

function extractGreetingAnswer(triageSrc) {
  const re =
    /"id"\s*:\s*"greeting"[\s\S]{0,400}?"answer"\s*:\s*"((?:\\.|[^"\\])*)"/;
  const m = triageSrc.match(re);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  // Python single-quoted form
  const rePy =
    /"id"\s*:\s*"greeting"[\s\S]{0,400}?"answer"\s*:\s*'((?:\\.|[^'\\])*)'/;
  const m2 = triageSrc.match(rePy);
  return m2 ? m2[1] : null;
}

async function measureTtfb(url, label) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "sfdc24-staging-prod-gate/1.0" },
  });
  const ttfbMs = performance.now() - t0;
  const body = await res.text();
  const totalMs = performance.now() - t0;
  return {
    label,
    url,
    status: res.status,
    ttfbMs,
    totalMs,
    body,
  };
}

function scanLiveOrgClaims(text, surface) {
  const hits = [];
  for (const rx of LIVE_ORG_CLAIM_RES) {
    const m = text.match(rx);
    if (m) hits.push({ surface, phrase: m[0] });
  }
  return hits;
}

async function runGate() {
  const failures = [];
  const notes = [];
  const started = performance.now();

  notes.push("THRESHOLDS " + JSON.stringify(THRESHOLDS));
  notes.push("REQUIRED_CHECK_NAMES " + JSON.stringify(REQUIRED_CHECK_NAMES));

  const yamlBlob = listWorkflowYaml();
  if (!yamlBlob) {
    failures.push("required-checks: .github/workflows missing or empty (fail closed)");
  } else {
    for (const name of REQUIRED_CHECK_NAMES) {
      if (!yamlBlob.includes(name)) {
        failures.push(`required-checks: missing job name "${name}"`);
      } else {
        notes.push(`required-checks: OK "${name}"`);
      }
    }
  }

  // ---- 2) Local-first markers ----
  for (const marker of LOCAL_FIRST_MARKERS) {
    if (!exists(marker.file)) {
      failures.push(`local-first: missing ${marker.file}`);
      continue;
    }
    const text = read(marker.file);
    for (const needle of marker.mustInclude) {
      if (!text.includes(needle)) {
        failures.push(`local-first: ${marker.file} missing marker "${needle}"`);
      } else {
        notes.push(`local-first: OK ${marker.file} :: ${needle}`);
      }
    }
  }

  // ---- 3) No SFDC24 greeting spam ----
  const triageCandidates = ["assets/triage.js", "assets/triage.py"].filter(exists);
  if (!triageCandidates.length) {
    failures.push("greeting: triage.js/py not found (fail closed)");
  } else {
    for (const rel of triageCandidates) {
      const src = read(rel);
      const answer = extractGreetingAnswer(src);
      if (!answer) {
        failures.push(`greeting: could not parse greeting answer from ${rel}`);
        continue;
      }
      notes.push(`greeting: ${rel} answer=${JSON.stringify(answer)}`);
      if (/SFDC24/i.test(answer)) {
        failures.push(
          `greeting: SFDC24 brand spam in greeting answer (${rel}): ${JSON.stringify(answer)}`,
        );
      }
      if (answer.length > 80) {
        failures.push(
          `greeting: answer too long (${answer.length} chars) - looks like spam/pitch, not a greeting (${rel})`,
        );
      }
    }
  }

  const honestySurfaces = [
    "index.html",
    "method/index.html",
    "xray/index.html",
    "assets/triage.js",
    "assets/triage.py",
  ].filter(exists);
  for (const rel of honestySurfaces) {
    const hits = scanLiveOrgClaims(read(rel), rel);
    for (const h of hits) {
      failures.push(`honesty: live-org claim on ${h.surface}: "${h.phrase}"`);
    }
    if (!hits.length) notes.push(`honesty: OK local ${rel}`);
  }

  // ---- 5) Speed smoke: staging + prod TTFB ----
  if (SKIP_NETWORK) {
    notes.push("speed: SKIP_NETWORK=1 - network smoke skipped (file checks only)");
  } else {
    const fetches = await Promise.all([
      measureTtfb(STAGING_URL, "staging"),
      measureTtfb(PROD_URL, "prod"),
    ]);
    for (const f of fetches) {
      const max =
        f.label === "staging"
          ? THRESHOLDS.STAGING_TTFB_MAX_MS
          : THRESHOLDS.PROD_TTFB_MAX_MS;
      notes.push(
        `speed: ${f.label} status=${f.status} ttfb_ms=${f.ttfbMs.toFixed(1)} total_ms=${f.totalMs.toFixed(1)} max_ms=${max} url=${f.url}`,
      );
      if (f.status !== THRESHOLDS.HTTP_OK) {
        failures.push(`speed: ${f.label} HTTP ${f.status} (want ${THRESHOLDS.HTTP_OK})`);
      }
      if (f.ttfbMs > max) {
        failures.push(
          `speed: ${f.label} TTFB ${f.ttfbMs.toFixed(1)}ms > ${max}ms (labeled threshold)`,
        );
      }
      // Honesty on fetched staging body too
      if (f.label === "staging" && f.body) {
        const hits = scanLiveOrgClaims(f.body, "staging-live:index.html");
        for (const h of hits) {
          failures.push(`honesty: live-org claim on ${h.surface}: "${h.phrase}"`);
        }
        if (!/sfdc24-staging-banner|STAGING/i.test(f.body)) {
          failures.push("staging: missing STAGING banner in published staging-live HTML");
        } else {
          notes.push("staging: OK STAGING banner present");
        }
        if (!/noindex/i.test(f.body)) {
          failures.push("staging: missing noindex on staging-live HTML");
        } else {
          notes.push("staging: OK noindex present");
        }
        if (/SFDC24[^.]{0,40}(hi|hello|hey)/i.test(f.body) && /greeting/i.test(f.body)) {
          notes.push("staging: homepage HTML does not inline greeting answer (expected)");
        }
      }
    }

    try {
      const triageUrl = STAGING_URL.replace(/index\.html(?:\?.*)?$/, "assets/triage.js");
      const t = await measureTtfb(triageUrl, "staging-triage");
      notes.push(
        `speed: staging-triage status=${t.status} ttfb_ms=${t.ttfbMs.toFixed(1)}`,
      );
      if (t.status === 200) {
        const answer = extractGreetingAnswer(t.body);
        if (answer && /SFDC24/i.test(answer)) {
          failures.push(
            `greeting: published staging triage greeting spam: ${JSON.stringify(answer)}`,
          );
        } else if (answer) {
          notes.push(`greeting: staging-live triage OK ${JSON.stringify(answer)}`);
        }
        const hits = scanLiveOrgClaims(t.body, "staging-live:assets/triage.js");
        for (const h of hits) {
          failures.push(`honesty: live-org claim on ${h.surface}: "${h.phrase}"`);
        }
      } else {
        failures.push(`speed: staging triage.js HTTP ${t.status} (fail closed)`);
      }
    } catch (e) {
      failures.push(`speed: staging triage.js fetch error: ${e.message}`);
    }
  }

  const elapsedMs = performance.now() - started;
  const ok = failures.length === 0;

  const report = {
    ok,
    gate: "staging-prod-gate",
    board_id: "CODEX-STAGE-GATE-001",
    elapsed_ms: Number(elapsedMs.toFixed(1)),
    thresholds: THRESHOLDS,
    required_check_names: REQUIRED_CHECK_NAMES,
    staging_url: STAGING_URL,
    prod_url: PROD_URL,
    failures,
    notes,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log(
    ok
      ? `\nstaging-prod-gate: PASS (${elapsedMs.toFixed(0)}ms wall)`
      : `\nstaging-prod-gate: FAIL (${failures.length} issue(s), ${elapsedMs.toFixed(0)}ms wall)`,
  );
  return ok ? 0 : 1;
}

if (require.main === module) {
  runGate()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("staging-prod-gate: FATAL", err);
      process.exit(2);
    });
}

module.exports = {
  runGate,
  REQUIRED_CHECK_NAMES,
  THRESHOLDS,
  LIVE_ORG_CLAIM_RES,
  extractGreetingAnswer,
  scanLiveOrgClaims,
};
