import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  activeMathStage,
  buildMathLesson,
  buildMathPracticeTasks,
  buildMathTask,
  buildMathTestTasks,
  buildAllMathVoiceTasks,
  arithmeticPairs,
  mathVariantCount,
  mathStageProgress
} from "../src/math-mode.js";
import { validateLesson } from "../src/protocol.js";

const rawCatalog = JSON.parse(await readFile(new URL("../../app-source/src-tauri/resources/数学启蒙课程.json", import.meta.url), "utf8"));
const catalog = rawCatalog.map(item => ({ ...item, display: item.value, status: "未学", incorrectCount: 0 }));

test("数学正式目录覆盖六阶段 35 个学习目标", () => {
  assert.equal(catalog.length, 35);
  assert.deepEqual(mathStageProgress(catalog).map(stage => stage.total), [12, 10, 5, 4, 2, 2]);
});

test("第一次数学课从数字 0、数量 0、数字 1、数量 1 开始", () => {
  const lesson = buildMathLesson(catalog, new Date("2026-08-24T10:00:00+08:00"));
  assert.equal(lesson.metadata.mathStage, 1);
  assert.deepEqual(lesson.metadata.newMathRefs, ["M-NUM-0", "M-QTY-0", "M-NUM-1", "M-QTY-1"]);
  assert.equal(lesson.tasks.length, 8);
  assert.equal(lesson.tasks.filter(task => task.questionType === "recognition").length, 2);
  assert.ok(lesson.tasks.filter(task => task.questionType === "choice").every(task => task.options.length === 4));
  assert.deepEqual(validateLesson(lesson), []);
});

test("自动推荐保留基础顺序，自主选课不改变进度", () => {
  const progressed = catalog.map(item => Number(item.stage) === 1 ? { ...item, status: "学习中" } : item);
  assert.equal(activeMathStage(catalog), 1);
  assert.equal(activeMathStage(progressed), 2);
  const before = structuredClone(catalog);
  for (let stage = 1; stage <= 6; stage += 1) {
    const lesson = buildMathLesson(catalog, new Date(), { stage, random: () => 0.25 });
    assert.equal(lesson.metadata.mathStage, stage);
    assert.deepEqual(validateLesson(lesson), []);
    assert.ok(lesson.tasks.some(task => catalog.find(item => item.ref === task.target.ref).stage === stage));
    assert.ok(lesson.metadata.newMathRefs.length <= 4);
  }
  assert.deepEqual(catalog, before);
});

test("数学题同时提供视觉题面、四个选项、提示与示范", () => {
  const addition = buildMathTask(catalog.find(item => item.ref === "M-ADD-5"), 0, "test");
  assert.match(addition.visualPrompt, /先有：🍎 🍎\n又添：🍎\n2 \+ 1 ＝ ？$/u);
  assert.equal(addition.correctAnswer, "3");
  assert.equal(addition.options.length, 4);
  assert.ok(addition.hint.includes("小物品"));
  assert.ok(addition.demonstration.includes("等于 3"));
});

test("十以内加减覆盖全部合法算式和两种表示，不生成负数或超十答案", () => {
  for (const kind of ["addition", "subtraction"]) {
    const item = catalog.find(value => value.kind === kind && value.level === 10);
    const pairs = arithmeticPairs(kind, 10);
    assert.equal(pairs.length, 66);
    const seen = new Set();
    for (let variant = 0; variant < mathVariantCount(item); variant += 1) {
      const task = buildMathTask(item, variant);
      const [, a, operator, b] = task.visualPrompt.match(/(\d+) ([+−]) (\d+) ＝ ？$/u);
      const expected = operator === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
      assert.equal(Number(task.correctAnswer), expected);
      assert.ok(expected >= 0 && expected <= 10);
      assert.equal(new Set(task.options).size, 4);
      assert.ok(task.options.includes(task.correctAnswer));
      seen.add(`${a}${operator}${b}`);
    }
    assert.equal(seen.size, 66);
    assert.ok(seen.has(kind === 'addition' ? '0+10' : '10−10'));
  }
});

test("运算课先做两题数量分合，再各练五题加减且覆盖零与十", () => {
  const voiceTasks = buildAllMathVoiceTasks(catalog);
  const voiceTexts = new Set(voiceTasks.map(task => task.speechPrompt));
  const layouts = new Set();
  for (let repeat = 0; repeat < 20; repeat += 1) {
    const lesson = buildMathLesson(catalog, new Date(), { stage: 6 });
    assert.equal(lesson.tasks.length, 12);
    assert.deepEqual(lesson.tasks.slice(0, 2).map(task => task.target.ref), ['M-QTY-6', 'M-COMP-5']);
    for (const ref of ['M-ADD-10', 'M-SUB-10']) {
      const tasks = lesson.tasks.filter(task => task.target.ref === ref);
      assert.equal(tasks.length, 5);
      assert.equal(new Set(tasks.map(task => task.speechPrompt)).size, 5);
      assert.ok(tasks.some(task => ref === 'M-ADD-10' ? task.correctAnswer === '10' : task.speechPrompt.startsWith('10 ')));
      assert.equal(new Set(tasks.map(task => task.evidenceType)).size, 2);
    }
    assert.ok(lesson.tasks.every(task => voiceTexts.has(task.speechPrompt)));
    layouts.add(lesson.tasks.map(task => task.speechPrompt).join('|'));
  }
  assert.ok(layouts.size > 1, '重新训练应能换题');
});

test("看数字题直接请孩子回答，听数字仍使用四选一", () => {
  const item = catalog.find(candidate => candidate.ref === "M-NUM-3");
  const reading = buildMathTask(item, 0, "test");
  const listening = buildMathTask(item, 1, "test");
  assert.equal(reading.questionType, "recognition");
  assert.equal(reading.evidenceType, "math_digit_reading");
  assert.equal(reading.prompt, "请说出屏幕上的数字。");
  assert.equal(reading.speechPrompt, "请说出屏幕上的数字。");
  assert.equal(reading.context, "先自己想一想，再大声说出来。");
  assert.doesNotMatch(`${reading.prompt}${reading.speechPrompt}${reading.context}${reading.hint}`, /孩子|家长/u);
  assert.equal(reading.visualPrompt, "3");
  assert.equal(reading.options, undefined);
  assert.equal(listening.questionType, "choice");
  assert.equal(listening.evidenceType, "math_digit_listening");
  assert.equal(listening.visualPrompt, "🔊");
  assert.equal(listening.options.length, 4);
});

test("数学巩固按目标换变式，目录中的数字不被固定为认读题", () => {
  const learned = catalog.slice(0, 4).map(item => ({ ...item, status: "初见" }));
  const reading = buildMathPracticeTasks(learned, 4, () => 0);
  const listening = buildMathPracticeTasks(learned, 4, () => 0.99);
  assert.deepEqual(reading.filter(task => task.target.ref.startsWith("M-NUM")).map(task => task.questionType), ["recognition", "recognition"]);
  assert.deepEqual(listening.filter(task => task.target.ref.startsWith("M-NUM")).map(task => task.questionType), ["choice", "choice"]);
});

test("相同数学答案的选项位置可变化，避免记位置作答", () => {
  const learned = [{ ...catalog.find(item => item.ref === "M-QTY-3"), status: "初见" }];
  const [first] = buildMathPracticeTasks(learned, 1, () => 0);
  const [second] = buildMathPracticeTasks(learned, 1, () => 0.99);
  assert.equal(first.correctAnswer, second.correctAnswer);
  assert.notEqual(first.options.indexOf(first.correctAnswer), second.options.indexOf(second.correctAnswer));
  for (const random of [() => 0, () => 0.99]) {
    const [task] = buildMathTestTasks(learned, random, 1);
    assert.equal(new Set(task.options).size, 4);
    assert.ok(task.options.includes(task.correctAnswer));
  }
});

test("分与合新课先动手分合，再用数字表示同一分法", () => {
  const lesson = buildMathLesson(catalog, new Date(), { stage: 4, random: () => 0.25 });
  assert.deepEqual(lesson.tasks.filter((_, index) => index % 2 === 0).map(task => task.target.ref),
    ["M-COMP-2", "M-COMP-3"]);
  assert.equal(lesson.tasks.length, 4);
  const two = lesson.tasks.filter(task => task.target.ref === "M-COMP-2");
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(task => task.evidenceType), ["math_visual_model", "math_transfer"]);
  assert.deepEqual(two.map(task => task.composition), [{ whole: 2, left: 1 }, { whole: 2, left: 1 }]);
  assert.equal(two[0].visualPrompt, undefined);
  assert.equal(two[1].visualPrompt, "2 ＝ 1 ＋ ？");
  assert.deepEqual(validateLesson(lesson), []);
});

test("分与合每课只选两个相邻的数，优先照顾尚未理解的目标", () => {
  const withStatuses = statuses => catalog.map(item => ({
    ...item,
    status: statuses[item.ref] ?? item.status
  }));
  const numbers = items => buildMathLesson(items, new Date(), { stage: 4, random: () => 0.5 })
    .tasks.filter((_, index) => index % 2 === 0).map(task => task.composition.whole);
  assert.deepEqual(numbers(withStatuses({ "M-COMP-2": "理解", "M-COMP-3": "薄弱" })), [3, 4]);
  assert.deepEqual(numbers(withStatuses({ "M-COMP-2": "理解", "M-COMP-3": "理解",
    "M-COMP-4": "理解", "M-COMP-5": "初见" })), [4, 5]);
  assert.deepEqual(numbers(withStatuses({ "M-COMP-2": "稳定掌握", "M-COMP-3": "理解",
    "M-COMP-4": "理解", "M-COMP-5": "理解" })), [3, 4]);
});

test("加减课的分合热身总是先摆苹果，且分法能在各次课变化", () => {
  const five = catalog.find(item => item.ref === "M-COMP-5");
  assert.equal(mathVariantCount(five), 8);
  for (let pair = 0; pair < 4; pair += 1) {
    const model = buildMathTask(five, pair * 2);
    const transfer = buildMathTask(five, pair * 2 + 1);
    assert.equal(model.composition.left, pair + 1);
    assert.equal(model.evidenceType, "math_visual_model");
    assert.equal(transfer.evidenceType, "math_transfer");
    assert.equal(model.correctAnswer, transfer.correctAnswer);
    assert.doesNotMatch(model.prompt, new RegExp(model.correctAnswer));
  }
  for (const random of [() => 0, () => 0.99]) {
    const lesson = buildMathLesson(catalog, new Date(), { stage: 6, random });
    assert.equal(lesson.tasks[1].target.ref, "M-COMP-5");
    assert.equal(lesson.tasks[1].evidenceType, "math_visual_model");
  }
});

test("比较题在窄屏也明确标出左右两边", () => {
  const comparison = buildMathTask(catalog.find(item => item.ref === "M-CMP-MORE"), 0, "test");
  assert.match(comparison.visualPrompt, /^左边：/);
  assert.match(comparison.visualPrompt, /\n右边：/);
});

test("数学全部内容测试也在一次测试中连续完成", () => {
  const learned = catalog.map(item => ({ ...item, status: "学习中" }));
  const tasks = buildMathTestTasks(learned, () => 0.25, learned.length);
  assert.equal(tasks.length, 35);
  assert.equal(new Set(tasks.map(task => task.target.ref)).size, 35);
  assert.ok(tasks.filter(task => task.questionType === "choice")
    .every(task => task.options.includes(task.correctAnswer)));
  assert.ok(tasks.filter(task => task.questionType === "recognition")
    .every(task => task.evidenceType === "math_digit_reading" && !task.options));
});
