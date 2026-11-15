// 在临时桥接与隔离浏览器中操作真实 P7 页面，不连接 QQ/DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const h = await bridgeHarness({ config: { modes: { engine: { chat: true, reserved: true, reserved2: true } }, socialV2: { proactive: { enabled: false } } } });
h.setMode('chat');
fs.mkdirSync(`${h.temp}/src/features/console/web`, { recursive: true });
fs.copyFileSync(new URL('../src/features/console/web/console.html', import.meta.url), `${h.temp}/src/features/console/web/console.html`);
h.memoryPool.update(() => [{ id: 'test-one', kind: 'fact', conv_id: 'group:456', content: '浏览器记忆 <img src=x onerror=alert(1)>' }, { id: 'test-other', kind: 'fact', conv_id: 'group:789', content: '另一群' }]);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [], requests = [], failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    // 提示词源文件不属于此 UI 回归；避免读写安装侧预设。
    if (url.pathname.startsWith('/api/console/preset/')) return route.fulfill({ json: { ok: true, content: '', chars: 0, status: { installed: false }, backups: [] } });
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) failures.push(request.url()); });
  page.on('request', (request) => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) requests.push(path); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}/?classic=1&token=${h.cfg.consoleToken}`);
  await page.waitForFunction(() => document.getElementById('systemOverview').textContent.includes('DSH'));
  const navigate = (view) => page.locator(`#mainNav [data-view="${view}"]`).click();
  const save = async (id, path) => {
    const [response] = await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'POST'), page.locator(`#${id}`).click()]);
    const result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result)); return result;
  };
  assert.equal(await page.locator('#mainNav [data-view]').count(), 8);
  for (const view of ['overview','sessions','access','identity','memory','scheduler','usage','settings']) {
    await navigate(view);
    assert.equal(await page.locator(`[data-page="${view}"]:visible`).count() > 0, true);
  }
  console.log('PASS 八页导航与真实系统观测');
  await navigate('sessions');
  await page.locator('#overrideKey').fill('group:456');
  await page.locator('#overrideMode').selectOption('reserved2');
  await page.locator('#overridePreset').fill('qq-chat-v2');
  await save('overrideSave', '/api/console/conversations/set');
  assert.equal(h.modeForKey('group:456'), 'reserved2');
  await save('overrideDelete', '/api/console/conversations/delete');
  assert.equal(h.modeForKey('group:456'), 'chat');
  console.log('PASS 会话模式覆盖保存与恢复默认');
  await navigate('identity');
  await page.locator('#identityQq').fill('999');
  await page.locator('#identityGroup').fill('456');
  await page.locator('#identityName').fill('人工称呼');
  await page.locator('#identityAliases').fill('老王\n王同学');
  await save('identitySave', '/api/console/identity');
  assert.equal(h.identitySnapshot().people['999'].groups['456'].aliases.length, 3);
  await page.waitForFunction(() => document.getElementById('identityList').textContent.includes('manual'));
  console.log('PASS 人工称呼与别名真实落盘');
  await navigate('memory');
  await page.locator('#memoryKey').fill('group:456');
  await page.locator('#memoryLoad').click();
  await page.waitForSelector('[data-memory-id="test-one"]');
  assert.equal(await page.locator('#longMemoryList img').count(), 0);
  await page.locator('[data-memory-id="test-one"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-memory-id="test-one"]'));
  assert.equal(h.memoryPool.query()[0].id, 'test-other');
  console.log('PASS 记忆删除、会话隔离与输出转义');
  await navigate('settings');
  await page.waitForSelector('[data-architecture="gateV2"]');
  await page.locator('[data-architecture="gateV2"]').check();
  await save('architectureSave', '/api/console/settings');
  assert.equal(JSON.parse(fs.readFileSync(`${h.temp}/config.json`, 'utf8')).architecture.gateV2, true);
  assert.equal(h.cfg.architecture.gateV2, false);
  const before = fs.readFileSync(`${h.temp}/config.json`, 'utf8');
  await save('migrationPreview', '/api/console/migration');
  assert.equal(fs.readFileSync(`${h.temp}/config.json`, 'utf8'), before);
  const migrated = await save('migrationApply', '/api/console/migration');
  assert.equal(fs.existsSync(`${h.temp}/${migrated.backup}`), true);
  assert.equal(JSON.parse(fs.readFileSync(`${h.temp}/config.json`, 'utf8')).socialV2, undefined);
  console.log('PASS 开关待重启与配置预览/备份迁移');
  await navigate('usage');
  const details = page.locator('[data-v2-tool="getPrompt"]').locator('xpath=ancestor::details');
  await details.evaluate((node) => { node.open = true; });
  await page.locator('[data-v2-tool="getPrompt"]').uncheck();
  await save('toolPolicySave', '/api/console/scheduler/config');
  assert.equal(h.cfg.socialV2.tools.getPrompt, false);
  console.log('PASS 工具页面直接保存开关');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#consoleToast').waitFor({ state: 'hidden' });
  fs.mkdirSync('/tmp/p7-console-ui', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['overview','identity','memory','settings']) {
      await navigate(view);
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width + 1, `${view} 在 ${width}px 溢出：${JSON.stringify(size)}`);
      await page.screenshot({ path: `/tmp/p7-console-ui/${view}-${width}.png`, animations: 'disabled' });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert.ok(requests.every((path) => path.startsWith('/api/console/')));
  console.log('PASS 宽窄布局，无脚本错误或外连；前端请求统一 console 命名空间');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve)); await h.close();
}
