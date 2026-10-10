import { syntheticState } from "../../tools/test-fixtures.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAllMathVoiceTasks } from "../src/math-mode.js";
import { childFacingAudienceIssue, validateLesson } from "../src/protocol.js";
import { buildPracticeTasks, buildPreviewTasks, buildTestTasks } from "../src/test-mode.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../src/voice-text.js";

const currentLesson = JSON.parse(await readFile(new URL("../../app-source/src-tauri/bootstrap/initial-next-lesson.json", import.meta.url), "utf8"));
const state = syntheticState();
const hanziCsv = await readFile(new URL("../../app-source/src-tauri/resources/幼儿汉字1000字表.csv", import.meta.url), "utf8");
const mathCatalog = JSON.parse(await readFile(new URL("../../app-source/src-tauri/resources/数学启蒙课程.json", import.meta.url), "utf8"));

const catalog = Object.fromEntries(Object.entries(state.items).map(([subject, items]) => [
  subject,
  Object.entries(items).map(([ref, item]) => ({
    ...item,
    ref,
    display: item.value,
    optionDisplay: subject === "english_letter" ? item.uppercase : item.value,
    incorrectCount: item.metrics?.incorrectCount || 0
  }))
]));

catalog.hanzi = hanziCsv.trim().split(/\r?\n/).slice(1).map(line => {
  const [ref, stage, theme, display] = line.split(",");
  return { ref, stage, theme, display, optionDisplay: display, status: "初见", incorrectCount: 0 };
});

const allTasks = [
  ...currentLesson.tasks,
  ...buildPreviewTasks("hanzi", currentLesson.tasks, catalog, catalog.hanzi.slice(0, 4).map(item => item.ref), 4),
  ...buildPreviewTasks("english_letter", currentLesson.tasks, catalog, catalog.english_letter.slice(0, 4).map(item => item.ref), 4),
  ...buildPracticeTasks("hanzi", currentLesson.tasks, catalog, catalog.hanzi.slice(0, 6).map(item => item.ref), () => 0.25),
  ...buildPracticeTasks("english_letter", currentLesson.tasks, catalog, catalog.english_letter.slice(0, 6).map(item => item.ref), () => 0.25),
  ...buildTestTasks("hanzi", catalog.hanzi, catalog, () => 0.25, catalog.hanzi.length, { hanziOralReadingPercent: 0 }),
  ...buildTestTasks("hanzi", catalog.hanzi, catalog, () => 0.25, catalog.hanzi.length, { hanziOralReadingPercent: 100 }),
  ...buildTestTasks("english_letter", catalog.english_letter, catalog, () => 0.25, catalog.english_letter.length),
  ...buildAllMathVoiceTasks(mathCatalog.map(item => ({ ...item, display: item.value, status: "初见" })))
];

const thirdPersonClassroomLanguage = /请孩子|让孩子|孩子自己|听孩子|提醒孩子|家长/u;

test("汉字、英语和数学的全部运行时课堂语言都直接对孩子表达", () => {
  assert.deepEqual(validateLesson(currentLesson), []);
  assert.ok(allTasks.length > 2100);

  for (const task of allTasks) {
    assert.equal(childFacingAudienceIssue(task), null, `${task.taskId} 含旁观口吻`);
    const spokenTexts = [
      questionSpeechText(task),
      hintSpeechText(task),
      demonstrationSpeechText(task),
      reinforcementSpeechText(task, "lesson"),
      reinforcementSpeechText(task, "preview")
    ].filter(Boolean);
    for (const text of spokenTexts) {
      assert.doesNotMatch(text, thirdPersonClassroomLanguage, `${task.taskId} 的语音不是直接对孩子说：${text}`);
    }
  }
});
