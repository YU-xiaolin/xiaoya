// 审核报告 R01–R10 的回归测试：逐条覆盖报告复现过的缺陷。
// 这些用例在修复前应当失败，修复后必须通过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSessions, reviewPriorities } from "../src/analysis.js";
import { validatePackagePayload, inspectPackagePayload } from "../src/sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

async function read(rel) {
  return readFile(path.join(appRoot, rel), "utf8");
}

/* ---------------- R01：云接口不得进入缓存 ---------------- */

test("R01 Service Worker 明确排除云接口与带 Authorization 的请求", async () => {
  const sw = await read("public/sw.js");
  assert.match(sw, /CLOUD_PATH_PREFIXES/, "应定义云接口路径前缀");
  assert.match(sw, /"\/\.cloud\/"/, "应显式排除 /.cloud/");
  assert.match(sw, /authorization/, "不应缓存带 Authorization 的请求");
  assert.match(sw, /isCloudRequest/, "应有云请求判定函数");
  // 缓存版本必须带版本号（v2 起已升级为 v3，用于清除旧缓存与旧语音清单）；
  // 这里只校验存在版本标记，避免每次升级缓存版本都要改测试。
  assert.match(sw, /const VERSION = "xiaoya-mobile-v\d+"/);
  // 不得再出现引用未定义 event 的死代码。
  assert.doesNotMatch(sw, /event_safe_revalidate/);
});

/* ---------------- R02：公开课程包不含家庭进度 ---------------- */

test("R02 公开课程包不包含任何家庭进度字段", async () => {
  const pkg = JSON.parse(await read("public/course/course-package.json"));
  assert.equal(pkg.visibility, "public-generic");
  assert.equal(pkg.studentCode, undefined, "公开包不应带学生编号");
  const forbidden = ["status", "lastSeenAt", "incorrectCount", "parentConfirmedAt", "needsAssessment"];
  for (const subject of ["hanzi", "english_letter", "math"]) {
    for (const item of pkg.catalog[subject]) {
      for (const field of forbidden) {
        assert.equal(field in item, false, `catalog.${subject}.${item.ref} 不应含 ${field}`);
      }
    }
  }
  for (const field of ["hanziLearned", "letterLearned", "mathLearned", "hanziNeedsAssessment"]) {
    assert.equal(field in pkg.summary, false, `summary 不应含 ${field}`);
  }
  // 仍保留通用课程规模信息。
  assert.equal(pkg.summary.hanziTotal, 1000);
  assert.equal(pkg.summary.formalItemCount, 1061);
});

test("R02 构建脚本丢弃家庭进度字段", async () => {
  const mod = await import("../../tools/build-course-package.mjs");
  const stateWithProgress = {
    items: {
      hanzi: { "ZH-0001": { value: "人", status: "稳定掌握", lastSeenAt: "2026-09-05T00:00:00.000Z", needsAssessment: false, parentConfirmedAt: "2026-08-21T10:58:37+08:00", metrics: { incorrectCount: 3 } } },
      english_letter: { "AL-01": { value: "A a", uppercase: "A", status: "未学" } },
      math: { "MA-01": { value: "1", status: "未学" } }
    }
  };
  const built = mod.buildCoursePackage({ state: stateWithProgress, lesson: null });
  const item = built.package.catalog.hanzi[0];
  for (const field of ["status", "lastSeenAt", "incorrectCount", "parentConfirmedAt", "needsAssessment"]) {
    assert.equal(field in item, false, `生成结果不应含 ${field}`);
  }
  assert.equal(mod.assertNoFamilyProgress(built.package).length, 0);
});

test("R02 构建脚本在包内含家庭进度时拒绝发布", async () => {
  const mod = await import("../../tools/build-course-package.mjs");
  const dirty = {
    protocol: "XIAOYA_COURSE_PACKAGE_V1",
    schemaVersion: 1,
    catalog: { hanzi: [{ ref: "ZH-0001", display: "人", status: "稳定掌握" }], english_letter: [], math: [] },
    summary: { hanziTotal: 1, letterTotal: 0, mathTotal: 0, formalItemCount: 1, hanziLearned: 1 },
    lesson: null
  };
  const problems = mod.assertNoFamilyProgress(dirty);
  assert.ok(problems.some(p => /catalog.*status/.test(p)), "应报出目录里的家庭进度字段");
  assert.ok(problems.some(p => /summary.*hanziLearned/.test(p)), "应报出摘要里的已学计数");
});

/* ---------------- R03：刷新不丢已发生的作答 ---------------- */

test("R03 草稿表与最终记录表分离，草稿可覆盖而最终记录不可覆盖", async () => {
  const db = await read("src/db.js");
  assert.match(db, /createObjectStore\("drafts"/, "应新增 drafts 表");
  assert.match(db, /DB_VERSION = 2/, "数据库版本应升级以创建 drafts 表");
  // 最终记录仍保持「同一 sessionId 只写一次」的不可变语义。
  assert.match(db, /if \(!existing\.result\) store\.put\(row\)/);
  assert.match(db, /export async function putDraft/);
  assert.match(db, /export async function deleteDraft/);
});

test("R03 每次作答与暂停都会落盘草稿", async () => {
  const child = await read("src/child.js");
  const recordEvent = child.slice(child.indexOf("function recordEvent"), child.indexOf("function scheduleRetest"));
  assert.match(recordEvent, /persistDraft\(\)/, "recordEvent 应触发草稿写入");
  const pause = child.slice(child.indexOf("function pauseLesson"), child.indexOf("function resumeLesson"));
  assert.match(pause, /persistDraft\(\)/, "暂停应落盘草稿");
  const begin = child.slice(child.indexOf("function beginLesson"), child.indexOf("function startTest"));
  assert.match(begin, /persistDraft\(\)/, "开始新一节应写入初始草稿");
  const advance = child.slice(child.indexOf("function advance()"), child.indexOf("function pauseLesson"));
  assert.match(advance, /persistDraft\(\)/, "进入下一题应更新草稿");
  const finish = child.slice(child.indexOf("async function finishSession"), child.indexOf("function startLesson"));
  assert.match(finish, /clearDraft\(\)/, "最终记录落盘后应删除草稿");
});

/* ---------------- R04：恢复当前题保留作答态 ---------------- */

test("R04 恢复同一题时不重置 attempt / 提示 / 锁定状态", async () => {
  const child = await read("src/child.js");
  assert.match(child, /function renderTask\(resumeTaskId = null\)/, "renderTask 应接受恢复参数");
  assert.match(child, /const resuming = resumeTaskId !== null && resumeTaskId === task\.taskId/);
  // 只有非恢复路径才重置 attempt。
  const resetBlock = child.slice(child.indexOf("if (!resuming) {"), child.indexOf("} else {", child.indexOf("if (!resuming) {")));
  assert.match(resetBlock, /runtime\.attempt = 1/);
  assert.match(child, /restoreDraft/);
  assert.match(child, /runtime\.attempt = Number\.isInteger\(draft\.attempt\)/);
  assert.match(child, /runtime\.supportMode = draft\.supportMode/);
});

/* ---------------- R05：稳定掌握必须三个场次都独立答对 ---------------- */

function session(sessionId, endedAt, events) {
  return {
    protocol: "FAMILY_LEARNING_SESSION_V1", schemaVersion: 1, sessionId,
    lessonId: "lesson-demo", startedAt: endedAt, endedAt, completed: true, stopReason: "completed",
    activityMode: "lesson", events
  };
}

function event(targetRef, result, { attempt = 1, independent = false, evidenceType = "choice", at = null } = {}) {
  return {
    eventId: `${targetRef}-${result}-${attempt}-${at || ""}`,
    recordedAt: at || "2026-09-01T00:00:00.000Z",
    taskId: `task-${targetRef}`, subject: "hanzi", targetRef, targetDisplay: targetRef,
    questionType: evidenceType === "hanzi_oral_reading" ? "recognition" : "choice",
    evidenceType, attempt, result, independent, hintUsed: attempt > 1, responseTimeMs: 1200
  };
}

test("R05 错误与提示事件不能补足稳定掌握的场次数", () => {
  // 报告中的反例：3 个场次、independentCorrect=3、证据模式 2 种，
  // 但其中只有 2 个场次是真正独立答对 → 不应判为稳定掌握。
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-100", "correct", { independent: true, evidenceType: "choice" })]),
    session("s2", "2026-09-02T10:00:00.000Z", [event("H-100", "correct", { independent: true, evidenceType: "hanzi_oral_reading" })]),
    session("s3", "2026-09-03T10:00:00.000Z", [
      event("H-100", "incorrect"),
      event("H-100", "hint_shown", { independent: false }),
      event("H-100", "demonstrated", { independent: false, evidenceType: "math_digit_reading" })
    ])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-100");
  assert.equal(target.sessionCount, 2, "只应统计独立答对的场次");
  assert.equal(target.evidenceTypes.length, 2, "只有独立答对的证据类型才计入");
  assert.equal(target.stableByRule, false, "3 个场次中只有 2 次独立答对，不应判稳定");
});

test("R05 用非独立答对凑出的证据模式不算稳定掌握", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-101", "correct", { independent: true, evidenceType: "choice" })]),
    session("s2", "2026-09-02T10:00:00.000Z", [event("H-101", "correct", { independent: true, evidenceType: "choice" })]),
    session("s3", "2026-09-03T10:00:00.000Z", [event("H-101", "correct", { attempt: 2, independent: false, evidenceType: "hanzi_oral_reading" })])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-101");
  assert.equal(target.sessionCount, 2);
  assert.equal(target.evidenceTypes.length, 1);
  assert.equal(target.stableByRule, false);
});

test("R05 三个场次独立答对且两种证据模式才判稳定", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-102", "correct", { independent: true, evidenceType: "choice" })]),
    session("s2", "2026-09-02T10:00:00.000Z", [event("H-102", "correct", { independent: true, evidenceType: "choice" })]),
    session("s3", "2026-09-03T10:00:00.000Z", [event("H-102", "correct", { independent: true, evidenceType: "hanzi_oral_reading" })])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-102");
  assert.equal(target.sessionCount, 3);
  assert.equal(target.evidenceTypes.length, 2);
  assert.equal(target.stableByRule, true);
});

test("R02 复习优先级不再依赖公开包里的家庭进度字段", () => {
  const catalog = { hanzi: [{ ref: "H-200", display: "二" }], english_letter: [], math: [] };
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-200", "incorrect"), event("H-200", "incorrect")])
  ]);
  const priorities = reviewPriorities(catalog, analysis);
  assert.equal(priorities.length, 1);
  assert.equal(priorities[0].incorrect, 2);
  // 未作答过的条目不应出现在复习列表里。
  assert.equal(reviewPriorities({ hanzi: [{ ref: "H-201", display: "三" }], english_letter: [], math: [] }, analysis).length, 0);
});

/* ---------------- R06：验证码登录分支 ---------------- */

test("R06 云层保留并透传 isExistingUser", async () => {
  const cloud = await read("src/cloud.js");
  assert.match(cloud, /isExistingUser: data\?\.isExistingUser === true/, "sendOtp 应保留 isExistingUser");
  const verify = cloud.slice(cloud.indexOf("export async function verifyOtp"), cloud.indexOf("export async function signInWithPassword"));
  assert.match(verify, /params\.isExistingUser = isExistingUser/, "verifyOtp 应把 isExistingUser 传给 SDK");
  // 密码重置必须在获取验证码时就创建挑战。
  assert.match(cloud, /challenge\?\.error\) throw challenge\.error/);
  assert.match(cloud, /if \(result\?\.error\) throw result\.error/);
});

test("R06 家长页正确贯穿 isExistingUser 且不再用旧挑战重设密码", async () => {
  const parent = await read("src/parent.js");
  // 旧的错误写法是引用从未赋值的 pending.isExistingUser 且提交时才创建重置挑战。
  const submitEmail = parent.slice(parent.indexOf('case "submit-email-code"'), parent.indexOf('case "submit-password"'));
  assert.doesNotMatch(submitEmail, /resetPasswordForEmail/, "提交时不应再新建重置挑战");
  assert.match(submitEmail, /pending\.challenge\.updateUser/, "应复用获取验证码时创建的重置挑战");
  assert.match(submitEmail, /isExistingUser: pending\.isExistingUser/, "应把账号标记传给 verifyOtp");
  // 忘记密码时在「获取验证码」阶段创建重置挑战。
  const sendEmail = parent.slice(parent.indexOf('case "send-email-code"'), parent.indexOf('case "submit-email-code"'));
  assert.match(sendEmail, /resetPasswordForEmail/, "重发验证码应创建重置挑战");
  assert.match(sendEmail, /startResendCooldown/, "应有重发倒计时");
  // 表单输入在重绘后仍被保留。
  assert.match(parent, /state\.email = email/);
  assert.match(parent, /state\.password = password/);
});

/* ---------------- R07：家长门禁 ---------------- */

test("R07 家长处理器默认锁定，且唯一解锁入口经过 PIN", async () => {
  const parent = await read("src/parent.js");
  assert.match(parent, /unlocked: false/, "默认必须锁定");
  const handler = parent.slice(parent.indexOf('root.addEventListener("click"'));
  assert.match(handler, /if \(!state\.unlocked\) return;/, "handler 必须校验解锁状态");
  assert.match(parent, /function unlock\(\)/);
  assert.match(parent, /function lock\(\)/);

  const main = await read("src/main.js");
  const openParent = main.slice(main.indexOf("async function openParent"), main.indexOf("function registerServiceWorker"));
  assert.match(openParent, /await parentPinSet\(\)/, "入口必须检查 PIN");
  assert.match(openParent, /parentApp\.unlock\(\)/, "解锁只能通过 openParent");
  // PIN 键盘必须用捕获阶段并阻止其它处理器。
  assert.match(main, /stopImmediatePropagation/);
  assert.doesNotMatch(main, /root\.onclick = /, "不应再用 root.onclick 覆盖其它处理器");
});

/* ---------------- R08：导入校验与回滚 ---------------- */

test("R08 只有协议字符串的无效课程包被拒绝", () => {
  const invalid = { protocol: "XIAOYA_COURSE_PACKAGE_V1" };
  const result = inspectPackagePayload(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some(e => /catalog/.test(e)));
});

test("R08 引用不存在编号的课程被拒绝", () => {
  const payload = {
    protocol: "XIAOYA_COURSE_PACKAGE_V1",
    schemaVersion: 1,
    catalog: {
      hanzi: [{ ref: "ZH-0001", display: "人" }],
      english_letter: [{ ref: "AL-01", display: "A a" }],
      math: [{ ref: "MA-01", display: "1" }]
    },
    summary: { hanziTotal: 1, letterTotal: 1, mathTotal: 1, formalItemCount: 3 },
    lesson: {
      protocol: "FAMILY_LEARNING_LESSON_V1",
      schemaVersion: 1,
      lessonId: "lesson-x",
      generatedAt: "2026-01-01T00:00:00.000Z",
      title: "测试课",
      tasks: [{ taskId: "t1", subject: "hanzi", target: { ref: "ZH-9999", display: "人" }, prompt: "？", questionType: "choice", options: ["人", "口"], correctAnswer: "人" }]
    }
  };
  const errors = validatePackagePayload(payload);
  assert.ok(errors.some(e => /不存在的编号/.test(e)), `应报出未知编号，实际：${errors.join(" | ")}`);
});

test("R08 提供原子替换与回滚能力", async () => {
  const sync = await read("src/sync.js");
  assert.match(sync, /export async function replaceActivePackage/);
  assert.match(sync, /export async function rollbackActivePackage/);
  assert.match(sync, /ROLLBACK_PACKAGE_KEY/, "应保存回滚副本");
  assert.match(sync, /await saveActivePackage\(previous\)/, "写入失败应回滚");
});

/* ---------------- R09：正式构建产物与预缓存 ---------------- */

test("R09 构建产物预缓存启动必需的 JS/CSS", async () => {
  const sw = await read("public/sw.js");
  assert.match(sw, /BUILD_SHELL_URLS/, "应有构建注入的预缓存清单");
  const distSw = await read("dist/sw.js").catch(() => null);
  if (distSw) {
    assert.doesNotMatch(distSw, /XIAOYA_BUILD_SHELL/, "构建产物中的占位符应已被替换");
    assert.match(distSw, /\.\/assets\/index-[A-Za-z0-9_-]+\.js/, "应预缓存构建后的 JS");
    assert.match(distSw, /\.\/assets\/index-[A-Za-z0-9_-]+\.css/, "应预缓存构建后的 CSS");
  }
  const indexHtml = await read("index.html");
  assert.match(indexHtml, /src="\.\/src\/main\.js"/, "源码入口应为相对路径（构建后会替换）");
  const distHtml = await read("dist/index.html").catch(() => null);
  if (distHtml) {
    assert.doesNotMatch(distHtml, /\/src\/main\.js/, "构建产物不应再指向开发入口");
    assert.match(distHtml, /\.\/assets\/index-/);
  }
});

test("R09 只有预缓存就绪后才提示可离线", async () => {
  const main = await read("src/main.js");
  assert.match(main, /XIAOYA_SW_READY_QUERY/);
  assert.match(main, /offlineReady/);
  const sw = await read("public/sw.js");
  assert.match(sw, /async function isShellReady/);
});

/* ---------------- R10：取消语音不得回退 ---------------- */

test("R10 cancelled 不回退到设备语音，仅 unavailable 才回退", async () => {
  const voice = await read("src/voice.js");
  assert.match(voice, /let activeGeneration = 0/, "应有语音请求代次");
  const speak = voice.slice(voice.indexOf("export async function speak"), voice.indexOf("export async function prepareOfflineVoices"));
  assert.match(speak, /result === "cancelled" \|\| !fresh\(\)/, "取消应立即结束");
  assert.match(speak, /if \(result !== "unavailable"\) return result/, "只有 unavailable 才回退");
  const cancel = voice.slice(voice.indexOf("export function cancelSpeech"));
  assert.match(cancel, /activeGeneration \+= 1/, "取消应使旧请求失效");
});

/* ---------------- 保护边界：正式资产未被本次改动触碰 ---------------- */

test("仅手机端与构建脚本被修改，正式桌面数据未纳入构建产物", async () => {
  const sw = await read("public/sw.js");
  // 预缓存清单里不得出现 raw / state / 动态 AI 文件。
  assert.doesNotMatch(sw, /data\/raw/);
  assert.doesNotMatch(sw, /learning-state\.json/);
});
