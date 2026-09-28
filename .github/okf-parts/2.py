    "assert.match(view.cooking, /Living OKF hub on Ops for packs, how we work, and release links\\./);\n  assert.doesNotMatch(view.cooking, /Conference Line/);",
)
must(
    "tests/board_ops.cjs",
    "assert.match(view.pipeline, /Conference Line LiveKit spike/);\n  assert.doesNotMatch(view.pipeline, /—|branch\\/PR/);",
    "assert.match(view.pipeline, /branch \\/ PR/);\n  assert.doesNotMatch(view.pipeline, /PR #224/);\n  assert.doesNotMatch(view.pipeline, /—|branch\\/PR/);",
)
must(
    "tests/board_ops.cjs",
    "assert.match(roleView.engine, /PM &amp; test lead/);",
    "assert.match(roleView.engine, /Fleet PM/);\n  assert.match(roleView.engine, /Delivery Director/);",
)
must(
    "tests/board_ops.cjs",
    "assert.match(view.sprint, /Conference Line LiveKit spike/);",
    "assert.match(view.sprint, /Living OKF hub/);\n  assert.doesNotMatch(view.sprint, /Conference Line/);\n  assert.match(view.backlog, /Conference Line LiveKit spike on the shared room contract\\./);",
)
must(
    "tests/header-release.spec.cjs",
    "  await expect(page.locator('#release')).toContainText('PROD');\n  await expect(page.locator('header #nextDeploy')).toHaveCount(0);",
    """  await expect(page.locator('#release')).toContainText('PROD');
  await expect(page.locator('#okf-hub')).toBeVisible();
  await expect(page.locator('#okf-hub')).toContainText('okf=packs');
  await expect(page.locator('#okf-hub')).toContainText('okf=how-we-work');
  await expect(page.locator('#okf-hub')).toContainText('okf=cooking');
  await expect(page.locator('#okf-hub')).toContainText('okf=release');
  await expect(page.locator('#okf-hub')).toContainText('okf=workstreams');
  await expect(page.locator('#agent-lanes')).toContainText('Delivery Director');
  await expect(page.locator('#agent-lanes')).toContainText('Fleet PM');
  await expect(page.locator('#release-mount')).toContainText('Living OKF hub on Ops for packs');
