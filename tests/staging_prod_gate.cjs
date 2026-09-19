#!/usr/bin/env node
'use strict';

/**
 * Codex-lane staging→prod gatecheck module (ALL-HANDS-001).
 * Preferred owner: Codex. Lightweight backup may run from CI/local free.
 *
 * Staging URL (documented):
 *   https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/
 * Purge:
 *   https://purge.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/index.html
 * Production:
 *   https://www.sfdc24.com/
 *
 * Run: node tests/staging_prod_gate.cjs
 */

const DOCUMENTED_STAGING_URL =
  'https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/';
const DOCUMENTED_PROD_URL = 'https://www.sfdc24.com/';

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function evaluateStagingProdGate(input = {}) {
  const errors = [];
  const warnings = [];

  if (!nonempty(input.ref)) errors.push('staging ref is required');
  if (input.ref === 'main' || input.ref === 'master') {
    errors.push('production ref cannot be used as staging input');
  }
  if (!nonempty(input.sha) || String(input.sha).length < 7) {
    errors.push('immutable source SHA is required');
  }
  if (!nonempty(input.stagingUrl)) errors.push('staging URL is required');
  if (
    nonempty(input.stagingUrl) &&
    input.stagingUrl.includes('www.sfdc24.com') &&
    !input.stagingUrl.includes('/staging')
  ) {
    errors.push('staging URL must not be bare production www.sfdc24.com');
  }
  if (!input.stagingBanner) errors.push('STAGING banner check failed');
  if (!input.noindex) errors.push('noindex check failed');
  if (!input.publicReadback) errors.push('public read-back is required');
  if (!input.secretScan) errors.push('secret scan is required');
  if (input.liveOrgClaims === true) {
    errors.push('present-tense live-org claim phrases must be absent on staging');
  }
  if (input.forcePush) warnings.push('force-push is enabled; require an explicit operator gate');
  if (input.approval !== true) warnings.push('production approval is not recorded');
  if (input.stagingUrl === DOCUMENTED_PROD_URL) {
    errors.push('staging URL equals production URL');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    documentedStagingUrl: DOCUMENTED_STAGING_URL,
    documentedProdUrl: DOCUMENTED_PROD_URL,
  };
}

if (require.main === module) {
  const pass = evaluateStagingProdGate({
    ref: 'staging',
    sha: 'a'.repeat(40),
    stagingUrl: DOCUMENTED_STAGING_URL,
    stagingBanner: true,
    noindex: true,
    publicReadback: true,
    secretScan: true,
    liveOrgClaims: false,
    approval: false,
    forcePush: false,
  });
  if (!pass.ok) throw new Error(JSON.stringify(pass));
  const fail = evaluateStagingProdGate({
    ref: 'main',
    sha: '',
    stagingUrl: DOCUMENTED_PROD_URL,
    stagingBanner: false,
    liveOrgClaims: true,
  });
  if (fail.ok || fail.errors.length < 4) {
    throw new Error('negative gate case did not fail hard enough: ' + JSON.stringify(fail));
  }
  console.log('staging_prod_gate: PASS (positive and negative cases)');
  console.log('documentedStagingUrl=' + DOCUMENTED_STAGING_URL);
}

module.exports = { evaluateStagingProdGate, DOCUMENTED_STAGING_URL, DOCUMENTED_PROD_URL };
