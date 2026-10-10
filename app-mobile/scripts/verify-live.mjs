// 线上地址真实浏览器验证（含登录入口与错误凭据探测）。
// 用法：node scripts/verify-live.mjs [url]
import { chromium, devices } from "playwright-core";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "output", "work-20261010-0930-mobile-bugfix", "live-verify");
const baseUrl = process.argv[2] || "https://xiaoya-learning.app.workbuddy.host/";

const EXECUTABLES = [
  process.env.PLAYWRIGHT_CHROMIUM,
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe")
].filter(Boolean);
const executablePath = EXECUTABLES.find(candidate => existsSync(candidate));

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function countSessions(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open("xiaoya-family-learning");
    request.onerror = () => resolve(-1);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) return resolve(0);
      const all = db.transaction("sessions", "readonly").objectStore("sessions").getAll();
      all.onsuccess = () => resolve(all.result.length);
      all.onerror = () => resolve(-1);
    };
  }));
}

async function answerTimes(page, times) {
  let answered = 0;
  for (let index = 0; index < times; index += 1) {
    const state = await page.evaluate(() => {
      const runtime = window.xiaoya?.childApp?.runtime;
      const task = runtime?.queue?.[runtime.queueIndex];
      if (!task) return { done: true };
      return { done: false, questionType: task.questionType, correctAnswer: task.correctAnswer ?? null, composition: task.composition || null, phase: runtime.compositionBoard?.phase || null };
    });
    if (state.done) break;
    if (state.composition && state.phase !== "answer") {
      await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
      await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
      await page.click("[data-composition='join']").catch(() => {});
      await page.waitForTimeout(150);
      index -= 1;
      continue;
    }
    if (state.questionType === "choice") {
      const ok = await page.click(`[data-choice="${state.correctAnswer}"]`, { timeout: 2500 }).then(() => true).catch(() => false);
      if (!ok) await page.locator("[data-choice]").first().click().catch(() => {});
    } else {
      await page.click("[data-answer='correct']").catch(() => {});
    }
    answered += 1;
    for (let wait = 0; wait < 30; wait += 1) {
      if (await page.locator("[data-action='next-feedback']").count()) break;
      await page.waitForTimeout(150);
    }
    await page.click("[data-action='next-feedback']").catch(() => {});
    await page.waitForTimeout(120);
  }
  return answered;
}

async function main() {
  if (!executablePath) throw new Error("没有找到本机 Chromium。");
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ ...devices["iPhone 14"] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    const started = Date.now();
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector(".entry-card.child", { timeout: 30000 });
    record("线上首页可访问并渲染", true, `首次加载 ${Date.now() - started} ms`);

    const origin = await page.evaluate(() => location.origin);
    record("线上域名与保留域名一致", origin === "https://xiaoya-learning.app.workbuddy.host", origin);

    record("线上 manifest 可用", (await page.getAttribute("link[rel=manifest]", "href")) !== null);
    await page.waitForTimeout(1200);
    const sw = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
    record("线上 Service Worker 注册成功（HTTPS 安全上下文）", sw);

    // 孩子学习全流程
    await page.click("[data-action='child-home']");
    await page.waitForSelector("[data-subject='hanzi']");
    await page.click("[data-subject='hanzi']");
    await page.waitForSelector("[data-mode='lesson']");
    await page.click("[data-mode='lesson']");
    await page.waitForSelector(".lesson", { timeout: 10000 });
    const promptText = (await page.locator(".prompt").first().textContent() || "").trim();
    record("今日课程可进入", promptText.length > 0, promptText.slice(0, 20));
    await page.screenshot({ path: path.join(outDir, "live-lesson.png") });

    const answered = await answerTimes(page, 3);
    record("连续作答", answered >= 2, `作答 ${answered} 题`);
    await page.click("[data-action='stop']").catch(() => {});
    await page.waitForSelector(".done-card", { timeout: 15000 });
    const saved = await countSessions(page);
    record("线上端学习记录写入本机", saved >= 1, `${saved} 份`);
    await page.screenshot({ path: path.join(outDir, "live-done.png") });

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".entry-card.child", { timeout: 20000 });
    record("刷新后记录保留", (await countSessions(page)) >= saved);

    // 家长入口：登录界面 + 错误凭据探测（验证认证数据面在正式域名上可用）
    await page.click("[data-action='parent-home']");
    await page.waitForSelector(".login-card", { timeout: 15000 });
    record("家长入口显示登录界面", true);
    await page.click("[data-login-tab='email']");
    await page.waitForSelector("[data-login-email]");
    await page.fill("[data-login-email]", "probe-does-not-exist@example.invalid");
    await page.fill("[data-login-password]", "not-a-real-password");
    await page.click("[data-action='submit-password']");
    let authNotice = "";
    for (let wait = 0; wait < 40; wait += 1) {
      authNotice = (await page.locator(".notice.error, .notice.ok").first().textContent().catch(() => "")) || "";
      if (authNotice) break;
      await page.waitForTimeout(250);
    }
    const authReachable = Boolean(authNotice) && !/网络|Network|Failed to fetch|Load failed|来源|origin/i.test(authNotice);
    record("认证数据面在正式域名可用（返回凭据错误而非网络/来源错误）", authReachable, authNotice.slice(0, 60));
    await page.screenshot({ path: path.join(outDir, "live-parent-login.png") });

    const significant = consoleErrors.filter(text => !/favicon|manifest|Failed to load resource/i.test(text));
    record("无严重控制台错误", significant.length === 0, significant.slice(0, 2).join(" | "));
  } finally {
    await context.close();
    await browser.close();
  }

  const summary = {
    at: new Date().toISOString(),
    baseUrl,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
    consoleErrors
  };
  await writeFile(path.join(outDir, "live-verify.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\n合计 ${summary.passed} 通过 / ${summary.failed} 失败；结果写入 ${path.join(outDir, "live-verify.json")}`);
  if (summary.failed) process.exitCode = 1;
}

await main();
