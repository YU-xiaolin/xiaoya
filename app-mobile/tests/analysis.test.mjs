// 验证学习分析：独立正确、提示后正确、稳定掌握规则与每日趋势。
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSessions, mergeCatalogProgress, reviewPriorities, dailyTrend } from "../src/analysis.js";

function session(sessionId, endedAt, events) {
  return {
    protocol: "FAMILY_LEARNING_SESSION_V1",
    schemaVersion: 1,
    sessionId,
    lessonId: "lesson-demo",
    startedAt: endedAt,
    endedAt,
    completed: true,
    stopReason: "completed",
    activityMode: "lesson",
    events
  };
}

function event(targetRef, result, { attempt = 1, independent = false, evidenceType = "choice", at = null } = {}) {
  return {
    eventId: `${targetRef}-${result}-${attempt}-${at || ""}`,
    recordedAt: at || "2026-09-01T00:00:00.000Z",
    taskId: `task-${targetRef}`,
    subject: "hanzi",
    targetRef,
    targetDisplay: targetRef,
    questionType: evidenceType === "hanzi_oral_reading" ? "recognition" : "choice",
    evidenceType,
    attempt,
    result,
    independent,
    hintUsed: attempt > 1,
    responseTimeMs: 1200
  };
}

test("提示后答对不计为独立正确", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [
      event("H-001", "incorrect", { attempt: 1 }),
      event("H-001", "hint_shown", { attempt: 1, independent: false }),
      event("H-001", "correct", { attempt: 2, independent: false })
    ])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-001");
  assert.equal(target.correct, 1);
  assert.equal(target.independentCorrect, 0);
  assert.equal(target.incorrect, 1);
  assert.equal(target.stableByRule, false);
});

test("稳定掌握需要 ≥3 个场次的独立答对并覆盖 ≥2 种证据模式", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-002", "correct", { independent: true, evidenceType: "choice" })]),
    session("s2", "2026-09-02T10:00:00.000Z", [event("H-002", "correct", { independent: true, evidenceType: "choice" })]),
    session("s3", "2026-09-03T10:00:00.000Z", [event("H-002", "correct", { independent: true, evidenceType: "hanzi_oral_reading" })])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-002");
  assert.equal(target.sessionCount, 3);
  assert.equal(target.evidenceTypes.length, 2);
  assert.equal(target.independentCorrect, 3);
  assert.equal(target.stableByRule, true);
});

test("错误与提示事件不能补足稳定掌握的场次与证据模式", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-010", "correct", { independent: true, evidenceType: "choice" })]),
    session("s2", "2026-09-02T10:00:00.000Z", [event("H-010", "correct", { independent: true, evidenceType: "choice" })]),
    session("s3", "2026-09-03T10:00:00.000Z", [
      event("H-010", "incorrect"),
      event("H-010", "hint_shown", { independent: false }),
      event("H-010", "demonstrated", { independent: false, evidenceType: "math_digit_reading" })
    ])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-010");
  assert.equal(target.sessionCount, 2, "只有独立答对的场次才计入");
  assert.equal(target.evidenceTypes.length, 1, "非独立答对的证据类型不计入");
  assert.equal(target.stableByRule, false);
});

test("同一场次多次答对不算稳定掌握", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [
      event("H-003", "correct", { independent: true, evidenceType: "choice" }),
      event("H-003", "correct", { independent: true, evidenceType: "hanzi_oral_reading" })
    ])
  ]);
  const target = analysis.targets.find(item => item.targetRef === "H-003");
  assert.equal(target.sessionCount, 1);
  assert.equal(target.stableByRule, false);
});

test("场次统计与正确率", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [
      event("H-004", "correct", { independent: true }),
      event("H-004", "incorrect"),
      event("H-005", "correct", { independent: true })
    ])
  ]);
  assert.equal(analysis.sessionCount, 1);
  assert.equal(analysis.totals.correct, 2);
  assert.equal(analysis.totals.incorrect, 1);
  assert.equal(analysis.timeline[0].accuracy, 67);
});

test("目录合并只追加观察数据，不改变正式状态字段", () => {
  const catalog = { hanzi: [{ ref: "H-006", display: "六", status: "初见", incorrectCount: 0 }], english_letter: [], math: [] };
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-006", "incorrect")])
  ]);
  const merged = mergeCatalogProgress(catalog, analysis);
  assert.equal(merged.hanzi[0].status, "初见");
  assert.equal(merged.hanzi[0].observed.incorrect, 1);
  assert.equal(merged.hanzi[0].observed.stableByRule, false);
});

test("复习优先级按错误次数排序", () => {
  const catalog = {
    hanzi: [
      { ref: "H-007", display: "七" },
      { ref: "H-008", display: "八" }
    ],
    english_letter: [],
    math: []
  };
  const analysis = analyzeSessions([
    session("s1", "2026-09-05T00:00:00.000Z", [event("H-007", "incorrect")]),
    session("s2", "2026-09-04T00:00:00.000Z", [
      event("H-008", "incorrect"), event("H-008", "incorrect"),
      event("H-008", "incorrect"), event("H-008", "incorrect")
    ])
  ]);
  const priorities = reviewPriorities(catalog, analysis);
  assert.equal(priorities[0].ref, "H-008");
});

test("每日趋势按天聚合", () => {
  const analysis = analyzeSessions([
    session("s1", "2026-09-01T10:00:00.000Z", [event("H-009", "correct", { independent: true })]),
    session("s2", "2026-09-01T18:00:00.000Z", [event("H-009", "incorrect")]),
    session("s3", "2026-09-02T10:00:00.000Z", [event("H-009", "correct", { independent: true })])
  ]);
  const trend = dailyTrend(analysis);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].day, "2026-09-01");
  assert.equal(trend[0].sessions, 2);
  assert.equal(trend[1].accuracy, 100);
});
