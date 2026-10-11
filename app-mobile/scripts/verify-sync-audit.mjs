// Isolated browser integration: real IndexedDB and UI, mocked cloud SDK.
import { chromium, devices } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const out = process.env.XIAOYA_VERIFY_OUT;
if (!out) throw new Error("Set XIAOYA_VERIFY_OUT outside the checkout");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1234/chrome-win64/chrome.exe") });
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); }
try {
  await page.goto(process.env.XIAOYA_SOURCE_URL || "http://127.0.0.1:5199/");
  await page.waitForFunction(() => window.xiaoya);
  const results = await page.evaluate(async () => {
    const { cloud } = await import("/src/cloud.js");
    const store = await import("/src/store.js");
    const db = await import("/src/db.js");
    const sync = await import("/src/sync.js");
    cloud.auth.getSession = async () => ({ data: { user: { id: "simulated-user", email: "test@example.invalid" } }, error: null });
    const original = await store.loadActivePackage();
    const payload = structuredClone(original.package);
    payload.lesson.title = "模拟云端课程";
    const canonicalHash = await store.sha256Hex(store.canonicalJson(payload));
    const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reordered(value[k])])) : value;
    let remote = { course_key: sync.FAMILY_PACKAGE_KEY, version: 5, payload: reordered(payload), payload_sha256: canonicalHash, is_active: true };
    cloud.database.from = () => {
      const query = { select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve({ data: [remote], error: null }).then(resolve, reject); } };
      return query;
    };
    const fact = store.newSession(payload.lesson);
    fact.endedAt = new Date().toISOString(); fact.stopReason = "parent_stopped";
    await db.putSession({ sessionId: fact.sessionId, payload: fact, uploaded: false });
    const recordsBefore = JSON.stringify(await db.listSessions());
    const result = [];
    const updated = await sync.updateCourse();
    result.push(["JSONB key reordering accepts canonical hash", updated.updated && updated.version === 5]);
    result.push(["same version unchanged content skips safely", (await sync.updateCourse()).reason === "up-to-date"]);
    const corrupt = structuredClone((await store.loadActivePackage()));
    corrupt.package.lesson.title = "模拟本地损坏";
    await db.putPackage("active", corrupt);
    result.push(["same version repairs different local content", (await sync.updateCourse()).updated && (await store.loadActivePackage()).package.lesson.title === payload.lesson.title]);
    remote = { ...remote, version: 4 };
    result.push(["explicit cloud rollback can replace a higher local version", (await sync.updateCourse()).version === 4]);
    const beforeBad = JSON.stringify(await store.loadActivePackage());
    remote = { ...remote, payload_sha256: "0".repeat(64) };
    let rejected = false;
    try { await sync.updateCourse(); } catch (e) { rejected = e.kind === "hash-mismatch"; }
    result.push(["invalid hash preserves active course", rejected && JSON.stringify(await store.loadActivePackage()) === beforeBad]);
    result.push(["course updates preserve pending session bytes", JSON.stringify(await db.listSessions()) === recordsBefore]);
    await (await import("/src/main.js")).saveParentPin("1234");
    return result;
  });
  for (const [name, ok] of results) check(name, ok);
  await page.click("[data-action='parent-home']");
  await page.waitForSelector(".pin-card");
  for (const digit of "1234") await page.click(`[data-pin='${digit}']`);
  await page.click("[data-pin='ok']");
  await page.waitForSelector("[data-action='open-settings']");
  await page.click("[data-action='open-settings']");
  await page.waitForSelector("[data-action='backup']");
  await page.click("[data-action='parent-home']");
  await page.waitForSelector("[data-action='open-settings']");
  check("parent internal back keeps approved PIN session", await page.locator(".pin-card").count() === 0);
  await page.click("[data-action='exit-parent']");
  await page.waitForSelector(".entry-card.child");
  await page.click("[data-action='parent-home']");
  await page.waitForSelector(".pin-card");
  check("re-entering parent requires PIN again", true);
  await page.click("[data-pin='cancel']");
  await page.evaluate(async () => {
    const { cloud } = await import("/src/cloud.js");
    cloud.auth.getSession = async () => { await new Promise(r => setTimeout(r, 400)); return { data: { user: { id: "simulated-user" } }, error: null }; };
    window.xiaoya.parentApp.unlock();
    window.xiaoya.parentApp.render();
    window.xiaoya.parentApp.lock();
    window.xiaoya.childApp.renderHome();
  });
  await page.waitForTimeout(700);
  check("delayed parent render cannot cover child home", await page.locator(".entry-card.child").count() === 1);
} catch (e) { check("integration completes", false, e.stack); }
finally { await browser.close(); }
const report = { at: new Date().toISOString(), type: "isolated-sdk-mock-real-browser", passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks };
await writeFile(path.join(out, "sync-audit.json"), JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
