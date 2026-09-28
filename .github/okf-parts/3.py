  await expect(page.locator('#release-mount')).not.toContainText('Conference Line');
  const above = await page.evaluate(() => {
    const hub = document.getElementById('okf-hub').getBoundingClientRect();
    const roster = document.getElementById('agent-lanes').getBoundingClientRect();
    return { hubTop: hub.top, rosterTop: roster.top, view: window.innerHeight };
  });
  expect(above.hubTop).toBeLessThan(above.view);
  expect(above.rosterTop).toBeLessThan(above.view);
  await expect(page.locator('header #nextDeploy')).toHaveCount(0);""",
)
must(
    "tests/ops_gantt.cjs",
    """test('delivery overview mounts before the existing release and agent lanes',()=>{
  const page=fs.readFileSync(path.join(__dirname,'../ops/index.html'),'utf8');
  const mount=page.indexOf('id="delivery-gantt"');
  assert.ok(mount>=0);
  assert.ok(mount<page.indexOf('id="release"'));
  assert.ok(mount<page.indexOf('id="agent-lanes"'));
  assert.match(page,/\\/assets\\/ops-gantt\\.js/);
});""",
    """test('delivery overview stays on the page after the OKF hub, roster, and release lights',()=>{
  const page=fs.readFileSync(path.join(__dirname,'../ops/index.html'),'utf8');
  const mount=page.indexOf('id="delivery-gantt"');
  assert.ok(mount>=0);
  assert.ok(page.indexOf('id="okf-hub"')<page.indexOf('id="agent-lanes"'));
  assert.ok(page.indexOf('id="agent-lanes"')<page.indexOf('id="release"'));
  assert.ok(page.indexOf('id="release"')<mount);
  assert.match(page,/\\/assets\\/ops-gantt\\.js/);
});""",
)
