// Real media, IndexedDB and service worker checks on an isolated production build.
// No family files or cloud account are read or changed by this script.
import { chromium, webkit, devices } from "playwright-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

let base = process.env.XIAOYA_BASE_URL || "http://127.0.0.1:5210/";
const out = process.env.XIAOYA_VERIFY_OUT;
if (!out) throw new Error("Set XIAOYA_VERIFY_OUT to an evidence directory outside the source checkout.");
await mkdir(out, { recursive: true });
const engine = process.env.XIAOYA_ENGINE || "chromium";
let origin;
if (engine === "webkit") {
  // Playwright's WebKit offline flag rejects even literal worker responses:
  // https://github.com/microsoft/playwright/issues/42775
  // Stop an isolated origin instead, leaving service-worker requests functional.
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg", ".png": "image/png", ".svg": "image/svg+xml" };
  origin = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const target = path.resolve(dist, `.${pathname.endsWith("/") ? pathname + "index.html" : pathname}`);
      if (!target.startsWith(dist)) { res.writeHead(403).end(); return; }
      const data = await readFile(target);
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Content-Length": data.length });
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${origin.address().port}/`;
}
const browser = await (engine === "webkit" ? webkit : chromium).launch(engine === "webkit" ? {} : {
  executablePath: process.env.XIAOYA_CHROME || path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1234/chrome-win64/chrome.exe")
});
const checks = [];
const errors = [];
const unverified = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
}
async function fresh() {
  const context = await browser.newContext({ ...devices["iPhone 14"], locale: "zh-CN" });
  await context.addInitScript(() => {
    window.__media = [];
    window.__mediaLog = [];
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!window.__media.includes(this)) {
        window.__media.push(this);
        for (const kind of ["playing", "ended", "pause", "error"]) this.addEventListener(kind, () => {
          window.__mediaLog.push({ kind, src: this.src, id: window.__media.indexOf(this) });
        });
      }
      if (window.__blockAudio && /\/voice\//.test(this.src)) return Promise.reject(new DOMException("Test denied playback", "NotAllowedError"));
      if (window.__failDirect && /\/voice\//.test(this.src)) return Promise.reject(new DOMException("Test direct source failure", "NotSupportedError"));
      return nativePlay.call(this);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.xiaoya, { timeout: 20000 });
  await page.waitForFunction(() => document.documentElement.dataset.offlineReady === "true", { timeout: 20000 });
  return { context, page };
}
async function start(page, subject = "hanzi") {
  await page.click("[data-action='child-home']");
  await page.click(`[data-subject='${subject}']`);
  await page.click("[data-mode='lesson']");
  await page.waitForSelector(".lesson");
}
async function rows(page, name) {
  return page.evaluate(name => new Promise((resolve, reject) => {
    const open = indexedDB.open("xiaoya-family-learning");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(name);
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  }), name);
}
async function clickAnswer(page, correct = true) {
  const answer = await page.evaluate(correct => {
    const r = window.xiaoya.childApp.runtime;
    const t = r.queue[r.queueIndex];
    return t.questionType === "choice" ? {
      selector: `[data-choice=${JSON.stringify(correct ? t.correctAnswer : t.choices.find(x => x !== t.correctAnswer))}]`
    } : { selector: `[data-answer='${correct ? "correct" : "wrong"}']` };
  }, correct);
  await page.click(answer.selector);
}
async function waitDraft(page, predicate) {
  for (let i = 0; i < 50; i++) {
    const all = await rows(page, "drafts");
    if (predicate(all[0])) return all[0];
    await page.waitForTimeout(30);
  }
  throw new Error("Draft was not persisted");
}
try {
  {
    const { context, page } = await fresh();
    await start(page);
    await page.waitForFunction(() => window.__mediaLog.some(e => e.kind === "playing" && /\/voice\//.test(e.src)), { timeout: 15000 });
    check("first question uses real MP3 playback", true);
    await page.waitForFunction(() => window.__mediaLog.some(e => e.kind === "ended" && /\/voice\//.test(e.src)), { timeout: 15000 });
    const previous = await page.evaluate(() => window.__mediaLog.length);
    await page.click("[data-action='repeat-question']");
    await page.waitForFunction(n => window.__mediaLog.slice(n).some(e => e.kind === "playing" && /\/voice\//.test(e.src)), previous, { timeout: 10000 });
    check("repeated question reuses unlocked media element", await page.evaluate(() => window.__media.length === 1));
    await clickAnswer(page);
    await waitDraft(page, d => d?.feedbackAdvancePending && d.answerLocked);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-action='resume-lesson']");
    await page.click("[data-action='resume-lesson']");
    check("reload during correct-answer feedback advances once", await page.evaluate(() => window.xiaoya.childApp.runtime.queueIndex === 1));
    await page.screenshot({ path: path.join(out, `${engine}-after-refresh.png`) });
    await clickAnswer(page);
    await waitDraft(page, d => d?.feedbackAdvancePending && d.queueIndex === 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-action='resume-lesson']");
    await page.click("[data-action='resume-lesson']");
    await page.waitForSelector(".done-card");
    const saved = await rows(page, "sessions");
    check("last-question reload saves one immutable session", saved.length === 1 && saved[0].payload.events.filter(e => e.result === "correct").length === 2);
    check("final save removes draft atomically", (await rows(page, "drafts")).length === 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".entry-card.child");
    check("saved lesson is not restored as unfinished", (await page.locator("[data-action='resume-lesson']").count()) === 0);

    // All six stages and composition controls must remain reachable on a small phone.
    await page.click("[data-action='child-home']");
    await page.click("[data-subject='math']");
    for (let stage = 1; stage <= 6; stage++) {
      await page.click(`[data-math-stage='${stage}']`);
      await page.click("[data-mode='lesson']");
      await page.waitForSelector(".lesson");
      const valid = await page.evaluate(() => {
        const r = window.xiaoya.childApp.runtime;
        return r.queue.length > 0 && r.queue.every(t => t.subject === "math");
      });
      check(`math stage ${stage} starts`, valid);
      if (stage === 4) {
        check("composition board is interactive", await page.locator(".composition-board").count() === 1);
        await page.locator("[data-composition='left'], [data-composition='right']").first().click();
        check("composition control survives interaction", await page.locator(".composition-board").count() === 1);
      }
      await page.click("[data-action='lesson-back']");
    }
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      check(`layout fits ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    check("viewport allows accessibility zoom", !(await page.getAttribute("meta[name=viewport]", "content")).includes("user-scalable=no"));
    await context.close();
  }
  {
    const { context, page } = await fresh();
    await start(page);
    await clickAnswer(page, false);
    await waitDraft(page, d => d?.attempt === 2 && d.supportMode === "hint");
    await page.click("[data-action='lesson-back']");
    await page.waitForTimeout(700);
    check("pause stops current and delayed audio", await page.evaluate(() => window.__media.every(m => m.paused)));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-action='resume-lesson']");
    await page.click("[data-action='resume-lesson']");
    check("wrong-answer reload retains hint and attempt", await page.evaluate(() => {
      const r = window.xiaoya.childApp.runtime;
      return r.attempt === 2 && r.supportMode === "hint";
    }));
    await clickAnswer(page);
    await waitDraft(page, d => d?.feedbackAdvancePending);
    check("hinted correct answer is not independent evidence", await page.evaluate(() => window.xiaoya.childApp.runtime.session.events.filter(e => e.result === "correct").every(e => !e.independent)));
    await page.click("[data-action='next-feedback']");
    await page.waitForSelector("[data-action='repeat-question']");
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__blockAudio = true);
    await page.click("[data-action='repeat-question']");
    await page.waitForSelector(".voice-notice:not([hidden])");
    check("denied audio displays explicit retry control", await page.locator("[data-action='retry-voice']").isVisible());
    await page.evaluate(() => { window.__blockAudio = false; window.__mediaLog = []; });
    await page.click("[data-action='retry-voice']");
    await page.waitForFunction(() => window.__mediaLog.some(e => e.kind === "playing" && /\/voice\//.test(e.src)), { timeout: 10000 });
    check("explicit retry recovers real playback", true);
    if (engine !== "webkit") {
      await page.evaluate(() => { window.__failDirect = true; window.__mediaLog = []; });
      await page.click("[data-action='repeat-question']");
      await page.waitForFunction(() => window.__mediaLog.some(e => e.kind === "playing" && /^blob:/.test(e.src)));
      check("direct media failure recovers from cached MP3 bytes", true);
      await page.evaluate(() => window.__failDirect = false);
    }
    await page.click("[data-action='lesson-back']");

    // Use only a fully cached file and reload the page to exercise persisted offline state.
    const audioUrl = await page.evaluate(async () => {
      const cache = await caches.open("xiaoya-voice-v1");
      const all = await cache.keys();
      return all[0]?.url;
    });
    if (!audioUrl) throw new Error("No lesson audio was cached");
    let supportsBlob = true;
    if (engine === "webkit") {
      supportsBlob = await page.evaluate(async url => {
        const blob = await (await fetch(url)).blob();
        const source = URL.createObjectURL(blob);
        const control = new Audio(source);
        try { await control.play(); control.pause(); return true; }
        catch { return false; }
        finally { URL.revokeObjectURL(source); }
      }, audioUrl);
    }
    if (origin) {
      await new Promise(resolve => { origin.close(resolve); origin.closeAllConnections(); });
      check("offline origin is unavailable without service worker", await fetch(base).then(() => false, () => true));
    } else await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-action='resume-lesson']");
    const range = await page.evaluate(async url => {
      const response = await fetch(url, { headers: { Range: "bytes=0-1" } });
      return { status: response.status, size: (await response.arrayBuffer()).byteLength, range: response.headers.get("content-range") };
    }, audioUrl);
    check("offline byte-range audio response", range.status === 206 && range.size === 2, range);
    await page.click("[data-action='resume-lesson']");
    if (supportsBlob) {
      await page.waitForFunction(() => window.__mediaLog.some(e => e.kind === "playing" && (/\/voice\//.test(e.src) || /^blob:/.test(e.src))), null, { timeout: 15000 });
      check("cold offline reload retains recorded voice manifest and playback", true);
    } else {
      unverified.push({ name: "WebKit offline media playback", reason: "Windows WebKit rejects the same blob MP3 in the online control (media error 4). Verify on iPhone Safari or macOS WebKit." });
      console.log("UNVERIFIED WebKit offline media: online blob control is unsupported by this runtime");
    }
    await page.screenshot({ path: path.join(out, `${engine}-offline-audio.png`) });
    await context.close();
  }
} catch (e) {
  check("browser audit completes", false, e.stack);
} finally {
  await browser.close();
  if (origin?.listening) await new Promise(resolve => origin.close(resolve));
}
check("no uncaught application errors", errors.length === 0, errors);
const report = { at: new Date().toISOString(), engine, base, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, unverified, checks };
await writeFile(path.join(out, `${engine}-mobile-audit.json`), JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
