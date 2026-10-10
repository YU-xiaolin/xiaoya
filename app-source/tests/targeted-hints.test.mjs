import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HANZI_HINTS } from "../src/hanzi-hints.js";
import { LETTER_HINTS, taskHint, taskHintVariants } from "../src/targeted-hints.js";
import { buildPracticeTasks, buildPreviewTasks, buildTestTasks } from "../src/test-mode.js";
import { buildAllMathVoiceTasks, buildMathTask } from "../src/math-mode.js";
import { demonstrationSpeechText, hintSpeechText } from "../src/voice-text.js";
import { childFacingAudienceIssue } from "../src/protocol.js";

const csv = await readFile(new URL("../../app-source/src-tauri/resources/幼儿汉字1000字表.csv", import.meta.url), "utf8");
const hanzi = csv.trim().split(/\r?\n/).slice(1).map(row => {
  const [ref, , , display] = row.split(",");
  return { ref, display, optionDisplay: display, status: "初见" };
});
const mathCatalog = JSON.parse(await readFile(new URL("../../app-source/src-tauri/resources/数学启蒙课程.json", import.meta.url), "utf8"));
const oldHint = "仔细看看这个字的样子，想一想它怎么读。";
const recognition = character => ({ subject: "hanzi", questionType: "recognition", target: { display: character }, hint: oldHint });

test("1000 个正式汉字都有独立线索，线索中不直接展示答案字形", () => {
  assert.equal(Object.keys(HANZI_HINTS).length, 1000);
  assert.equal(new Set(Object.values(HANZI_HINTS).map(entry => entry.clue)).size, 1000);
  for (const { display } of hanzi) {
    const entry = HANZI_HINTS[display];
    assert.ok(entry?.clue?.length >= 8, `${display} 缺少具体提示`);
    for (const text of [entry.clue, entry.shape].filter(Boolean)) {
      assert.ok(!text.includes(display), `${display} 的提示泄露字形：${text}`);
      assert.equal(childFacingAudienceIssue({ hint: text }), null);
      assert.ok(text.length <= 75, `${display} 的提示过长`);
    }
  }
});

test("火用蜡烛情境，旧课程中的模板提示也由共同入口替换", () => {
  const task = Object.freeze(recognition("火"));
  assert.match(taskHint(task), /生日蜡烛/);
  assert.doesNotMatch(taskHint(task), /火|仔细看看/);
  assert.equal(task.hint, oldHint, "读取提示不能改写传入的课程");
  assert.match(demonstrationSpeechText(task), /火苗/);
});

test("测试、朗读、练习和预习均使用同一个针对性提示库", () => {
  const catalog = { hanzi };
  const fire = hanzi.find(item => item.display === "火");
  const choice = buildTestTasks("hanzi", [fire], catalog, () => 0.25, 1, { hanziOralReadingPercent: 0 })[0];
  const oral = buildTestTasks("hanzi", [fire], catalog, () => 0.25, 1, { hanziOralReadingPercent: 100 })[0];
  const practice = buildPracticeTasks("hanzi", [], catalog, [fire.ref], () => 0.25)[0];
  const preview = buildPreviewTasks("hanzi", [], catalog, [fire.ref])[0];
  assert.equal(choice.hint, practice.hint);
  assert.equal(oral.hint, preview.hint);
  for (const task of [choice, oral, practice, preview]) assert.match(task.hint, /蜡烛/);
  assert.match(choice.hint, /笔画/);
});

test("选错的具体相似字决定提示，重听和语音包能覆盖同一文本", () => {
  const task = { ...recognition("木"), questionType: "choice", options: ["木", "本", "禾", "米"], correctAnswer: "木" };
  const forBen = taskHint(task, "本");
  const forHe = taskHint(task, "禾");
  assert.match(forBen, /没有额外的小短横/);
  assert.match(forHe, /没有额外的一撇/);
  assert.notEqual(forBen, forHe);
  const variants = taskHintVariants({ ...task, options: ["木", "火", "水", "山"] });
  assert.ok(variants.includes(forBen), "随机换选项后也应已有语音");
  assert.ok(variants.includes(forHe));
  assert.equal(taskHint(task, "不存在"), taskHint(task));
  for (const hint of variants) {
    assert.ok(!hint.includes("木"));
    assert.equal(hintSpeechText(task, hint), hint);
  }
});

test("26 个字母的形状提示互不相同，易混字母按实际误选区分", () => {
  assert.equal(Object.keys(LETTER_HINTS).length, 26);
  assert.equal(new Set(Object.values(LETTER_HINTS).map(entry => entry[0])).size, 26);
  const task = { subject: "english_letter", questionType: "choice", target: { display: "B b" }, correctAnswer: "B", options: ["B", "D", "P", "R"] };
  assert.match(taskHint(task, "D"), /上下两个肚子/);
  assert.match(taskHint(task, "P"), /右下方/);
  assert.notEqual(taskHint(task, "D"), taskHint(task, "P"));
  for (const hint of taskHintVariants(task)) assert.doesNotMatch(hint, /[A-Za-z]/);
  const oral = { ...task, questionType: "recognition" };
  assert.match(taskHint(oral), /大写.*小写/);
});

test("全词库随机测试的所有提示及易混分支不暴露目标字形", () => {
  const tasks = buildTestTasks("hanzi", hanzi, { hanzi }, () => 0.25, 1000, { hanziOralReadingPercent: 0 });
  for (const task of tasks) {
    for (const hint of taskHintVariants(task)) {
      assert.ok(!hint.includes(task.correctAnswer), `${task.correctAnswer}: ${hint}`);
      assert.doesNotMatch(hintSpeechText(task, hint), /□|undefined/);
      assert.equal(childFacingAudienceIssue({ hint }), null);
    }
  }
});

test("数学提示带入当题数量和运算动作，数偏多和数偏少分别引导", () => {
  const task = buildMathTask(mathCatalog.find(item => item.ref === "M-ADD-5"));
  assert.match(task.hint, /先摆 2 个小物品，再添 1 个/);
  assert.doesNotMatch(task.hint, /等于 3|答案是/);
  assert.match(taskHint(task, "4"), /^刚才选的数量偏多/);
  assert.match(taskHint(task, "2"), /^刚才选的数量偏少/);
  assert.ok(taskHintVariants(task).includes(taskHint(task, "4")));
  const subtraction = buildMathTask(mathCatalog.find(item => item.ref === "M-SUB-5"));
  assert.match(subtraction.hint, /拿走 1 个.*只数还留下的/);
});

test("数学看数、听数、点数和数序的提示覆盖两种实际题面", () => {
  const tasks = buildAllMathVoiceTasks(mathCatalog);
  for (const task of tasks) {
    assert.ok(task.hint?.length >= 10);
    for (const hint of taskHintVariants(task)) {
      assert.equal(childFacingAudienceIssue({ hint }), null);
      assert.doesNotMatch(hint, /undefined|NaN|仔细看清这个数字/);
    }
  }
  const digitHints = tasks.filter(task => task.evidenceType === "math_digit_reading").map(task => task.hint);
  assert.equal(new Set(digitHints).size, 11);
  const zero = buildMathTask(mathCatalog.find(item => item.ref === "M-QTY-0"));
  assert.doesNotMatch(zero.hint, /零|数量是/);
});

test("容易错配的多音字题面、语音例词与生活线索采用同一个读法", () => {
  const selected = hanzi.filter(item => ["了", "供", "载", "卷", "划"].includes(item.display));
  const tasks = buildTestTasks("hanzi", selected, { hanzi }, () => 0.25, selected.length, { hanziOralReadingPercent: 0 });
  for (const [character, sound, word] of [["了", "le", "完成了"], ["供", "gōng", "供水"], ["载", "zài", "载货"], ["卷", "juǎn", "卷起来"], ["划", "huá", "划船"]]) {
    const task = tasks.find(task => task.target.display === character);
    assert.ok(task.prompt.includes(`“${sound}”`));
    assert.ok(task.speechPrompt.includes(word));
    assert.ok(demonstrationSpeechText(task).includes(word));
  }
});
