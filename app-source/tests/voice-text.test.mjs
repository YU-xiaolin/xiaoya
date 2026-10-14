import assert from "node:assert/strict";
import test from "node:test";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../src/voice-text.js";
import { HANZI_HINTS, HANZI_READINGS, HANZI_WORDS } from "../src/hanzi-hints.js";
import { pinyin } from "pinyin-pro";

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

test("汉字答对后读字和短词，不重读答题前提示或长讲解", () => {
  for (const context of ["先自己想一想，再大声说出来。", "先自己想一想，再大声读出来。", "认真看一看每个选项。"]) {
    const reading = { subject: "hanzi", target: { display: "木" }, context };
    assert.equal(reinforcementSpeechText(reading, "lesson"), "木，木头、树木。");
    assert.ok(!reinforcementSpeechText(reading, "lesson").includes(context));
    assert.ok(!reinforcementSpeechText(reading, "preview").includes(context));
  }
  assert.equal(reinforcementSpeechText({ ...task, subject: "hanzi", reinforcement: "木可以组成树木。" }, "lesson"), "木，木头、树木。");
});

test("汉字学习、预习、巩固和小测试均有答后组词，其他学科维持原有反馈", () => {
  for (const mode of ["lesson", "preview", "practice", "test"]) {
    assert.equal(reinforcementSpeechText({ subject: "hanzi", target: { display: "当" } }, mode), "当，当时、应当。");
    assert.equal(reinforcementSpeechText({ subject: "hanzi", target: { display: "日" }, correctAnswer: "月" }, mode), "月，月亮、月牙。");
  }
  assert.equal(reinforcementSpeechText(task, "test"), "");
  assert.equal(reinforcementSpeechText(task, "practice"), "");
});

test("全字库都有一到两个含目标字的短词或生活短语", () => {
  assert.deepEqual(Object.keys(HANZI_WORDS).sort(), Object.keys(HANZI_HINTS).sort());
  for (const [character, words] of Object.entries(HANZI_WORDS)) {
    assert.ok(words.length >= 1 && words.length <= 2, character);
    assert.equal(new Set(words).size, words.length, character);
    for (const word of words) {
      assert.match(word, /^[\u4e00-\u9fff]{2,4}$/u, `${character}: ${word}`);
      assert.ok(word.includes(character), `${character}: ${word}`);
    }
    const speech = reinforcementSpeechText({ subject: "hanzi", target: { display: character } }, "test");
    assert.ok(speech.length <= 12, `${character}: ${speech}`);
    assert.doesNotMatch(speech, /跟我读|再想|□|undefined/u);
  }
});

test("多音字组词与现有题目字音一致，允许轻声和一不的自然变调", () => {
  const toneless = value => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "");
  for (const [character, words] of Object.entries(HANZI_WORDS)) {
    const reading = HANZI_READINGS[character] || pinyin(character);
    for (const word of words) {
      const readings = pinyin(word, { type: "array" });
      [...word].forEach((letter, index) => {
        if (letter !== character) return;
        const actual = readings[index];
        const naturalToneChange = (character === "一" || character === "不" || actual === toneless(actual))
          && toneless(actual) === toneless(reading);
        assert.ok(actual === reading || naturalToneChange, `${character}: ${word}: ${reading} != ${actual}`);
      });
    }
  }
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
