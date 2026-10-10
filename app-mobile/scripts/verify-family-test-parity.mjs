// 「小小测试」与电脑版一致性验证。
//
// 需求：手机端的测试范围必须和电脑版一致 —— 都按「家里已经学过的内容」出题，
// 而不是要求先在这台手机上重新学一遍。
// 现状：随应用发布的公开课程包是通用课程定义（不含家庭进度，属隐私修复），
// 所以「按家里进度出题」要靠家长登录后点「更新学习课程」下载**家庭私有课程包**。
//
// 本脚本在隔离浏览器里注入一份由正式状态生成的等价家庭课程包（不联网、不写正式数据），
// 校验：三个学科的小测试范围与电脑版正式状态完全一致。
//
// 用法：node scripts/verify-family-test-parity.mjs [baseUrl] [familyPackageJson]
import { chromium, devices } from "playwright-core";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "output", "work-20261010-0930-mobile-bugfix");
const baseUrl = process.argv[2] || "http://127.0.0.1:5199/";
const packagePath = process.argv[3] || path.join(outDir, "family-course-package.json");

const EXECUTABLES = [
  process.env.PLAYWRIGHT_CHROMIUM,
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe")
].filter(Boolean);
const executablePath = EXECUTABLES.find(candidate => existsSync(candidate));
if (!executablePath) throw new Error("没有找到本机 Chromium，请设置 PLAYWRIGHT_CHROMIUM 环境变量。");

const family = JSON.parse(await readFile(packagePath, "utf8"));
const expected = {
  hanzi: family.payload.catalog.hanzi.filter(item => item.status && item.status !== "未学").length,
  english_letter: family.payload.catalog.english_letter.filter(item => item.status && item.status !== "未学").length,
  math: family.payload.catalog.math.filter(item => item.status && item.status !== "未学").length
};

await mkdir(outDir, { recursive: true });
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();

// 注入家庭私有课程包：等价于家长登录后点「更新学习课程」下载到的内容。
async function injectFamilyPackage() {
  await page.evaluate(async ({ payload, sha256 }) => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open("xiaoya-family-learning");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await open();
    const write = (storeName, value) => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    await write("packages", { key: "active", package: payload, sha256, receivedAt: new Date().toISOString(), source: "family-private", version: 2 });
    await write("meta", { key: "packageVersion", value: 2 });
    await write("meta", { key: "packageReceivedAt", value: new Date().toISOString() });
  }, { payload: family.payload, sha256: family.sha256 });
}

async function readTestCard(subject) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 20000 });
  await page.click("[data-action='child-home']");
  await page.waitForSelector(`[data-subject='${subject}']`);
  await page.click(`[data-subject='${subject}']`);
  await page.waitForSelector("[data-mode='test']", { timeout: 8000 });
  const card = page.locator("[data-mode='test']");
  return {
    disabled: await card.isDisabled(),
    text: (await card.innerText()).replace(/\s+/g, " ").trim()
  };
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 20000 });
  await injectFamilyPackage();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 20000 });

  const hanzi = await readTestCard("hanzi");
  record("汉字小测试可用（不要求先在本机学）", !hanzi.disabled, hanzi.text);
  record("汉字范围与电脑版一致", hanzi.text.includes(`已学 ${expected.hanzi} 个字`), `期望已学 ${expected.hanzi} 个字 · 实际「${hanzi.text}」`);

  const letter = await readTestCard("english_letter");
  record("英语字母范围与电脑版一致", !letter.disabled && letter.text.includes(`已学 ${expected.english_letter} 个`), `期望 ${expected.english_letter} · 实际「${letter.text}」`);

  const math = await readTestCard("math");
  record("数学小测试范围与电脑版一致", !math.disabled && math.text.includes(`${expected.math} 道题`), `期望 ${expected.math} 道题 · 实际「${math.text}」`);

  // 进入测试设置页：范围选项应与电脑版一致（「全部内容」可用）
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".entry-card.child", { timeout: 20000 });
  await page.click("[data-action='child-home']");
  await page.waitForSelector("[data-subject='hanzi']");
  await page.click("[data-subject='hanzi']");
  await page.waitForSelector("[data-mode='test']");
  await page.click("[data-mode='test']");
  await page.waitForSelector("[data-test-scope='all']", { timeout: 8000 });
  const allCount = (await page.locator("[data-test-scope='all']").innerText()).replace(/\s+/g, " ").trim();
  record("“全部内容”范围可用且题量与家庭已学一致", !(await page.locator("[data-test-scope='all']").isDisabled()) && allCount.includes(`${expected.hanzi} 题`), allCount);
  await page.screenshot({ path: path.join(outDir, "verify-family-test-parity.png") });
} catch (error) {
  record("脚本执行未抛异常", false, error.message);
} finally {
  await context.close();
  await browser.close();
}

const summary = {
  at: new Date().toISOString(),
  baseUrl,
  packagePath,
  familyPackageSha256: family.sha256,
  expected,
  passed: results.filter(item => item.ok).length,
  failed: results.filter(item => !item.ok).length,
  results
};
await writeFile(path.join(outDir, "verify-family-test-parity.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`\n合计 ${summary.passed} 通过 / ${summary.failed} 失败；结果写入 ${path.join(outDir, "verify-family-test-parity.json")}`);
if (summary.failed) process.exitCode = 1;
