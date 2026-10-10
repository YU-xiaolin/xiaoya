import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROTOCOLS, validateLesson } from "../src/protocol.js";

const initialLesson = JSON.parse(await readFile(new URL("../src-tauri/bootstrap/initial-next-lesson.json", import.meta.url), "utf8"));

test("启动课程符合 V1 前端协议", () => {
  assert.equal(initialLesson.protocol, PROTOCOLS.lesson);
  assert.deepEqual(validateLesson(initialLesson), []);
});

test("拒绝英语单词学科", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks[0].subject = "english_word";
  assert.match(validateLesson(lesson).join("\n"), /仅支持 hanzi、english_letter 或 math/);
});

test("拒绝超过六个新汉字", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks = ["人", "大", "小", "山", "水", "火", "田"].map((display, index) => ({
    taskId: `new-${index}`,
    subject: "hanzi",
    questionType: "recognition",
    isNew: true,
    prompt: "读一读",
    target: { ref: `ZH-${String(index + 1).padStart(4, "0")}`, display },
    hint: "提示",
    demonstration: display
  }));
  assert.match(validateLesson(lesson).join("\n"), /新汉字不得超过 6 个/);
});

test("允许六个新字母", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks = ["A a", "B b", "C c", "D d", "E e", "F f"].map((display, index) => ({
    taskId: `letter-${index}`,
    subject: "english_letter",
    questionType: "recognition",
    isNew: true,
    prompt: "读一读",
    target: { ref: `AL-${String(index + 1).padStart(2, "0")}`, display },
    hint: "提示",
    demonstration: display
  }));
  assert.deepEqual(validateLesson(lesson), []);
});

test("拒绝不是四选一的选择题", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks[1].options = ["人", "大", "小"];
  assert.match(validateLesson(lesson).join("\n"), /恰有 4 个选项/);
});

test("格式损坏的课程返回明确错误，不让课程检查本身崩溃", () => {
  for (const tasks of ["bad", {}, null, [null], [[]]]) {
    const lesson = { ...structuredClone(initialLesson), tasks };
    assert.ok(validateLesson(lesson).length > 0);
  }
  for (const options of [{}, "人大小山", null]) {
    const lesson = structuredClone(initialLesson);
    lesson.tasks[1].options = options;
    assert.match(validateLesson(lesson).join("\n"), /恰有 4 个选项/);
  }
});

test("选择题不允许重复、空白或非文字选项", () => {
  for (const options of [["人", "人", "大", "小"], ["人", " 人 ", "大", "小"], ["人", "", "大", "小"], ["人", 2, "大", "小"]]) {
    const lesson = structuredClone(initialLesson);
    lesson.tasks[1].options = options;
    assert.match(validateLesson(lesson).join("\n"), /互不重复的非空文字/);
  }
});

test("前端拒绝不受支持的协议版本", () => {
  const lesson = { ...structuredClone(initialLesson), schemaVersion: 2 };
  assert.match(validateLesson(lesson).join("\n"), /schemaVersion 必须为 1/);
});

test("拒绝在选择题题干中直接显示正确答案", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks[1].prompt = "找到“人”，只要告诉我第几个。";
  assert.match(validateLesson(lesson).join("\n"), /题干不得直接出现正确答案/);
});

test("分与合操作题的总数、左边和正确答案必须对应", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks = [{
    taskId: "composition-check",
    subject: "math",
    questionType: "choice",
    evidenceType: "math_visual_model",
    isNew: false,
    prompt: "把苹果分到两个盘子。",
    target: { ref: "M-COMP-5", display: "5 的分与合" },
    composition: { whole: 5, left: 1 },
    options: ["2", "3", "4", "5"],
    correctAnswer: "4",
    hint: "重新摆一次。",
    demonstration: "一和四合起来是五。"
  }];
  assert.deepEqual(validateLesson(lesson), []);
  lesson.tasks[0].composition.left = 2;
  assert.match(validateLesson(lesson).join("\n"), /分与合的总数、分组或答案不一致/);
});

test("拒绝把课堂题目或提示写成对家长说的旁观口吻", () => {
  const lesson = structuredClone(initialLesson);
  lesson.tasks[0].speechPrompt = "请孩子自己读出这个字。";
  lesson.tasks[0].context = "家长先不要提示，听孩子说完再记录。";
  const errors = validateLesson(lesson).join("\n");
  assert.match(errors, /必须直接对孩子说/);
});

test("拒绝超过四个下一课预习编号", () => {
  const lesson = structuredClone(initialLesson);
  lesson.metadata = {
    ...lesson.metadata,
    nextPreviewHanziRefs: ["ZH-0001", "ZH-0002", "ZH-0003", "ZH-0004", "ZH-0005"]
  };
  assert.match(validateLesson(lesson).join("\n"), /nextPreviewHanziRefs 最多 4 项/);
});

test("正常课程仍限制 20 题，但单次测试可连续超过 20 题", () => {
  const normalLesson = structuredClone(initialLesson);
  normalLesson.tasks = Array.from({ length: 21 }, (_, index) => ({
    ...structuredClone(initialLesson.tasks[0]),
    taskId: `normal-${index}`,
    isNew: false
  }));
  assert.match(validateLesson(normalLesson).join("\n"), /正常课程最多 20 题/);

  const testLesson = structuredClone(normalLesson);
  testLesson.metadata = { testScope: "all" };
  assert.deepEqual(validateLesson(testLesson), []);
});

test("数学课程允许四个新目标但拒绝第五个", () => {
  const mathLesson = structuredClone(initialLesson);
  mathLesson.tasks = Array.from({ length: 4 }, (_, index) => ({
    taskId: `math-${index}`,
    subject: "math",
    questionType: "choice",
    isNew: true,
    prompt: "这个数字是几？",
    visualPrompt: String(index),
    target: { ref: `M-NUM-${index}`, display: `数字 ${index}` },
    hint: "慢慢想。",
    demonstration: `这是数字 ${index}。`,
    options: ["0", "1", "2", "3"],
    correctAnswer: String(index)
  }));
  assert.deepEqual(validateLesson(mathLesson), []);
  mathLesson.tasks.push({ ...mathLesson.tasks[0], taskId: "math-5", target: { ref: "M-NUM-4", display: "数字 4" }, correctAnswer: "4", options: ["1", "2", "3", "4"] });
  assert.match(validateLesson(mathLesson).join("\n"), /新数学目标不得超过 4 个/);
});
