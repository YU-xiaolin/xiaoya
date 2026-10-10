// 手机端「输入被整页重绘打断」回归验证。
//
// 背景（真实故障）：家长在登录页点「获取验证码」后，60 秒倒计时每秒触发一次整页重绘，
// 正在输入的验证码输入框被销毁 → 手机软键盘被系统收起、已输入的验证码消失，
// 表现为「点验证码框准备输入数字时键盘自动没了，不让输入」。
//
// 本脚本用真实 Chromium + iPhone 视口验收：
//   1. 点击验证码框后可以连续输入 6 位，焦点不丢、内容保留；
//   2. 倒计时期间登录卡片不再被整页替换（0 次）；
//   3. 测试设置页的题量输入框连续输入不丢焦点。
// 使用 fetch 拦截模拟发码响应，不发送任何真实短信/邮件，不触碰正式数据。
import { chromium, devices } from "playwright-core";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "output", "work-20261010-0930-mobile-bugfix");
const baseUrl = process.argv[2] || "http://127.0.0.1:5199/";

const EXECUTABLES = [
  process.env.PLAYWRIGHT_CHROMIUM,
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe")
].filter(Boolean);
const executablePath = EXECUTABLES.find(candidate => existsSync(candidate));
if (!executablePath) throw new Error("没有找到本机 Chromium，请设置 PLAYWRIGHT_CHROMIUM 环境变量。");

await mkdir(outDir, { recursive: true });
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();
await page.addInitScript(() => {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (/\/v1\/verification(\?|$)/.test(url) && (init?.method || "GET").toUpperCase() === "POST") {
      return new Response(JSON.stringify({ verification_id: "isolated-test-id", is_user: true }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return original(input, init);
  };
  // 统计登录卡片被整页替换的次数：这正是软键盘被收起的直接原因。
  window.__loginCardReplacements = 0;
  window.__resetLoginCardCount = () => { window.__loginCardReplacements = 0; };
  window.__watchLoginCard = () => {
    window.__loginCardReplacements = 0;
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType === 1 && (node.matches?.(".login-card") || node.querySelector?.(".login-card"))) {
            window.__loginCardReplacements += 1;
          }
        }
      }
    });
    observer.observe(document.getElementById("app"), { childList: true, subtree: true });
    window.__loginCardObserver = observer;
  };
});

const consoleErrors = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));

try {
  // ---------- A. 家长登录验证码 ----------
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.parent", { timeout: 20000 });
  await page.click("[data-action='parent-home']");
  await page.waitForSelector(".login-card", { timeout: 8000 });

  await page.fill("[data-login-phone]", "13800000000");
  await page.evaluate(() => window.__watchLoginCard());
  await page.click("[data-action='send-phone-code']");
  await page.waitForSelector(".hint-text", { timeout: 8000 });
  const cooldownText = (await page.locator("[data-action='send-phone-code']").textContent() || "").trim();
  record("点击“获取验证码”后进入倒计时", /\d+s 后可重发/.test(cooldownText), cooldownText);
  // 发码本身会重绘两次（进入忙碌态/结束忙碌态），那是用户主动点击后的正常重绘；
  // 这里从「发码完成」开始计数，验证倒计时滴答期间不再重绘。
  await page.evaluate(() => window.__resetLoginCardCount?.());

  const codeInput = page.locator("[data-login-code]");
  await codeInput.click();
  await page.waitForTimeout(120);
  record("点击验证码框后获得焦点（软键盘可弹出）", await page.evaluate(() => document.activeElement?.hasAttribute("data-login-code") === true));

  let typed = 0;
  let lostAt = 0;
  for (const digit of ["1", "2", "3", "4", "5", "6"]) {
    await page.keyboard.type(digit, { delay: 350 });
    typed += 1;
    if (!(await page.evaluate(() => document.activeElement?.hasAttribute("data-login-code") === true))) { lostAt = typed; break; }
  }
  record("连续输入 6 位验证码不中断", typed === 6 && lostAt === 0, lostAt ? `第 ${lostAt} 位后失去焦点` : "6/6");
  const value = await page.inputValue("[data-login-code]").catch(() => "(输入框已被重建)");
  record("已输入的验证码内容保留", value === "123456", `输入框内容：${value}`);

  // 持续观察 3 秒倒计时：登录卡片不应再被整页替换。
  await page.waitForTimeout(3000);
  const replacements = await page.evaluate(() => {
    window.__loginCardObserver?.disconnect();
    return window.__loginCardReplacements;
  });
  record("倒计时期间不再整页重绘登录卡片", replacements === 0, `重绘 ${replacements} 次`);

  // 重新点击输入框后仍能继续输入（防止“只在第一次可用”）。
  await codeInput.click();
  await page.keyboard.type("9", { delay: 120 });
  const value2 = await page.inputValue("[data-login-code]").catch(() => "(输入框已被重建)");
  record("未登录前可反复点击验证码框继续输入", value2 === "1234569", `输入框内容：${value2}`);
  await page.screenshot({ path: path.join(outDir, "verify-login-input.png") });

  // ---------- B. 测试设置页数字输入 ----------
  // 先在隔离浏览器里放一份本机记录（只写在测试用的 IndexedDB，不进入正式数据），
  // 让“小测试”可用，然后验证连续输入天数时不会因为重绘而失焦。
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 15000 });
  await page.evaluate(async () => {
    const request = indexedDB.open("xiaoya-family-learning");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    const payload = {
      protocol: "FAMILY_LEARNING_SESSION_V1",
      sessionId: "session-isolated-focus-check",
      studentCode: "student-01",
      deviceCode: "device-isolated",
      platform: "isolated-test",
      lessonId: "lesson-isolated",
      activityMode: "lesson",
      startedAt: now,
      endedAt: now,
      completed: true,
      stopReason: "completed",
      events: [
        { eventId: "e1", recordedAt: now, taskId: "t1", subject: "hanzi", targetRef: "ZH-0001", targetDisplay: "人", questionType: "recognition", evidenceType: "hanzi_oral_reading", result: "correct", independent: true },
        { eventId: "e2", recordedAt: now, taskId: "t2", subject: "hanzi", targetRef: "ZH-0002", targetDisplay: "大", questionType: "choice", evidenceType: "hanzi_choice", result: "correct", independent: true },
        { eventId: "e3", recordedAt: now, taskId: "t3", subject: "hanzi", targetRef: "ZH-0003", targetDisplay: "小", questionType: "choice", evidenceType: "hanzi_choice", result: "incorrect", independent: false }
      ]
    };
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put({
        sessionId: payload.sessionId, studentCode: payload.studentCode, deviceCode: payload.deviceCode,
        platform: payload.platform, startedAt: now, endedAt: now,
        uploaded: false, uploadedFlag: 0, uploadedAt: null, payload, payloadSha256: ""
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 15000 });
  await page.click("[data-action='child-home']");
  await page.waitForSelector("[data-subject='hanzi']");
  await page.click("[data-subject='hanzi']");
  await page.waitForSelector("[data-mode='test']");
  await page.click("[data-mode='test']");
  await page.waitForSelector("[data-custom-test-days]", { timeout: 8000 });

  await page.click("[data-custom-test-days]");
  await page.fill("[data-custom-test-days]", "");
  await page.keyboard.type("12", { delay: 300 });
  const daysFocused = await page.evaluate(() => document.activeElement?.hasAttribute("data-custom-test-days") === true);
  const daysValue = await page.inputValue("[data-custom-test-days]").catch(() => "");
  record("测试设置页连续输入天数不丢焦点", daysFocused && daysValue === "12", `焦点=${daysFocused} 值=${daysValue}`);

  const significant = consoleErrors.filter(text => !/favicon|manifest|Failed to load resource/i.test(text));
  record("无严重控制台错误", significant.length === 0, significant.slice(0, 2).join(" | "));
} catch (error) {
  record("脚本执行未抛异常", false, error.message);
} finally {
  await context.close();
  await browser.close();
}

const summary = {
  at: new Date().toISOString(),
  baseUrl,
  passed: results.filter(item => item.ok).length,
  failed: results.filter(item => !item.ok).length,
  results
};
await writeFile(path.join(outDir, "verify-login-input.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`\n合计 ${summary.passed} 通过 / ${summary.failed} 失败；结果写入 ${path.join(outDir, "verify-login-input.json")}`);
if (summary.failed) process.exitCode = 1;
