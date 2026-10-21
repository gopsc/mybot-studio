import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const workspace = path.resolve(process.env.PYMYBOT_REPO ?? path.join(root, "..", "pymybot"));
const out = path.join(here, "out");
if (!existsSync(path.join(workspace, "pymybot", "cli.py"))) {
  console.error(`pymybot repo not found at ${workspace}; set PYMYBOT_REPO`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(path.join(os.tmpdir(), "studio-e2e-"));

const app = await electron.launch({
  args: [path.join(root, "dist-electron", "electron", "main.js")],
  // An empty model keeps the agent step offline and deterministic.
  env: { ...process.env, MYBOT_STUDIO_WORKSPACE: workspace, MYBOT_STUDIO_USER_DATA: userData, MYBOT_MODEL: "" },
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const step = (name) => console.log(`- ${name}`);

  step("select relay-test robot and pass check");
  await page.locator(".toolbar select").first().selectOption("robots/relay-test.sql");
  await page.locator(".toolbar select").nth(1).selectOption("scripts/relay-test.mt");
  await page.getByText("✓ 检查通过", { exact: false }).waitFor({ timeout: 30000 });

  step("open relay-test.mt in the editor");
  await page.locator(".tree").getByText("relay-test.mt", { exact: true }).click();
  await page.locator(".monaco-editor .view-lines").getByText("relay0.test").waitFor();
  await shot("01-editor");

  step("run relay-test");
  await page.getByRole("button", { name: "▶ 运行" }).click();
  await page.locator(".statusbar", { hasText: "就绪" }).waitFor({ timeout: 60000 });
  const output = await page.locator(".panel > .panel-body:not([hidden])").innerText();
  if (!output.includes("OK")) throw new Error(`run output lacks OK:\n${output}`);
  await shot("02-run");

  step("hardware panel lists relay0");
  await page.locator(".panel-tab", { hasText: "硬件" }).click();
  await page.locator(".panel > .panel-body:not([hidden])").getByText("relay0").first().waitFor();

  step("switch to bh1750 virtual robot");
  await page.locator(".toolbar select").first().selectOption("tests/fixtures/virt/bh1750_virt.sql");
  await page.locator(".toolbar select").nth(1).selectOption("");
  await page.getByText(/^✓ 检查通过：4 张表（Timer, Daemon, Ema, Monitor）$/).waitFor({ state: "attached", timeout: 30000 });

  step("sample cl0 and draw chart");
  await page.locator(".panel-tab", { hasText: "采样" }).click();
  const sample = page.locator(".panel > .panel-body:not([hidden])");
  await sample.locator("select").selectOption("cl0");
  await sample.locator("input[type=number]").first().fill("20");
  await sample.getByRole("button", { name: "采样", exact: true }).click();
  await sample.getByRole("button", { name: "采样中…", exact: true }).waitFor({ state: "detached", timeout: 60000 });
  if (await sample.locator(".err").count()) throw new Error(await sample.innerText());
  await sample.locator("canvas").first().waitFor();
  await page.waitForTimeout(500);
  await shot("03-sample");

  step("activate a session and stream samples live");
  await page.getByRole("button", { name: "⏻ 激活会话" }).click();
  await page.locator(".statusbar .session-badge").waitFor({ timeout: 30000 });
  await sample.locator("input[type=number]").first().fill("20");
  await sample.getByRole("button", { name: "采样", exact: true }).click();
  await page.waitForFunction(() => {
    const match = /已收 (\d+) 个样本/.exec(document.querySelector(".panel > .panel-body:not([hidden])")?.textContent ?? "");
    return match && Number(match[1]) >= 40;
  }, null, { timeout: 30000 });
  await shot("05-live-sample");
  await sample.getByRole("button", { name: "停止采样" }).click();
  await sample.getByRole("button", { name: "采样", exact: true }).waitFor({ timeout: 15000 });
  if (await sample.locator(".err").count()) throw new Error(await sample.innerText());

  step("hot SQL stays in the session");
  await page.locator(".panel-tab", { hasText: "查询" }).click();
  const query = page.locator(".panel > .panel-body:not([hidden])");
  await query.locator("textarea").fill("INSERT INTO Timer (name) VALUES ('t9');");
  await query.getByRole("button", { name: "应用到当前会话" }).click();
  await query.getByText(/已生效：新增 1 个变量/).waitFor({ timeout: 15000 });
  await page.locator(".panel-tab", { hasText: "硬件" }).click();
  await page.locator(".panel > .panel-body:not([hidden])").getByText("t9", { exact: true }).waitFor();

  step("agent waits for the session to end");
  await page.locator(".panel-tab", { hasText: "智能体" }).click();
  const agent = page.locator(".panel > .panel-body:not([hidden])");
  if (!(await agent.locator(".composer textarea").isDisabled())) throw new Error("agent composer should be disabled during a session");

  step("end the session");
  await page.getByRole("button", { name: "⏏ 结束会话" }).click();
  await page.locator(".statusbar .session-badge").waitFor({ state: "detached", timeout: 30000 });
  await page.locator(".panel-tab", { hasText: "硬件" }).click();
  await page.locator(".panel > .panel-body:not([hidden])").getByText("cl0", { exact: true }).waitFor();
  // Hardware is re-read from the file once the session ends, dropping the hot SQL row.
  await page.locator(".panel > .panel-body:not([hidden])").getByText("t9", { exact: true }).waitFor({ state: "detached", timeout: 15000 });

  step("agent reports a missing model without a request");
  await page.locator(".panel-tab", { hasText: "智能体" }).click();
  await agent.locator(".composer textarea").fill("列出硬件");
  await agent.getByRole("button", { name: "发送" }).click();
  await agent.getByText(/MYBOT_MODEL.*对话已关闭/).waitFor({ timeout: 30000 });
  await shot("06-agent");

  step("log panel recorded the commands");
  await page.locator(".panel-tab", { hasText: "日志" }).click();
  await page.locator(".panel > .panel-body:not([hidden])").getByText("serve session.activate").first().waitFor();
  await shot("04-log");

  if (errors.length) throw new Error(`renderer errors:\n${errors.join("\n")}`);
  console.log("smoke OK");
} catch (error) {
  console.error(errors.join("\n"));
  const page = (await app.windows())[0];
  if (page) await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
