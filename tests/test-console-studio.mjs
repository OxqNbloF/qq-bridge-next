// 真桥接路由与浏览器 UI；所有上游为隔离桩，不连接 QQ/DSH。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { bridgeHarness } from "./audit-bridge-harness.mjs";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const h = await bridgeHarness({
  config: {
    modes: { engine: { chat: true, reserved: true, reserved2: true } },
    socialV2: { proactive: { enabled: false } },
  },
});
h.setReady(true);
h.setMode("chat");
const directory = `${h.temp}/src/features/console/web`;
fs.cpSync(new URL("../src/features/console/web", import.meta.url), directory, { recursive: true });
const server = h.startConsoleServer();
if (!server.listening)
  await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const headers = {
  "content-type": "application/json",
  "x-console-token": h.cfg.consoleToken,
};
const call = async (body, extra = {}) => {
  const response = await fetch(`${base}/api/console/session/stop`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
try {
  assert.equal(
    (await call({ key: "group:456" }, { "x-console-token": "" })).status,
    401,
  );
  assert.equal(
    (await call({ key: "group:456" }, { "x-agent-token": "untrusted" })).status,
    403,
  );
  for (const key of [
    null,
    {},
    "__proto__",
    "constructor",
    "arbitrary-dsh-id",
    "group:999",
  ])
    assert.equal((await call({ key })).status, 404);
  const sessionId = await h.ensureSession("group:456");
  h.setReady(false);
  assert.equal((await call({ key: "group:456" })).status, 503);
  h.setReady(true);
  assert.equal((await call({ key: "group:456" })).status, 200);
  assert.ok(h.calls.cancelled.includes(sessionId));
  assert.equal(h.state.sessions["group:456"], sessionId, "停止不删除会话映射");
  const stop = h.api.stopSessionWork;
  h.api.stopSessionWork = async () => {
    throw new Error("upstream failure");
  };
  assert.equal((await call({ key: "group:456" })).status, 502);
  h.api.stopSessionWork = stop;
  console.log("PASS 停止任务鉴权、隔离、不可用、上游失败与会话保留");
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(8000);
  const errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== base) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${base}/?token=${h.cfg.consoleToken}`);
  await page.waitForFunction(
    () => document.getElementById("dshMetric").textContent === "已连接",
  );
  assert.equal(new URL(page.url()).searchParams.has("token"), false);
  const nav = (view) => page.locator(`[data-view="${view}"]`).click();
  const submit = async (id, path) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === path && r.request().method() === "POST",
      ),
      page.locator(`#${id} [type=submit]`).click(),
    ]);
    assert.equal(response.status(), 200, JSON.stringify(await response.json()));
  };
  await nav("parameters");
  await page.locator('[data-group="wake"]').click();
  await page.locator('[data-path="wake.batchWindowMs"]').fill("9100");
  await submit("parametersForm", "/api/console/scheduler/config");
  assert.equal(h.cfg.socialV2.wake.batchWindowMs, 9100);
  await page.locator('[data-group="voice"]').click();
  assert.equal(await page.locator('[data-path="voice.ffmpegPath"]').count(), 0);
  await submit("parametersForm", "/api/console/scheduler/config");
  await page.locator('[data-group="tools"]').click();
  await page.locator('[data-path="tools.getPrompt"]').uncheck();
  await submit("parametersForm", "/api/console/scheduler/config");
  assert.equal(h.cfg.socialV2.tools.getPrompt, false);
  console.log("PASS 参数热更新、工具权限与本机路径边界");
  await nav("desk");
  await page.locator("#target").fill("group:456");
  await page.locator("#command").fill("测试后台指令");
  await submit("commandForm", "/api/console/notify-ai");
  assert.ok(
    h.calls.prompts.some((p) =>
      JSON.stringify(p.content).includes("测试后台指令"),
    ),
  );
  await page.locator("#stop").click();
  await page.waitForFunction(
    () =>
      document.getElementById("notice").textContent.includes("当前任务已停止"),
    null,
    { timeout: 8000 },
  );
  await page.locator("#pause").click();
  await page.waitForFunction(() =>
    document.getElementById("pause").textContent.includes("恢复"),
  );
  assert.equal(h.socialV2.paused, true);
  console.log("PASS DSH 指令投递、停止与暂停调度");
  await nav("sessions");
  await page.locator("#overrideKey").fill("group:456");
  await page.locator("#overrideMode").selectOption("reserved2");
  await page.locator("#overridePreset").fill("qq-chat-v2");
  await submit("overrideForm", "/api/console/conversations/set");
  assert.equal(h.modeForKey("group:456"), "reserved2");
  assert.equal(
    h.listConversationOverrides().conversations["group:456"].preset,
    "qq-chat-v2",
  );
  await nav("persona");
  await page.locator("#roleName").fill("界面测试");
  await page.locator("#roleContent").fill("简洁回答。");
  await submit("roleForm", "/api/console/roles/create");
  await page.waitForFunction(
    () => document.querySelector("#rolePick").value === "界面测试",
  );
  await page.locator("#activateRole").click();
  await page.waitForFunction(() =>
    document.getElementById("notice").textContent.includes("当前角色已切换"),
  );
  h.memoryPool.update(() => [
    {
      id: "xss",
      kind: "fact",
      conv_id: "group:456",
      content: "<img src=x onerror=alert(1)>",
    },
  ]);
  await page.locator("#memoryKey").fill("group:456");
  await submitMemory();
  async function submitMemory() {
    await page.locator("#memoryForm [type=submit]").click();
    await page.waitForSelector('[data-memory="xss"]');
  }
  assert.equal(await page.locator("#memoryItems img").count(), 0);
  await page.locator('[data-memory="xss"]').click();
  await page.waitForFunction(
    () => !document.querySelector('[data-memory="xss"]'),
  );
  assert.equal(h.memoryPool.query().length, 0);
  await nav("settings");
  await page.locator('[data-path="architecture.gateV2"]').check();
  await submit("deploymentForm", "/api/console/settings");
  assert.equal(
    JSON.parse(fs.readFileSync(`${h.temp}/config.json`, "utf8")).architecture
      .gateV2,
    true,
  );
  assert.equal(h.cfg.architecture.gateV2, false);
  console.log("PASS 会话策略、角色、记忆转义删除与重启参数备份");
  const accessBefore = JSON.stringify(h.cfg.allow);
  await page.route("**/api/console/whitelist", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, error: "fixture unavailable" },
    }),
  );
  await nav("settings");
  await page.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("fixture unavailable"),
  );
  await page.locator("#accessForm [type=submit]").click();
  await page.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("请先成功读取访问配置"),
  );
  assert.equal(JSON.stringify(h.cfg.allow), accessBefore);
  await page.unroute("**/api/console/whitelist");
  console.log("PASS 配置读取失败时禁止回写空表单");
  fs.mkdirSync("/tmp/bridge-studio", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const view of [
      "desk",
      "parameters",
      "sessions",
      "persona",
      "settings",
    ]) {
      await nav(view);
      const size = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(size.scroll <= size.width + 1, `${view} ${width}px 溢出`);
      await page.screenshot({
        path: `/tmp/bridge-studio/${view}-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.locator("footer a").click();
  await page.waitForSelector("#mainNav");
  assert.equal(new URL(page.url()).searchParams.get("classic"), "1");
  assert.equal(new URL(page.url()).searchParams.has("token"), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log("PASS 桌面/手机布局、兼容入口，无脚本错误和外连");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}
