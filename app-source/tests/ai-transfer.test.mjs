import assert from "node:assert/strict";
import test from "node:test";
import { collectAiVoiceRequirements, compileAiLesson, missingAiVoiceTexts, parseAiResult } from "../src/ai-transfer.js";
import { childFacingAudienceIssue, choicePromptLeaksAnswer, validateLesson } from "../src/protocol.js";
import { buildPracticeTasks, buildPreviewTasks } from "../src/test-mode.js";
import { taskHintVariants } from "../src/targeted-hints.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../src/voice-text.js";

// Synthetic progress only; no child records are used in public tests.
const catalog = {
  hanzi: [..."人大山水火木本月天田白目"].map((display, index) => ({
    ref: `ZH-${String(index + 1).padStart(4, "0")}`, display, optionDisplay: display,
    status: index < 4 ? "学习中" : "未学"
  })),
  english_letter: [..."ABCDEFGH"].map((display, index) => ({
    ref: `AL-${String(index + 1).padStart(2, "0")}`, display: `${display} ${display.toLowerCase()}`,
    optionDisplay: display, status: index < 2 ? "初见" : "未学"
  }))
};
const context = { catalog, generatedAt: "2026-10-16T12:00:00Z", lessonId: "lesson-transfer-synthetic" };
function result() {
  return {
    protocol: "FAMILY_LEARNING_AI_RESULT_V1", schemaVersion: 1,
    exportId: "export-synthetic", baseRevision: "synthetic-revision", basedOnSessionIds: ["session-synthetic"],
    stateUpdate: { ignoredEventIds: [], changes: [] },
    lessonPlan: {
      title: "轻松复习", teacherNote: "先复习，再认识一点新内容。", estimatedMinutes: 8,
      reducedNewHanziReason: "模拟薄弱复习", previousNewHanziRefs: ["ZH-0006"],
      nextPreviewHanziRefs: ["ZH-0008", "ZH-0009"],
      tasks: [
        { subject: "hanzi", targetRef: "ZH-0006", questionType: "choice", isNew: false },
        { subject: "english_letter", targetRef: "AL-01", questionType: "choice", isNew: false },
        { subject: "hanzi", targetRef: "ZH-0005", questionType: "recognition", isNew: true }
      ]
    }, parentReport: "这是一份模拟报告。"
  };
}

test("编课保留模型安排的目标次序、题型、新学和衔接，不修改原输入", () => {
  const bundle = result();
  const before = structuredClone({ bundle, context });
  const lesson = compileAiLesson(bundle, context);
  assert.deepEqual(lesson.tasks.map(task => [task.subject, task.target.ref, task.questionType, task.isNew]),
    bundle.lessonPlan.tasks.map(task => [task.subject, task.targetRef, task.questionType, task.isNew]));
  assert.deepEqual(lesson.tasks.map(task => task.taskId), [1, 2, 3].map(number => `transfer-export-synthetic-${number}`));
  assert.equal(lesson.lessonId, context.lessonId);
  assert.equal(lesson.generatedAt, context.generatedAt);
  assert.equal(lesson.isBootstrap, false);
  assert.deepEqual(lesson.basedOnSessionIds, ["session-synthetic"]);
  assert.deepEqual(lesson.metadata, { estimatedMinutes: 8, newHanziCount: 1, newLetterCount: 0,
    previousNewHanziRefs: ["ZH-0006"], nextPreviewHanziRefs: ["ZH-0008", "ZH-0009"] });
  assert.deepEqual(validateLesson(lesson), []);
  assert.deepEqual({ bundle, context }, before);
});

test("同一结果重复编课一致，选择题四项不泄题，全部课堂文案直接对孩子说", () => {
  const first = compileAiLesson(result(), context);
  assert.deepEqual(compileAiLesson(result(), context), first);
  for (const task of first.tasks) {
    assert.equal(childFacingAudienceIssue(task), null);
    assert.equal(choicePromptLeaksAnswer(task), false);
    if (task.questionType === "choice") {
      assert.equal(task.options.length, 4);
      assert.equal(new Set(task.options).size, 4);
      assert.ok(task.options.includes(task.correctAnswer));
      assert.notEqual(task.speechPrompt, task.prompt);
    }
  }
  assert.equal(first.tasks[2].evidenceType, "hanzi_oral_reading");
});

test("未知目标、未知预习和巩固编号直接拒绝，不静默省掉任务", () => {
  for (const change of [
    bundle => { bundle.lessonPlan.tasks[0].targetRef = "ZH-9999"; },
    bundle => { bundle.lessonPlan.nextPreviewHanziRefs = ["ZH-9999"]; },
    bundle => { bundle.lessonPlan.previousNewHanziRefs = ["ZH-9999"]; },
    bundle => { bundle.lessonPlan.nextPreviewHanziRefs = ["ZH-0008", "ZH-0008"]; }
  ]) {
    const bundle = result(); change(bundle);
    assert.throws(() => compileAiLesson(bundle, context), /不认识|安排不完整/u);
  }
});

test("不扩展数学写入、英语口读或自造题型", () => {
  for (const task of [
    { subject: "math", targetRef: "M-SYNTHETIC", questionType: "choice", isNew: false },
    { subject: "english_letter", targetRef: "AL-01", questionType: "recognition", isNew: false },
    { subject: "hanzi", targetRef: "ZH-0001", questionType: "spelling", isNew: false }
  ]) {
    const bundle = result(); bundle.lessonPlan.tasks = [task];
    assert.throws(() => compileAiLesson(bundle, context), /任务不适用/u);
  }
});

test("课程最多20题、新汉字与字母各最多6个，缺少足够干扰项不能编课", () => {
  const tooMany = result(); tooMany.lessonPlan.tasks = Array(21).fill(tooMany.lessonPlan.tasks[0]);
  assert.throws(() => compileAiLesson(tooMany, context), /1 到 20/u);
  for (const subject of ["hanzi", "english_letter"]) {
    const bundle = result();
    bundle.lessonPlan.tasks = catalog[subject].slice(0, 7).map(item => ({ subject, targetRef: item.ref,
      questionType: subject === "hanzi" ? "recognition" : "choice", isNew: true }));
    assert.throws(() => compileAiLesson(bundle, context), /不能超过 6/u);
  }
  const sparse = { ...context, catalog: { ...catalog, english_letter: catalog.english_letter.slice(0, 3) } };
  assert.throws(() => compileAiLesson(result(), sparse), /还不能使用/u);
});

test("JSON支持UTF8 BOM，拒绝代码围栏、截断内容和非对象结果", () => {
  assert.deepEqual(parseAiResult(`\uFEFF${JSON.stringify(result())}`), result());
  for (const text of ["```json\n{}\n```", '{"lessonPlan":', "null", "[]"]) {
    assert.throws(() => parseAiResult(text), /文件|结果/u);
  }
});

test("语音要求覆盖整课、实际预习和巩固、所有提示变体及两句固定表扬", () => {
  const lesson = compileAiLesson(result(), context);
  const requirements = collectAiVoiceRequirements(lesson, catalog);
  const texts = new Set(requirements.map(clip => clip.text));
  assert.equal(texts.size, requirements.length);
  const allModes = [[lesson.tasks, "lesson"]];
  for (const subject of ["hanzi", "english_letter"]) {
    const tasks = lesson.tasks.filter(task => task.subject === subject);
    allModes.push([buildPreviewTasks(subject, tasks, catalog, subject === "hanzi" ? lesson.metadata.nextPreviewHanziRefs : undefined, 4), "preview"]);
    allModes.push([buildPracticeTasks(subject, tasks, catalog, subject === "hanzi" ? lesson.metadata.previousNewHanziRefs : undefined, () => 0.25), "practice"]);
  }
  for (const [tasks, mode] of allModes) for (const task of tasks) {
    for (const text of [questionSpeechText(task), demonstrationSpeechText(task), reinforcementSpeechText(task, mode),
      ...taskHintVariants(task).map(hint => hintSpeechText(task, hint))].filter(Boolean)) {
      assert.ok(texts.has(text), `${mode}: ${text}`);
    }
  }
  const wood = lesson.tasks[0];
  assert.ok(texts.has(hintSpeechText(wood, taskHintVariants(wood).find(hint => hint.includes("小短横")))));
  assert.ok(texts.has("真棒，答对了！"));
  assert.ok(texts.has("太好了，这次答对了！"));
  assert.ok(texts.has("这是字母 C。请看清它的大写和小写样子。"));
  assert.ok(!texts.has("这是字母 A。请看清它的大写和小写样子。") || lesson.tasks.some(task => task.correctAnswer === "A"));
});

test("语音参数与生成器一致，首次出现的相同文本只保留一份", () => {
  const requirements = collectAiVoiceRequirements(compileAiLesson(result(), context), catalog);
  const find = text => requirements.find(clip => clip.text === text);
  assert.deepEqual(find("真棒，答对了！"), { text: "真棒，答对了！", voice: "zh-CN-XiaoyiNeural",
    rate: "+18%", pitch: "+8Hz", volume: "+0%" });
  assert.equal(find("请读出屏幕上的汉字。").rate, "+14%");
  assert.equal(find("火，火苗、火车。").rate, "+10%");
  for (const clip of requirements) {
    assert.equal(clip.voice, "zh-CN-XiaoyiNeural");
    assert.equal(clip.volume, "+0%");
  }
});

test("缺语音检查识别不存在、参数错配、错误文件类型或路径，允许清单保留其他旧录音", () => {
  const requirements = collectAiVoiceRequirements(compileAiLesson(result(), context), catalog);
  const clips = Object.fromEntries(requirements.map((clip, index) => [clip.text, { ...clip, fileName: `${index}.mp3` }]));
  clips["无关旧录音"] = { fileName: "old.mp3" };
  assert.deepEqual(missingAiVoiceTexts(requirements, { clips }), []);
  delete clips[requirements[0].text];
  clips[requirements[1].text].pitch = "+0Hz";
  clips[requirements[2].text].fileName = "wrong.wav";
  clips[requirements[3].text].fileName = "../escape.mp3";
  assert.deepEqual(missingAiVoiceTexts(requirements, { clips }), requirements.slice(0, 4).map(clip => clip.text));
  assert.equal(missingAiVoiceTexts(requirements, null).length, requirements.length);
});
