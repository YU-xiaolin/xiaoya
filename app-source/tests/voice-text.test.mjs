import assert from "node:assert/strict";
import test from "node:test";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../src/voice-text.js";
import { HANZI_HINTS } from "../src/hanzi-hints.js";

test("自然提示覆盖全词库，不朗读空格或括号并保留线索", () => {
  for (const display of Object.keys(HANZI_HINTS)) {
    const speech = hintSpeechText({ subject: 'hanzi', questionType: 'recognition', target: { display } });
    assert.doesNotMatch(speech, /[□（）()【】\[\]]|空格|括号|undefined/u, display);
    assert.ok(!speech.includes(display), `${display}: ${speech}`);
    assert.ok(speech.length >= 8, display);
  }
  const half = hintSpeechText({ subject: 'hanzi', target: { display: '半' } });
  assert.match(half, /苹果平均切成两份/);
  assert.match(hintSpeechText({}, '想想（小鸭弯着脖子），再找一找。'), /想想，小鸭弯着脖子，再找一找/u);
});

const task = {
  prompt: "这个字怎么读？",
  target: { display: "木" },
  context: "树干向上长，旁边伸出树枝。"
};

test("题目出现时朗读题目原文", () => {
  assert.equal(questionSpeechText(task), "这个字怎么读？");
});

test("选择题可朗读隐藏的答案线索而不把答案显示在题干", () => {
  assert.equal(questionSpeechText({
    prompt: "找到读音是“rì”的字，只要告诉我第几个。",
    speechPrompt: "找到“日”，只要告诉我第几个。"
  }), "找到“日”，只要告诉我第几个。");
});

test("答对后只用明确巩固或答案示范，不把答题前 context 当成讲解", () => {
  for (const context of ["先自己想一想，再大声说出来。", "先自己想一想，再大声读出来。", "认真看一看每个选项。"]) {
    const reading = { subject: "hanzi", target: { display: "木" }, context };
    assert.equal(reinforcementSpeechText(reading, "lesson"), demonstrationSpeechText(reading));
    assert.ok(!reinforcementSpeechText(reading, "lesson").includes(context));
    assert.ok(!reinforcementSpeechText(reading, "preview").includes(context));
  }
  assert.equal(reinforcementSpeechText({ ...task, reinforcement: "木可以组成树木。" }, "lesson"), "木可以组成树木。");
});

test("测试与巩固不重复朗读通用解释", () => {
  assert.equal(reinforcementSpeechText(task, "test"), "");
  assert.equal(reinforcementSpeechText(task, "practice"), "");
});

test("英文字母反馈只读一次字母音，不连续朗读大小写两遍", () => {
  const letterTask = {
    subject: "english_letter",
    target: { display: "B b" },
    context: "B b — ball。看清大写 B 和小写 b 的样子。",
    demonstration: "B，b，ball。"
  };
  assert.equal(reinforcementSpeechText(letterTask, "lesson"), "这是字母 B。ball 这个单词以它开头。");
  assert.equal(demonstrationSpeechText(letterTask), "这是字母 B。ball 这个单词以它开头。");
});

test("英文字母选择题示范也不会把同一个字母连续念多次", () => {
  const letterTask = {
    subject: "english_letter",
    target: { display: "A a" },
    correctAnswer: "A",
    demonstration: "答案是大写 A，这是字母 A。"
  };
  assert.equal(demonstrationSpeechText(letterTask), "这是字母 A。请看清它的大写和小写样子。");
});

test("数学认数字示范只自然读一次答案", () => {
  assert.equal(demonstrationSpeechText({
    subject: "math",
    evidenceType: "math_digit_reading",
    target: { display: "数字 3" },
    correctAnswer: "3",
    demonstration: "这是数字 3。跟我读：3。"
  }), "这是数字 3。");
});
