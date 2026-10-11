import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMobileSpeechPlayer } from "../src/mobile-speech-player.js";
import { canonicalJson } from "../src/store.js";
import { validatePackagePayload } from "../src/sync.js";
import { validateSessionPayload } from "../src/session-validation.js";
import { cloud, listRemoteSessions, activateCourse, signOut } from "../src/cloud.js";

const pack = { clips: { first: { fileName: "first.mp3" }, second: { fileName: "second.mp3" } } };

test("退出登录失败必须向调用者报告", async () => {
  const original = cloud.auth.signOut;
  cloud.auth.signOut = async () => ({ error: new Error("simulated sign-out failure") });
  try { await assert.rejects(signOut(), /simulated sign-out failure/); }
  finally { cloud.auth.signOut = original; }
});
function mediaFactory() {
  const elements = [];
  const createAudio = () => {
    const element = { playCalls: [], paused: true,
      play() { this.paused = false; this.playCalls.push(this.src); return this.reject ? Promise.reject(this.reject) : Promise.resolve(); },
      pause() { this.paused = true; } };
    elements.push(element);
    return element;
  };
  return { createAudio, elements };
}

test("手机语音在手势内调用 play，并复用已预热的同一音频元素", async () => {
  const factory = mediaFactory();
  const player = createMobileSpeechPlayer(factory);
  player.unlock();
  const first = player.speak("first", pack);
  assert.equal(factory.elements.length, 1);
  assert.equal(factory.elements[0].playCalls.at(-1), "./voice/first.mp3");
  await Promise.resolve(); // The unlock completion must not stop newer playback.
  assert.equal(factory.elements[0].paused, false);
  factory.elements[0].onended();
  assert.equal(await first, "ended");
  const second = player.speak("second", pack);
  assert.equal(factory.elements.length, 1);
  factory.elements[0].onended();
  assert.equal(await second, "ended");
});

test("手机播放被浏览器拦截时返回 blocked，允许按钮重试", async () => {
  const factory = mediaFactory();
  const player = createMobileSpeechPlayer(factory);
  player.unlock();
  factory.elements[0].reject = Object.assign(new Error("tap required"), { name: "NotAllowedError" });
  assert.equal(await player.speak("first", pack), "blocked");
  factory.elements[0].reject = null;
  const retry = player.speak("first", pack);
  factory.elements[0].onended();
  assert.equal(await retry, "ended");
});

test("手机语音取消会立即停止实际媒体，旧播放不能恢复", async () => {
  const factory = mediaFactory();
  const player = createMobileSpeechPlayer(factory);
  const first = player.speak("first", pack);
  const second = player.speak("second", pack);
  assert.equal(await first, "cancelled");
  player.cancel();
  assert.equal(await second, "cancelled");
  assert.equal(factory.elements[0].paused, true);
});

test("手机音频下载或播放挂起有超时，不会卡住反馈", async () => {
  const factory = mediaFactory();
  const player = createMobileSpeechPlayer({ ...factory, timeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 100);
  assert.equal(await player.speak("first", pack), "unavailable");
  clearTimeout(keepAlive);
  assert.equal(factory.elements[0].paused, true);
});

test("JSONB 字段重排不改变课程校验，题序变化仍会改变校验", () => {
  assert.equal(canonicalJson({ b: 2, a: [{ z: 1, y: 2 }] }), canonicalJson({ a: [{ y: 2, z: 1 }], b: 2 }));
  assert.notEqual(canonicalJson({ tasks: [1, 2] }), canonicalJson({ tasks: [2, 1] }));
});

test("课程校验拒绝跨科目编号、内容错配和非数组，且不会崩溃", async () => {
  const original = JSON.parse(await readFile(new URL("../public/course/course-package.json", import.meta.url), "utf8"));
  const wrong = structuredClone(original);
  wrong.lesson.tasks[0].target = { ref: original.catalog.english_letter[0].ref, display: original.catalog.english_letter[0].display };
  assert.ok(validatePackagePayload(wrong).length);
  const mismatch = structuredClone(original);
  mismatch.lesson.tasks[0].target.display = "错字";
  assert.ok(validatePackagePayload(mismatch).some(message => /显示内容/.test(message)));
  for (const field of ["hanzi", "english_letter", "math"]) {
    const malformed = structuredClone(original);
    malformed.catalog[field] = {};
    assert.ok(validatePackagePayload(malformed).length);
  }
});

function mockDatabase({ rows = [], failAt = -1, activateError = false } = {}) {
  const calls = [];
  const original = cloud.database.from;
  cloud.database.from = table => {
    const call = { table, filters: [], updates: null, range: null };
    calls.push(call);
    const query = {
      select() { return this; }, order() { return this; },
      range(from, to) { call.range = [from, to]; return this; },
      eq(key, value) { call.filters.push(["eq", key, value]); return this; },
      neq(key, value) { call.filters.push(["neq", key, value]); return this; },
      gte(key, value) { call.filters.push(["gte", key, value]); return this; },
      update(value) { call.updates = value; return this; },
      then(resolve, reject) {
        if (calls.length === failAt || (activateError && call.updates?.is_active)) return Promise.resolve({ error: new Error("simulated failure") }).then(resolve, reject);
        const data = call.range ? rows.slice(call.range[0], call.range[1] + 1) : [{ version: 2 }];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    };
    return query;
  };
  return { calls, restore: () => { cloud.database.from = original; } };
}

test("云记录导出完整分页超过 500 份，并按孩子与学习日期过滤", async () => {
  const rows = Array.from({ length: 523 }, (_, index) => ({ session_id: `simulated-${index}` }));
  const mock = mockDatabase({ rows });
  try {
    const result = await listRemoteSessions({ studentCode: "simulated-child", since: "2026-01-01" });
    assert.equal(result.length, 523);
    assert.deepEqual(mock.calls.map(call => call.range), [[0, 199], [200, 399], [400, 599]]);
    assert.ok(mock.calls.every(call => call.filters.some(filter => filter[1] === "student_code")));
    assert.ok(mock.calls.every(call => call.filters.some(filter => filter[1] === "ended_at")));
  } finally { mock.restore(); }
});

test("云记录第二页失败时拒绝导出残缺结果", async () => {
  const mock = mockDatabase({ rows: Array.from({ length: 523 }, () => ({})), failAt: 2 });
  try { await assert.rejects(listRemoteSessions(), /simulated failure/); }
  finally { mock.restore(); }
});

test("新课程激活失败时不关闭旧课程", async () => {
  const mock = mockDatabase({ activateError: true });
  try {
    await assert.rejects(activateCourse({ courseKey: "simulated-course", version: 2 }), /simulated failure/);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].updates.is_active, true);
  } finally { mock.restore(); }
});

test("课程发布先确认新版本，再仅关闭其他版本", async () => {
  const mock = mockDatabase();
  try {
    await activateCourse({ courseKey: "simulated-course", version: 2 });
    assert.deepEqual(mock.calls.map(call => call.updates.is_active), [true, false]);
    assert.ok(mock.calls[1].filters.some(filter => filter[0] === "neq" && filter[1] === "version" && filter[2] === 2));
  } finally { mock.restore(); }
});

test("备份恢复拒绝只有编号的伪记录和虚假独立作答", () => {
  assert.ok(validateSessionPayload({ sessionId: "simulated-only" }).length);
  const sample = { protocol: "FAMILY_LEARNING_SESSION_V1", schemaVersion: 1, sessionId: "simulated-session", lessonId: "simulated-lesson", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", completed: true, stopReason: "completed", events: [{ eventId: "simulated-event", recordedAt: "2026-01-01T00:00:30Z", taskId: "simulated-task", subject: "hanzi", targetRef: "ZH-0001", targetDisplay: "人", questionType: "recognition", attempt: 1, result: "correct", independent: true, hintUsed: false, responseTimeMs: 1000 }] };
  assert.deepEqual(validateSessionPayload(sample), []);
  sample.events[0].hintUsed = true;
  assert.ok(validateSessionPayload(sample).some(message => /独立正确/.test(message)));
});
