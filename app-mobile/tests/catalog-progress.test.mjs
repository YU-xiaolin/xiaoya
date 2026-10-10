// 回归测试：公开课程包不含家庭学习进度，孩子端的小测试必须靠本机真实作答证据
// 推导出 status / lastSeenAt，否则「小测试」会永远显示「暂无记录」。
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSessions, mergeCatalogProgress, statusFromObserved } from "../src/analysis.js";
import { selectTestItems } from "../src/core/test-mode.js";

// 与随应用发布的通用课程包结构一致：只有课程定义，没有 status / lastSeenAt。
const publicCatalog = {
  hanzi: [
    { ref: "ZH-0001", display: "人", optionDisplay: "人" },
    { ref: "ZH-0002", display: "大", optionDisplay: "大" },
    { ref: "ZH-0003", display: "小", optionDisplay: "小" }
  ],
  english_letter: [{ ref: "EN-0001", display: "A", optionDisplay: "A" }],
  math: []
};

function sessionWith(events, sessionId = "session-test-1", endedAt = new Date().toISOString()) {
  return {
    sessionId,
    startedAt: endedAt,
    endedAt,
    payload: { sessionId, endedAt, activityMode: "lesson", completed: true, events }
  };
}

function eventFor(ref, display, result, independent, evidenceType, recordedAt = new Date().toISOString()) {
  return { eventId: `${ref}-${recordedAt}`, recordedAt, taskId: `t-${ref}`, subject: "hanzi", targetRef: ref, targetDisplay: display, questionType: "choice", evidenceType, result, independent };
}

test("公开通用目录里没有学习状态，小测试因此无可选内容", () => {
  assert.equal(selectTestItems(publicCatalog, "hanzi", "all").length, 0);
});

test("本机独立答对会推导出可测试的状态", () => {
  const analysis = analyzeSessions([sessionWith([eventFor("ZH-0001", "人", "correct", true, "hanzi_choice")])]);
  const merged = mergeCatalogProgress(publicCatalog, analysis);

  const learned = merged.hanzi.find(item => item.ref === "ZH-0001");
  assert.equal(learned.status, "学习中");
  assert.ok(learned.lastSeenAt, "应带上最近接触时间");
  assert.equal(learned.observed.independentCorrect, 1);

  const untouched = merged.hanzi.find(item => item.ref === "ZH-0002");
  assert.equal(untouched.status, "未学");
  assert.equal(untouched.lastSeenAt, null);

  assert.deepEqual(selectTestItems(merged, "hanzi", "all").map(item => item.ref), ["ZH-0001"]);
  assert.deepEqual(selectTestItems(merged, "hanzi", "today").map(item => item.ref), ["ZH-0001"]);
});

test("提示后答对不算独立正确，状态保持薄弱或初见", () => {
  const analysis = analyzeSessions([
    sessionWith([
      eventFor("ZH-0003", "小", "incorrect", false, "hanzi_choice"),
      eventFor("ZH-0003", "小", "correct", false, "hanzi_choice")
    ])
  ]);
  const merged = mergeCatalogProgress(publicCatalog, analysis);
  assert.equal(merged.hanzi.find(item => item.ref === "ZH-0003").status, "薄弱");
});

test("稳定掌握需要三个不同场次独立答对且覆盖两种证据模式", () => {
  const at = new Date().toISOString();
  const sessions = [
    sessionWith([eventFor("ZH-0001", "人", "correct", true, "hanzi_choice", at)], "s1", at),
    sessionWith([eventFor("ZH-0001", "人", "correct", true, "hanzi_oral_reading", at)], "s2", at),
    sessionWith([eventFor("ZH-0001", "人", "correct", true, "hanzi_choice", at)], "s3", at)
  ];
  const merged = mergeCatalogProgress(publicCatalog, analyzeSessions(sessions));
  assert.equal(merged.hanzi.find(item => item.ref === "ZH-0001").status, "稳定掌握");

  // 同一场次重复答对不能凑足三个场次。
  const single = mergeCatalogProgress(publicCatalog, analyzeSessions([
    sessionWith([
      eventFor("ZH-0001", "人", "correct", true, "hanzi_choice", at),
      eventFor("ZH-0001", "人", "correct", true, "hanzi_oral_reading", at)
    ], "s-only", at)
  ]));
  assert.equal(single.hanzi.find(item => item.ref === "ZH-0001").status, "学习中");
});

test("statusFromObserved 不把「未接触」当成已学", () => {
  assert.equal(statusFromObserved(null), "未学");
  assert.equal(statusFromObserved({ independentCorrect: 0, incorrect: 0 }), "初见");
});
