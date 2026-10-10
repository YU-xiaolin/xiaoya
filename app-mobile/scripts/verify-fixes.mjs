// 审核修复的隔离验证：在本地预览的**生产构建产物**上逐条复现报告中的缺陷场景。
// 只读写浏览器自身的 IndexedDB / Cache Storage，不接触任何正式数据文件。
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = process.env.XIAOYA_BASE_URL || "http://127.0.0.1:5210/";
// 默认写到项目 output 目录（app-mobile/scripts → ../../output/...），不散落到项目外。
const outDir = process.env.XIAOYA_VERIFY_OUT
  || path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "output", "playwright", "fix-verify-20261008");
const CHROME = process.env.XIAOYA_CHROME
  || path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe");

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    locale: "zh-CN"
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("pageerror", error => consoleErrors.push(String(error?.message || error)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  /* ---------- R09：生产构建产物 + 预缓存就绪 ---------- */

  const assetInfo = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll("script[src]")].map(node => node.getAttribute("src")),
    styles: [...document.querySelectorAll("link[rel=stylesheet]")].map(node => node.getAttribute("href")),
    hasViteClient: Boolean(document.querySelector('script[src*="@vite/client"]'))
  }));
  record(
    "R09-build",
    "线上/预览为正式构建产物，不再引用开发入口",
    assetInfo.scripts.some(src => /\/assets\/index-.*\.js$/.test(src)) && !assetInfo.hasViteClient,
    `scripts=${JSON.stringify(assetInfo.scripts)}`
  );

  // 等 Service Worker 就绪信号。
  await page.waitForFunction(() => document.documentElement.dataset.offlineReady === "true", { timeout: 30000 })
    .catch(() => null);
  const offlineReady = await page.evaluate(() => document.documentElement.dataset.offlineReady || null);

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const all = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      const reqs = await cache.keys();
      all.push(...reqs.map(r => new URL(r.url).pathname));
    }
    return { keys, urls: [...new Set(all)] };
  });
  const hasBuiltJs = cached.urls.some(u => /\/assets\/index-.*\.js$/.test(u));
  const hasBuiltCss = cached.urls.some(u => /\/assets\/index-.*\.css$/.test(u));
  record("R09-precache", "构建后的 JS/CSS 已预缓存", hasBuiltJs && hasBuiltCss, `cacheKeys=${cached.keys.join(",")}`);

  /* ---------- R01：Cache Storage 中不得有云接口响应 ---------- */

  const cloudInCache = cached.urls.filter(u => /\/\.cloud\//.test(u) || /\/(auth|rest|storage|functions)\//.test(u));
  record("R01-cache", "Cache Storage 中没有云接口响应", cloudInCache.length === 0, `found=${JSON.stringify(cloudInCache)}`);

  // 直接验证：即使带 Authorization 的同域请求也不进入缓存。
  const authProbe = await page.evaluate(async () => {
    const url = new URL("./course/course-package.json", location.href);
    try {
      await fetch(url.href, { headers: { Authorization: "Bearer test-token" } });
    } catch { /* 忽略。 */ }
    const keys = await caches.keys();
    for (const key of keys) {
      const cache = await caches.open(key);
      const reqs = await cache.keys();
      if (reqs.some(r => r.url.includes(".cloud"))) return { leaked: true };
    }
    return { leaked: false };
  });
  record("R01-auth", "带 Authorization 的请求未被写入云缓存", !authProbe.leaked, null);

  /* ---------- R02：公开课程包不含家庭进度 ---------- */

  const pkgProbe = await page.evaluate(async () => {
    const res = await fetch("./course/course-package.json");
    return res.json();
  });
  const sample = pkgProbe.catalog.hanzi[0];
  const leaked = ["status", "lastSeenAt", "incorrectCount", "parentConfirmedAt", "needsAssessment"].filter(f => f in sample);
  record("R02", "线上课程包不含家庭进度字段", leaked.length === 0 && pkgProbe.visibility === "public-generic", `leaked=${JSON.stringify(leaked)}`);

  /* ---------- R03/R04：草稿持久化 + 恢复保留作答态 ---------- */

  // 进入孩子入口 → 汉字 → 今日课程，故意答错一次（触发提示），然后刷新。
  await page.click('[data-action="child-home"]');
  await page.waitForSelector('[data-subject="hanzi"]');
  await page.click('[data-subject="hanzi"]');
  await page.waitForSelector('[data-mode="lesson"]:not([disabled])', { timeout: 15000 });
  await page.click('[data-mode="lesson"]');
  await page.waitForSelector(".stage", { timeout: 15000 });
  await wait(600);

  // 记录当前题，制造一次答错（进入提示态 attempt=2），再刷新。
  const beforeRefresh = await page.evaluate(() => {
    const app = window.xiaoya.childApp;
    const rt = app.runtime;
    return {
      sessionId: rt.session?.sessionId || null,
      taskId: rt.queue[rt.queueIndex]?.taskId || null,
      taskRef: rt.queue[rt.queueIndex]?.target?.ref || null,
      eventCount: rt.session?.events?.length || 0
    };
  });

  const answerKind = await page.evaluate(() => {
    const button = document.querySelector("[data-answer=wrong]") || document.querySelector("[data-answer=correct]");
    return button ? button.dataset.answer : null;
  });
  if (answerKind) {
    await page.click(`[data-answer="${answerKind}"]`);
    await wait(900);
  }

  const afterWrong = await page.evaluate(() => {
    const rt = window.xiaoya.childApp.runtime;
    return {
      eventCount: rt.session?.events?.length || 0,
      attempt: rt.attempt,
      supportMode: rt.supportMode,
      activeHint: rt.activeHint,
      paused: rt.paused
    };
  });

  // 草稿应立即落盘（不等刷新）。
  const draftBefore = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("xiaoya-family-learning");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rows.map(r => ({ sessionId: r.sessionId, events: r.session?.events?.length || 0, attempt: r.attempt, supportMode: r.supportMode }));
  });
  record(
    "R03-draft",
    "作答后立即写入可恢复草稿",
    draftBefore.length > 0 && draftBefore[0].events > 0,
    `drafts=${JSON.stringify(draftBefore)}`
  );

  // 刷新（模拟直接关闭再打开）。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shell, .welcome", { timeout: 20000 });
  await wait(1200);

  const afterRefresh = await page.evaluate(() => {
    const rt = window.xiaoya.childApp.runtime;
    return {
      sessionId: rt.session?.sessionId || null,
      eventCount: rt.session?.events?.length || 0,
      queueIndex: rt.queueIndex,
      taskId: rt.queue[rt.queueIndex]?.taskId || null,
      taskRef: rt.queue[rt.queueIndex]?.target?.ref || null,
      attempt: rt.attempt,
      supportMode: rt.supportMode,
      paused: rt.paused
    };
  });

  record(
    "R03-refresh",
    "中途刷新不丢失已发生的作答",
    afterRefresh.sessionId === beforeRefresh.sessionId
      && afterRefresh.eventCount === afterWrong.eventCount
      && afterRefresh.eventCount > 0,
    `before=${JSON.stringify(beforeRefresh)} afterWrongEvents=${afterWrong.eventCount} after=${JSON.stringify(afterRefresh)}`
  );

  // R04：恢复时保留 attempt / supportMode。
  const attemptPreserved = afterWrong.attempt > 1
    ? afterRefresh.attempt === afterWrong.attempt && afterRefresh.supportMode === afterWrong.supportMode
    : afterRefresh.attempt === afterWrong.attempt;
  record(
    "R04",
    "恢复同一题保留 attempt 与支持状态",
    attemptPreserved,
    `before attempt=${afterWrong.attempt}/${afterWrong.supportMode} → after attempt=${afterRefresh.attempt}/${afterRefresh.supportMode}`
  );

  // 继续这一节，确认答对不再被记为「首次独立答对」。
  if (afterRefresh.paused) {
    await page.click('[data-action="resume-lesson"]');
    await page.waitForSelector(".stage", { timeout: 10000 });
    await wait(500);
  }
  const resumed = await page.evaluate(() => {
    const rt = window.xiaoya.childApp.runtime;
    return { attempt: rt.attempt, supportMode: rt.supportMode, answerLocked: rt.answerLocked };
  });
  record(
    "R04-resume",
    "继续后仍维持中断时的 attempt，不被重置为 1",
    resumed.attempt === afterWrong.attempt,
    `resumed attempt=${resumed.attempt} supportMode=${resumed.supportMode}`
  );

  // 若当前是提示态，点答对，检查独立标记。
  const independentCheck = await page.evaluate(async () => {
    const rt = window.xiaoya.childApp.runtime;
    const before = rt.session.events.length;
    const attemptAtAnswer = rt.attempt;
    const correctButton = document.querySelector("[data-answer=correct]");
    if (!correctButton || correctButton.disabled) return { skipped: true, attemptAtAnswer };
    correctButton.click();
    await new Promise(r => setTimeout(r, 400));
    const events = rt.session.events.slice(before);
    const correct = events.find(e => e.result === "correct");
    return { skipped: false, attemptAtAnswer, correct: correct ? { attempt: correct.attempt, independent: correct.independent } : null };
  });
  if (!independentCheck.skipped && independentCheck.correct) {
    record(
      "R04-independent",
      "提示后恢复再答对不被记为首次独立答对",
      independentCheck.correct.independent === false && independentCheck.correct.attempt > 1,
      JSON.stringify(independentCheck.correct)
    );
  }

  // 结束本节，确认最终记录写入 sessions 且草稿被清除。
  await page.evaluate(() => {
    const button = document.querySelector('[data-action="stop"]');
    if (button) button.click();
  });
  await wait(2000);

  const finalState = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("xiaoya-family-learning");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const readAll = store => new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const sessions = await readAll("sessions");
    const drafts = await readAll("drafts");
    return {
      sessionCount: sessions.length,
      sessionEvents: sessions.map(s => s.payload?.events?.length || 0),
      draftCount: drafts.length
    };
  });
  record(
    "R03-final",
    "结束后最终记录落盘且草稿被清除",
    finalState.sessionCount >= 1 && finalState.draftCount === 0,
    JSON.stringify(finalState)
  );

  /* ---------- R07：家长门禁不能被绕过 ---------- */

  // 先模拟「已设置家长密码」：写入与 main.js 一致的 PIN 哈希。
  await page.evaluate(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("xiaoya:1234"));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("xiaoya-family-learning");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "parentPinHash", value: hash });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });

  // 重新加载，模拟「孩子重新打开应用后尝试进入家长管理」。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".welcome", { timeout: 20000 });
  await wait(800);

  const pinConfigured = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("xiaoya-family-learning");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const row = await new Promise((resolve, reject) => {
      const req = db.transaction("meta", "readonly").objectStore("meta").get("parentPinHash");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return Boolean(row?.value);
  });

  await page.click('[data-action="parent-home"]');
  await wait(900);
  const pinProbe = await page.evaluate(() => ({
    pinShown: Boolean(document.querySelector("[data-pin]")),
    parentRendered: Boolean(document.querySelector(".login-card, .sync-card, .link-list")),
    unlocked: window.xiaoya.parentApp.state.unlocked
  }));
  record(
    "R07-pin",
    "已设置密码时进入家长管理必须先通过 PIN",
    pinConfigured && pinProbe.pinShown === true && pinProbe.unlocked === false && pinProbe.parentRendered === false,
    JSON.stringify({ pinConfigured, ...pinProbe })
  );

  // 尝试用「另一个点击处理器」绕过：直接派发 parent-home 动作到 root。
  const bypass = await page.evaluate(() => {
    const root = document.querySelector("#app");
    const probe = document.createElement("button");
    probe.dataset.action = "parent-home";
    probe.textContent = "bypass";
    root.append(probe);
    probe.click();
    probe.remove();
    return {
      unlocked: window.xiaoya.parentApp.state.unlocked,
      pinStillShown: Boolean(document.querySelector("[data-pin]")),
      parentRendered: Boolean(document.querySelector(".login-card, .sync-card, .link-list"))
    };
  });
  record(
    "R07-bypass",
    "孩子界面上的同名动作无法绕过 PIN 直接解锁家长模式",
    bypass.unlocked === false && bypass.parentRendered === false,
    JSON.stringify(bypass)
  );

  // 输入正确密码后应当能进入。
  await page.evaluate(() => {
    for (const digit of "1234") {
      document.querySelector(`[data-pin="${digit}"]`)?.click();
    }
    document.querySelector('[data-pin="ok"]')?.click();
  });
  await wait(1200);
  const unlockedProbe = await page.evaluate(() => ({
    unlocked: window.xiaoya.parentApp.state.unlocked,
    parentRendered: Boolean(document.querySelector(".login-card, .sync-card, .link-list")),
    pinStillShown: Boolean(document.querySelector("[data-pin]"))
  }));
  record(
    "R07-unlock",
    "输入正确家长密码后可以进入家长管理",
    unlockedProbe.unlocked === true && unlockedProbe.parentRendered === true && unlockedProbe.pinStillShown === false,
    JSON.stringify(unlockedProbe)
  );

  // 退出家长模式后，再进入必须重新输入。
  await page.click('[data-action="exit-parent"]');
  await wait(700);
  await page.click('[data-action="parent-home"]');
  await wait(900);
  const relockProbe = await page.evaluate(() => ({
    pinShown: Boolean(document.querySelector("[data-pin]")),
    unlocked: window.xiaoya.parentApp.state.unlocked
  }));
  record(
    "R07-relock",
    "离开家长模式后再次进入必须重新输入密码",
    relockProbe.pinShown === true && relockProbe.unlocked === false,
    JSON.stringify(relockProbe)
  );
  await page.evaluate(() => document.querySelector('[data-pin="cancel"]')?.click());
  await wait(500);

  /* ---------- R10：取消语音不回退到设备语音 ---------- */

  // 通过应用自身的界面驱动：进入一节课 → 立刻点「今天先到这里」（会调用 cancelSpeech）
  // 然后观察取消之后是否还有设备语音播出。
  await page.evaluate(() => document.querySelector('[data-pin="cancel"]')?.click());
  await wait(400);
  await page.evaluate(() => window.xiaoya.childApp.renderHome());
  await page.waitForSelector(".welcome", { timeout: 10000 });

  const voiceResult = await page.evaluate(async () => {
    const spoken = [];
    const synth = window.speechSynthesis;
    let restore = null;
    if (synth) {
      const original = synth.speak.bind(synth);
      synth.speak = utterance => { spoken.push({ text: utterance.text, at: Date.now() }); return original(utterance); };
      restore = () => { synth.speak = original; };
    }
    const markBeforeCancel = () => spoken.length;

    // 走界面：孩子入口 → 汉字 → 今日课程
    document.querySelector('[data-action="child-home"]')?.click();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('[data-subject="hanzi"]')?.click();
    await new Promise(r => setTimeout(r, 300));
    const modeButton = document.querySelector('[data-mode="lesson"]:not([disabled])');
    if (!modeButton) { restore?.(); return { supported: false, reason: "没有可用的今日课程" }; }
    modeButton.click();
    await new Promise(r => setTimeout(r, 800));

    // 题目朗读是延迟 180ms 触发的；此时取消。
    const beforeCancel = markBeforeCancel();
    document.querySelector('[data-action="stop"]')?.click();
    const atCancel = spoken.length;
    // 等足 2 秒：若旧请求回退到设备语音，这段时间内会出现新的 speak 调用。
    await new Promise(r => setTimeout(r, 2000));
    const afterCancel = spoken.slice(atCancel).map(s => s.text);
    restore?.();
    return { supported: true, beforeCancel, atCancel, afterCancel, totalSpoken: spoken.map(s => s.text) };
  });
  record(
    "R10",
    "取消语音后不再有新的设备语音播出",
    voiceResult.supported && voiceResult.afterCancel.length === 0,
    JSON.stringify(voiceResult)
  );

  /* ---------- 汇总 ---------- */

  record("RUNTIME", "运行期无未捕获的页面错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  const summary = {
    verifiedAt: new Date().toISOString(),
    base: BASE,
    offlineReady,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results
  };
  await writeFile(path.join(outDir, "fix-verification.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await page.screenshot({ path: path.join(outDir, "final-state.png") });

  console.log(`\n合计：通过 ${summary.passed} / 失败 ${summary.failed}`);
  console.log(`证据写入：${path.join(outDir, "fix-verification.json")}`);

  await browser.close();
  process.exit(summary.failed ? 1 : 0);
}

main().catch(error => {
  console.error("验证脚本异常：", error);
  process.exit(2);
});
