import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pinyin } from "pinyin-pro";
import { HANZI_READINGS } from "../src/hanzi-hints.js";
import {
  DEFAULT_DIFFICULTY_WEIGHTS,
  allocateHanziQuestionMix,
  buildPracticeTasks,
  buildPreviewTasks,
  buildTestLessons,
  buildTestTasks,
  difficultyBucket,
  normalizeHanziOralReadingPercent,
  normalizeTestDays,
  sampleTestItemsByDifficulty,
  selectTestItems
} from "../src/test-mode.js";

const now = new Date("2026-08-21T12:00:00+08:00");
const catalog = {
  hanzi: [
    { ref: "ZH-0001", display: "人", optionDisplay: "人", status: "初见", lastSeenAt: "2026-08-21T08:00:00+08:00" },
    { ref: "ZH-0002", display: "大", optionDisplay: "大", status: "学习中", lastSeenAt: "2026-08-20T08:00:00+08:00" },
    { ref: "ZH-0003", display: "小", optionDisplay: "小", status: "已掌握", lastSeenAt: "2026-08-19T08:00:00+08:00" },
    { ref: "ZH-0004", display: "山", optionDisplay: "山", status: "未学", lastSeenAt: null },
    { ref: "ZH-0005", display: "水", optionDisplay: "水", status: "未学", lastSeenAt: null },
    { ref: "ZH-0006", display: "火", optionDisplay: "火", status: "未学", lastSeenAt: null },
    { ref: "ZH-0007", display: "木", optionDisplay: "木", status: "未学", lastSeenAt: null },
    { ref: "ZH-0008", display: "零", optionDisplay: "零", status: "未学", lastSeenAt: null },
    { ref: "ZH-0009", display: "多", optionDisplay: "多", status: "未学", lastSeenAt: null },
    { ref: "ZH-0010", display: "我", optionDisplay: "我", status: "未学", lastSeenAt: null },
    { ref: "ZH-0011", display: "你", optionDisplay: "你", status: "未学", lastSeenAt: null },
    { ref: "ZH-0012", display: "他", optionDisplay: "他", status: "未学", lastSeenAt: null },
    { ref: "ZH-0013", display: "她", optionDisplay: "她", status: "未学", lastSeenAt: null }
  ]
};

test("测试范围按本地自然日筛选已学内容", () => {
  assert.deepEqual(selectTestItems(catalog, "hanzi", "today", 7, now).map(item => item.ref), ["ZH-0001"]);
  assert.deepEqual(selectTestItems(catalog, "hanzi", "two_days", 7, now).map(item => item.ref), ["ZH-0001", "ZH-0002"]);
  assert.deepEqual(selectTestItems(catalog, "hanzi", "three_days", 7, now).map(item => item.ref), ["ZH-0001", "ZH-0002", "ZH-0003"]);
  assert.equal(selectTestItems(catalog, "hanzi", "all", 7, now).length, 3);
});

test("自定义天数限制在 1 到 30 天", () => {
  assert.equal(normalizeTestDays("0"), 1);
  assert.equal(normalizeTestDays("12"), 12);
  assert.equal(normalizeTestDays("99"), 30);
});

test("测试题只考已选目标并自动生成四选一", () => {
  const stableRandom = () => 0.25;
  const tasks = buildTestTasks("hanzi", [catalog.hanzi[0]], catalog, stableRandom, 20, { hanziOralReadingPercent: 0 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].target.ref, "ZH-0001");
  assert.equal(tasks[0].options.length, 4);
  assert.ok(tasks[0].options.includes("人"));
  assert.equal(tasks[0].prompt, "找到读音是“rén”的字，只要告诉我第几个。");
  assert.ok(!tasks[0].prompt.includes(tasks[0].correctAnswer));
  assert.equal(tasks[0].speechPrompt, "找到“人”，只要告诉我第几个。");
});

test("“日”等全部词库汉字的测试题干都用拼音且不泄露正确字形", async () => {
  const csv = await readFile(new URL("../../app-source/src-tauri/resources/幼儿汉字1000字表.csv", import.meta.url), "utf8");
  const hanzi = csv.trim().split(/\r?\n/).slice(1).map(line => {
    const columns = line.split(",");
    return { ref: columns[0], display: columns[3], optionDisplay: columns[3], status: "初见", lastSeenAt: now.toISOString() };
  });
  const fullCatalog = { hanzi };
  const tasks = buildTestTasks("hanzi", hanzi, fullCatalog, () => 0.25, hanzi.length, { hanziOralReadingPercent: 0 });
  assert.equal(tasks.length, 1000);
  assert.equal(tasks.find(task => task.target.display === "日")?.prompt, "找到读音是“rì”的字，只要告诉我第几个。");
  assert.equal(tasks.find(task => task.target.display === "灭")?.prompt, "找到读音是“miè”的字，只要告诉我第几个。");
  assert.equal(tasks.some(task => task.target.display === "勒"), false);
  assert.ok(tasks.every(task => !task.prompt.normalize("NFKC").toLocaleLowerCase().includes(task.correctAnswer.normalize("NFKC").toLocaleLowerCase())));
});

test("英语字母测试题干也不直接显示正确选项", () => {
  const letterCatalog = {
    english_letter: [
      { ref: "AL-01", display: "A a", optionDisplay: "A", status: "初见" },
      { ref: "AL-02", display: "B b", optionDisplay: "B", status: "初见" },
      { ref: "AL-03", display: "C c", optionDisplay: "C", status: "初见" },
      { ref: "AL-04", display: "D d", optionDisplay: "D", status: "初见" }
    ]
  };
  const [task] = buildTestTasks("english_letter", [letterCatalog.english_letter[0]], letterCatalog, () => 0.25);
  assert.equal(task.prompt, "听一听，找到我读到的大写字母，只要告诉我第几个。");
  assert.ok(!task.prompt.toLocaleLowerCase().includes(task.correctAnswer.toLocaleLowerCase()));
  assert.equal(task.speechPrompt, "找到大写 A，只要告诉我第几个。");
});

test("听音选择题排除同音字以及读音相同的多音字选项", () => {
  const values = ["他", "她", "它", "在", "再", "做", "坐", "作", "重", "种", "山", "水", "火", "木", "大", "小"];
  const items = values.map((display, index) => ({ ref: `homophone-${index}`, display, optionDisplay: display, status: "初见" }));
  const tasks = buildTestTasks("hanzi", items, { hanzi: items }, () => 0.25, items.length, { hanziOralReadingPercent: 0 });
  for (const task of tasks) {
    const reading = HANZI_READINGS[task.correctAnswer] || pinyin(task.correctAnswer);
    assert.equal(task.options.length, 4);
    for (const option of task.options.filter(option => option !== task.correctAnswer)) {
      assert.ok(!pinyin(option, { multiple: true, type: "array" }).includes(reading), `${task.correctAnswer} 的选项 ${option} 也符合 ${reading}`);
    }
  }
  assert.ok(!tasks.find(task => task.correctAnswer === "重").options.includes("种"));
});

test("干扰项优先使用已学内容，不固定从目录前四十字抽取", () => {
  const items = ["人", "大", "小", "山", "水", "火", "木"].map((display, index) => ({
    ref: `learned-${index}`, display, optionDisplay: display, status: index < 3 ? "未学" : "初见"
  }));
  const [task] = buildTestTasks("hanzi", [items[3]], { hanzi: items }, () => 0.25, 1, { hanziOralReadingPercent: 0 });
  assert.deepEqual(new Set(task.options), new Set(["山", "水", "火", "木"]));
});

test("汉字小测试按家长选择的比例分配选择题和自己读", () => {
  assert.equal(normalizeHanziOralReadingPercent("120"), 100);
  assert.equal(normalizeHanziOralReadingPercent("-5"), 0);
  assert.deepEqual(allocateHanziQuestionMix(10, 40), {
    questionCount: 10,
    oralReadingPercent: 40,
    oralReadingCount: 4,
    choiceCount: 6
  });

  const selected = catalog.hanzi.slice(0, 10).map(item => ({ ...item, status: "初见" }));
  const tasks = buildTestTasks("hanzi", selected, catalog, () => 0.25, selected.length, { hanziOralReadingPercent: 40 });
  assert.equal(tasks.filter(task => task.questionType === "choice").length, 6);
  assert.equal(tasks.filter(task => task.evidenceType === "hanzi_oral_reading").length, 4);
  assert.equal(new Set(tasks.map(task => task.target.ref)).size, 10);
  assert.ok(tasks.filter(task => task.evidenceType === "hanzi_oral_reading")
    .every(task => task.prompt === "请读出屏幕上的汉字。"
      && task.speechPrompt === "请读出屏幕上的汉字。"
      && !task.prompt.includes(task.target.display)
      && !/孩子|家长/u.test(`${task.prompt}${task.context}${task.hint}`)));
});

test("题量较小时仍同时保留用户选择的两类汉字题", () => {
  assert.deepEqual(allocateHanziQuestionMix(2, 10), {
    questionCount: 2,
    oralReadingPercent: 10,
    oralReadingCount: 1,
    choiceCount: 1
  });
});

test("轻松预习显示下一课新字而不是今日新字", () => {
  const lessonTasks = [
    { taskId: "review-ren", subject: "hanzi", questionType: "recognition", isNew: false, target: { ref: "ZH-0001", display: "人" } },
    ...["山", "水", "火", "木", "零", "多"].map((display, index) => ({
      taskId: `new-${index}`,
      subject: "hanzi",
      questionType: "recognition",
      isNew: true,
      target: { ref: `ZH-${String(index + 4).padStart(4, "0")}`, display }
    }))
  ];
  assert.deepEqual(
    buildPreviewTasks("hanzi", lessonTasks, catalog, ["ZH-0010", "ZH-0011", "ZH-0012", "ZH-0013"]).map(task => task.target.display),
    ["我", "你", "他", "她"]
  );
});

test("巩固练习只覆盖上一次课程新学的六个字", () => {
  const lessonTasks = [
    { subject: "hanzi", questionType: "recognition", isNew: false, target: { ref: "ZH-0001", display: "人" } },
    { subject: "hanzi", questionType: "choice", isNew: false, target: { ref: "ZH-0002", display: "大" } },
    { subject: "hanzi", questionType: "recognition", isNew: true, target: { ref: "ZH-0007", display: "木" } }
  ];
  const previousRefs = ["ZH-0001", "ZH-0002", "ZH-0003", "ZH-0004", "ZH-0005", "ZH-0006"];
  const tasks = buildPracticeTasks("hanzi", lessonTasks, catalog, previousRefs, () => 0.25);
  assert.deepEqual(tasks.map(task => task.target.ref), previousRefs);
  assert.ok(tasks.every(task => task.questionType === "choice" && task.options.length === 4));
});

test("全部内容测试不分轮并连续覆盖全部已学项目", () => {
  const largeCatalog = {
    hanzi: Array.from({ length: 42 }, (_, index) => ({
      ref: `ZH-${String(index + 1).padStart(4, "0")}`,
      display: String.fromCodePoint(0x4e00 + index),
      optionDisplay: String.fromCodePoint(0x4e00 + index),
      status: "初见",
      lastSeenAt: now.toISOString()
    }))
  };
  const lessons = buildTestLessons("hanzi", largeCatalog.hanzi, largeCatalog, "all", 7, now, () => 0.25);
  assert.deepEqual(lessons.map(lesson => lesson.tasks.length), [42]);
  assert.equal(lessons.flatMap(lesson => lesson.tasks).length, 42);
  assert.equal(lessons.length, 1);
  assert.deepEqual(lessons[0].metadata.questionMix, {
    oralReadingPercent: 50,
    oralReadingCount: 21,
    choiceCount: 21
  });
});

test("难度分档使用互不重叠的正式错误次数区间", () => {
  assert.equal(difficultyBucket({ incorrectCount: 0 }), "zero");
  assert.equal(difficultyBucket({ incorrectCount: 1 }), "low");
  assert.equal(difficultyBucket({ incorrectCount: 3 }), "low");
  assert.equal(difficultyBucket({ incorrectCount: 4 }), "medium");
  assert.equal(difficultyBucket({ incorrectCount: 5 }), "medium");
  assert.equal(difficultyBucket({ incorrectCount: 6 }), "high");
});

test("难度抽题按 10/30/40/20 比例无重复抽取 20 题", () => {
  const bucketCounts = { zero: 10, low: 30, medium: 40, high: 20 };
  const incorrectByBucket = { zero: 0, low: 2, medium: 5, high: 8 };
  const items = Object.entries(bucketCounts).flatMap(([key, count]) =>
    Array.from({ length: count }, (_, index) => ({ ref: `${key}-${index}`, incorrectCount: incorrectByBucket[key] }))
  );
  const sample = sampleTestItemsByDifficulty(items, 20, DEFAULT_DIFFICULTY_WEIGHTS, () => 0.25);
  assert.deepEqual(sample.actualCounts, { zero: 2, low: 6, medium: 8, high: 4 });
  assert.equal(sample.items.length, 20);
  assert.equal(new Set(sample.items.map(item => item.ref)).size, 20);
});

test("某一难度档数量不足时自动从其他档补满题量", () => {
  const items = [
    { ref: "zero-only", incorrectCount: 0 },
    ...Array.from({ length: 9 }, (_, index) => ({ ref: `low-${index}`, incorrectCount: 2 }))
  ];
  const sample = sampleTestItemsByDifficulty(items, 8, { zero: 80, low: 20, medium: 0, high: 0 }, () => 0.25);
  assert.deepEqual(sample.actualCounts, { zero: 1, low: 7, medium: 0, high: 0 });
  assert.equal(sample.items.length, 8);
});

test("难度抽题超过 20 题时仍为单次测试并保留抽题方案", () => {
  const largeCatalog = {
    hanzi: Array.from({ length: 45 }, (_, index) => ({
      ref: `ZH-${String(index + 1).padStart(4, "0")}`,
      display: String.fromCodePoint(0x4e00 + index),
      optionDisplay: String.fromCodePoint(0x4e00 + index),
      status: "初见",
      incorrectCount: index % 7,
      lastSeenAt: now.toISOString()
    }))
  };
  const difficultyPlan = { weights: DEFAULT_DIFFICULTY_WEIGHTS };
  const lessons = buildTestLessons("hanzi", largeCatalog.hanzi, largeCatalog, "weighted", 7, now, () => 0.25, { difficultyPlan });
  assert.deepEqual(lessons.map(lesson => lesson.tasks.length), [45]);
  assert.ok(lessons.every(lesson => lesson.metadata.difficultyPlan === difficultyPlan));
});
