// 「小小测试」可用性回归验证。
//
// 背景：公开课程包改回「通用课程定义」（不含家庭进度）后，小测试的范围改由
// 本机真实作答记录推导。家长看到灰掉的按钮容易以为功能坏了，因此这里校验两件事：
//   1. 本机没有作答记录时：按钮说明原因（“先完成一节课程”+ 页面提示怎么打通家庭进度），
//      而不是只写「暂无内容」让人猜；
//   2. 完成一节课程后：按钮立即可用，并显示已学内容数量。
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

async function answerRound(page, maxTasks = 6) {
  let answered = 0;
  for (let index = 0; index < maxTasks; index += 1) {
    const state = await page.evaluate(() => {
      const runtime = window.xiaoya?.childApp?.runtime;
      const task = runtime?.queue?.[runtime.queueIndex];
      if (!task) return { done: true };
      return { questionType: task.questionType, correctAnswer: task.correctAnswer ?? null, composition: task.composition || null, phase: runtime.compositionBoard?.phase || null };
    });
    if (state.done) return { answered, done: true };
    if (state.composition && state.phase !== "answer") {
      await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
      await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
      await page.click("[data-composition='join']").catch(() => {});
      await page.waitForTimeout(120);
      continue;
    }
    if (state.questionType === "choice") {
      const clicked = await page.click(`[data-choice="${state.correctAnswer}"]`, { timeout: 2500 }).then(() => true).catch(() => false);
      if (!clicked) await page.locator("[data-choice]").first().click().catch(() => {});
    } else {
      await page.click("[data-answer='correct']", { timeout: 2500 }).catch(() => {});
    }
    answered += 1;
    for (let wait = 0; wait < 30; wait += 1) {
      if (await page.locator("[data-action='next-feedback']").count()) break;
      await page.waitForTimeout(150);
    }
    await page.click("[data-action='next-feedback']").catch(() => {});
    await page.waitForTimeout(120);
    if (await page.locator(".done-card").count()) return { answered, done: true };
  }
  return { answered, done: await page.locator(".done-card").count() > 0 };
}

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();

try {
  // ---------- 1. 全新设备（无本机记录） ----------
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 20000 });
  await page.click("[data-action='child-home']");
  await page.waitForSelector("[data-subject='hanzi']");
  await page.click("[data-subject='hanzi']");
  await page.waitForSelector("[data-mode='test']");

  const testCard = page.locator("[data-mode='test']");
  const disabled = await testCard.isDisabled();
  const cardText = (await testCard.innerText()).replace(/\s+/g, " ").trim();
  record("无本机记录时小测试按钮为不可用（符合设计）", disabled);
  record("按钮说明原因而不是只写「暂无内容」", cardText.includes("先完成一节课程"), cardText);
  const hint = (await page.locator(".hint-text").allInnerTexts()).join(" ");
  record("页面提示如何打通家庭进度", hint.includes("更新学习课程"), hint.slice(0, 60));

  // ---------- 2. 完成一节课程后立即可用 ----------
  await page.click("[data-mode='lesson']");
  await page.waitForSelector(".lesson .choices, .lesson [data-answer]", { timeout: 10000 });
  const outcome = await answerRound(page, 4);
  if (!outcome.done) await page.click("[data-action='stop']").catch(() => {});
  await page.waitForSelector(".done-card", { timeout: 15000 });
  await page.click("[data-action='home']");
  await page.waitForSelector(".entry-card.child", { timeout: 8000 });
  await page.click("[data-action='child-home']");
  await page.waitForSelector("[data-subject='hanzi']");
  await page.click("[data-subject='hanzi']");
  await page.waitForSelector("[data-mode='test']");

  const enabled = !(await page.locator("[data-mode='test']").isDisabled());
  const textAfter = (await page.locator("[data-mode='test']").innerText()).replace(/\s+/g, " ").trim();
  record("完成一节课程后小测试立即可用", enabled, `作答 ${outcome.answered} 题`);
  record("按钮显示已学内容数量", /已学 \d+ 个字/.test(textAfter), textAfter);
  await page.screenshot({ path: path.join(outDir, "verify-test-availability.png") });
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
await writeFile(path.join(outDir, "verify-test-availability.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`\n合计 ${summary.passed} 通过 / ${summary.failed} 失败；结果写入 ${path.join(outDir, "verify-test-availability.json")}`);
if (summary.failed) process.exitCode = 1;
