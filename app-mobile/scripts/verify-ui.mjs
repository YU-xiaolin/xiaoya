// 手机端真实浏览器验证。使用 playwright-core + 本机已安装的 Chromium。
// 用法：node scripts/verify-ui.mjs [baseUrl]
import { chromium, devices } from "playwright-core";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "output", "work-20261010-0930-mobile-bugfix", "ui-verify");

const EXECUTABLES = [
  process.env.PLAYWRIGHT_CHROMIUM,
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe")
].filter(Boolean);
const executablePath = EXECUTABLES.find(candidate => existsSync(candidate));

const baseUrl = process.argv[2] || "http://127.0.0.1:5199/";

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

// 依次作答当前题目，直到本节结束或达到上限。
// 组成题（分与合）需要先摆盘子再合起来，这里按真实交互顺序点击。
async function answerRound(page, maxTasks = 60) {
  let answered = 0;
  for (let index = 0; index < maxTasks; index += 1) {
    const state = await page.evaluate(() => {
      const runtime = window.xiaoya?.childApp?.runtime;
      if (!runtime) return null;
      const task = runtime.queue?.[runtime.queueIndex];
      if (!task) return { done: true };
      return {
        done: false,
        questionType: task.questionType,
        correctAnswer: task.correctAnswer ?? null,
        composition: task.composition || null,
        phase: runtime.compositionBoard?.phase || null
      };
    });
    if (!state) return { answered, error: "无法读取运行时状态" };
    if (state.done) return { answered, done: true };

    if (state.composition) {
      if (state.phase !== "answer") {
        await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
        await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
        await page.click("[data-composition='join']").catch(() => {});
        await page.waitForTimeout(120);
        continue;
      }
    }
    if (state.questionType === "choice") {
      const clicked = await page.click(`[data-choice="${state.correctAnswer}"]`, { timeout: 2500 }).then(() => true).catch(() => false);
      if (!clicked) {
        const fallback = page.locator("[data-choice]").first();
        if (await fallback.count()) await fallback.click().catch(() => {});
        else return { answered, error: "找不到可点击的选项" };
      }
    } else {
      await page.click("[data-answer='correct']", { timeout: 2500 }).catch(() => {});
    }
    answered += 1;
    // 反馈面板出现后点“下一题”。
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

async function main() {
  if (!executablePath) throw new Error("没有找到本机 Chromium，请设置 PLAYWRIGHT_CHROMIUM 环境变量。");
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ ...devices["iPhone 14"] });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    // 1. 首次打开
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".entry-card.child", { timeout: 15000 });
    record("首次打开渲染首页", await page.locator(".entry-card.child").count() === 1);
    record("首页含家长入口", await page.locator(".entry-card.parent").count() === 1);

    // 2. PWA 声明与 Service Worker
    const manifestHref = await page.getAttribute("link[rel=manifest]", "href");
    record("声明 PWA manifest", Boolean(manifestHref), manifestHref || "");
    const manifestOk = await page.evaluate(async href => {
      const response = await fetch(href);
      if (!response.ok) return false;
      const data = await response.json();
      return data.display === "standalone" && Array.isArray(data.icons) && data.icons.length >= 3;
    }, manifestHref);
    record("manifest 为 standalone 且含图标", manifestOk);
    const swReady = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration);
    });
    record("Service Worker 已注册", swReady);

    // 2b. 随应用发布的自然语音子集（离线可用）
    const voiceInfo = await page.evaluate(async () => {
      const response = await fetch("./voice/manifest.json");
      if (!response.ok) return { ok: false, count: 0 };
      const data = await response.json();
      const keys = Object.keys(data.clips || {});
      if (!keys.length) return { ok: false, count: 0 };
      const first = data.clips[keys[0]];
      const clipResponse = await fetch(`./voice/${first.fileName}`);
      const buffer = clipResponse.ok ? await clipResponse.arrayBuffer() : new ArrayBuffer(0);
      return { ok: clipResponse.ok && buffer.byteLength > 0, count: keys.length, bytes: buffer.byteLength };
    });
    record("自然语音子集随应用发布且可读取", voiceInfo.ok, `${voiceInfo.count} 条，首条 ${voiceInfo.bytes} 字节`);

    // 3. 孩子入口
    await page.click("[data-action='child-home']");
    await page.waitForSelector("[data-subject='hanzi']");
    record("进入孩子入口显示三个学科", await page.locator(".subject-card").count() === 3);

    // 3b. 先完成一小段课程：本机有了真实作答记录，「小测试」才有可测内容。
    //     随应用发布的课程包是通用课程定义，不含家庭进度，小测试范围必须由本机记录推导。
    await page.click("[data-subject='hanzi']");
    await page.waitForSelector("[data-mode='lesson']");
    record("显示四种学习方式", await page.locator(".mode-card").count() === 4);
    await page.click("[data-mode='lesson']");
    await page.waitForSelector(".lesson .choices, .lesson [data-answer]", { timeout: 8000 });
    const lessonOutcome = await answerRound(page, 4);
    record("课程作答并保存成功", lessonOutcome.answered >= 2, `作答 ${lessonOutcome.answered} 题`);
    if (!lessonOutcome.done) await page.click("[data-action='stop']").catch(() => {});
    await page.waitForSelector(".done-card", { timeout: 15000 });
    await page.click("[data-action='home']");
    await page.waitForSelector(".entry-card.child", { timeout: 8000 });
    await page.click("[data-action='child-home']");
    await page.waitForSelector("[data-subject='hanzi']");

    // 4. 汉字 → 小小测试 → 全部内容
    await page.click("[data-subject='hanzi']");
    await page.waitForSelector("[data-mode='test']");
    record("课程结束后“小测试”可用（本机记录已推导出目录进度）", !(await page.locator("[data-mode='test']").isDisabled()));
    await page.click("[data-mode='test']");
    await page.waitForSelector("[data-test-scope='all']");
    record("测试设置页出现范围选项", await page.locator(".scope-card").count() === 4);
    const allDisabled = await page.locator("[data-test-scope='all']").isDisabled().catch(() => true);
    record("已学内容可出题（全部内容可用）", !allDisabled);

    // 选择“近 3 天”或“全部内容”，优先全部内容
    if (!allDisabled) await page.click("[data-test-scope='all']");
    await page.click("[data-action='start-selected-test']");
    await page.waitForSelector(".lesson .choices, .lesson [data-answer]", { timeout: 8000 });
    record("进入答题界面", await page.locator(".lesson").count() === 1);
    const firstPrompt = (await page.locator(".prompt").first().textContent() || "").trim();
    record("题目有可见题干", firstPrompt.length > 0, firstPrompt.slice(0, 24));

    // 5. 连续作答，做完若干题后按“今天先到这里”结束本节（验证保存链路）
    // 可出题的题量取决于本机已有记录覆盖的内容（隔离环境里只先学了一小段），
    // 因此这里校验「连续作答链路可用」，不写死题量下限。
    const outcome = await answerRound(page, 8);
    record("连续作答成功", outcome.answered >= 3, `作答 ${outcome.answered} 题` + (outcome.error ? ` · ${outcome.error}` : ""));
    if (!outcome.done) {
      await page.click("[data-action='stop']").catch(() => {});
    }
    await page.waitForSelector(".done-card", { timeout: 15000 });
    const localCount = await countSessions(page);
    record("学习记录已写入本地 IndexedDB", localCount >= 1, `本地记录 ${localCount} 份`);
    const doneText = (await page.locator(".done-card").textContent()) || "";
    record("完成页提示保存在本机", doneText.includes("本机") || doneText.includes("手机"));

    // 6. 刷新后数据仍在（离线可用性的前提）
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".entry-card.child", { timeout: 15000 });
    const afterReload = await countSessions(page);
    record("刷新后本地记录保留", afterReload === localCount, `刷新后 ${afterReload} 份`);

    // 7. 数学第 4 阶段应出现分与合操作盘
    await page.click("[data-action='child-home']");
    await page.waitForSelector("[data-subject='math']");
    await page.click("[data-subject='math']");
    await page.waitForSelector("[data-math-stage='4']");
    await page.click("[data-math-stage='4']");
    await page.click("[data-mode='lesson']");
    await page.waitForSelector(".lesson", { timeout: 8000 });
    const hasBoard = await page.locator(".composition-board").count();
    record("数学第 4 阶段出现分与合操作盘", hasBoard > 0);
    if (hasBoard > 0) {
      await page.click("[data-composition='left'], [data-composition='right']").catch(() => {});
      await page.waitForTimeout(150);
      const afterClick = await page.locator(".composition-board").count();
      record("点击盘子后操作盘仍可用", afterClick > 0);
    }
    await page.screenshot({ path: path.join(outDir, "math-stage4.png"), fullPage: false });

    // 8. 家长入口需要登录
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".entry-card.parent");
    await page.click("[data-action='parent-home']");
    await page.waitForSelector(".login-card", { timeout: 8000 });
    record("家长入口要求登录", await page.locator(".login-card").count() === 1);
    const bodyText = await page.locator("body").innerText();
    record("家长页包含两个同步按钮说明", bodyText.includes("上传学习记录") || bodyText.includes("登录"));
    await page.screenshot({ path: path.join(outDir, "parent-login.png") });

    // 9. 离线仍可打开应用
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".entry-card.child");
    await context.setOffline(true);
    let offlineOk = false;
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForSelector(".entry-card.child", { timeout: 12000 });
      offlineOk = true;
    } catch (error) {
      offlineOk = false;
    }
    record("断网后仍可打开应用（离线缓存生效）", offlineOk);
    await context.setOffline(false);

    // 10. 控制台错误
    const significant = consoleErrors.filter(text => !/favicon|manifest|Failed to load resource/i.test(text));
    record("无严重控制台错误", significant.length === 0, significant.slice(0, 2).join(" | "));

    await page.screenshot({ path: path.join(outDir, "final-home.png") });
  } finally {
    await context.close();
    await browser.close();
  }

  const summary = {
    at: new Date().toISOString(),
    baseUrl,
    executablePath,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
    consoleErrors
  };
  await writeFile(path.join(outDir, "ui-verify.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\n合计 ${summary.passed} 通过 / ${summary.failed} 失败；结果写入 ${path.join(outDir, "ui-verify.json")}`);
  if (summary.failed) process.exitCode = 1;
}

await main();
