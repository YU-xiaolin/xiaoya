// 手机端/Windows 端共用的「可朗读文本」枚举。
// 手机端语音子集构建（tools/build-voice-subset.mjs）与覆盖率校验
// （app-mobile/scripts/verify-voice-coverage.mjs、app-mobile/tests/voice-coverage.test.mjs）
// 必须使用同一份枚举，避免「构建时收录的句子」与「运行时真正会朗读的句子」出现漂移。
import { buildPracticeTasks, buildPreviewTasks, buildTestTasks } from "../app-mobile/src/core/test-mode.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../app-mobile/src/core/voice-text.js";
import { taskHintVariants } from "../app-mobile/src/core/targeted-hints.js";
import { buildAllMathVoiceTasks } from "../app-mobile/src/core/math-mode.js";
import { compositionInstructions, isCompositionModel } from "../app-mobile/src/core/composition-board.js";
import { childFacingAudienceIssue } from "../app-mobile/src/core/protocol.js";

// 数学按「离常用阶段越近越优先」排序，保证默认阶段一定拿到自然语音。
export const STAGE_PRIORITY = [6, 5, 4, 3, 2, 1];

export const TIER_NAMES = [
  "固定反馈语",
  "当前课程",
  "预习与巩固",
  "已学内容测试（含全部提示变体）",
  "数学题目变体",
  "全词库提示"
];

/**
 * 枚举应用会朗读的全部文本，按重要程度分层返回。
 * @param {{ lesson: object, catalog: object }} coursePackage course-package.json 的内容
 * @returns {string[][]} 每层的文本数组（层内已去重，层间不重复）
 */
export function collectVoiceTexts({ lesson, catalog }) {
  const tiers = TIER_NAMES.map(() => []);
  const seen = new Set();

  function add(text, tier) {
    const normalized = String(text || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    tiers[tier].push(normalized);
  }

  function addTaskClips(task, studyMode, tier) {
    const audienceIssue = childFacingAudienceIssue(task);
    if (audienceIssue) {
      throw new Error(`儿童语音口吻检查失败：${task.taskId || "未知题目"} 的 ${audienceIssue.field}：${audienceIssue.text}`);
    }
    const prompt = questionSpeechText(task);
    add(prompt, tier);
    if (isCompositionModel(task)) {
      for (const text of Object.values(compositionInstructions(task.composition))) {
        if (text !== prompt) add(text, tier);
      }
    }
    add(reinforcementSpeechText(task, studyMode), tier);
    for (const hint of taskHintVariants(task)) add(hintSpeechText(task, hint), tier);
    add(demonstrationSpeechText(task), tier);
  }

  // 第一优先级：答对/答错的固定反馈语
  add("真棒，答对了！", 0);
  add("太好了，这次答对了！", 0);

  // 第二优先级：当前课程
  for (const task of lesson?.tasks || []) addTaskClips(task, "lesson", 1);

  // 第三优先级：预习与巩固
  for (const subject of ["hanzi", "english_letter"]) {
    const lessonTasks = (lesson?.tasks || []).filter(task => task.subject === subject);
    const previewRefs = subject === "hanzi" ? lesson?.metadata?.nextPreviewHanziRefs : lesson?.metadata?.nextPreviewLetterRefs;
    const previousNewRefs = subject === "hanzi" ? lesson?.metadata?.previousNewHanziRefs : lesson?.metadata?.previousNewLetterRefs;
    for (const task of buildPreviewTasks(subject, lessonTasks, catalog, previewRefs, 4)) addTaskClips(task, "preview", 2);
    for (const task of buildPracticeTasks(subject, lessonTasks, catalog, previousNewRefs, () => 0.25)) addTaskClips(task, "practice", 2);
  }

  // 第四优先级：小测试。
  // 关键：不能只看「打包时已经学过的字」。手机端的小测试范围由本机学习记录推导
  // （analysis.mergeCatalogProgress），任何一个字只要孩子在本机答过一次，就可能进入
  // 测试题。所以这里对**全部目录条目**出题，保证测试题面与提示都有晓伊语音。
  for (const subject of ["hanzi", "english_letter"]) {
    const allItems = catalog[subject] || [];
    if (!allItems.length) continue;
    const variants = subject === "hanzi"
      ? [
        buildTestTasks(subject, allItems, catalog, () => 0.25, allItems.length, { hanziOralReadingPercent: 0 }),
        buildTestTasks(subject, allItems, catalog, () => 0.25, allItems.length, { hanziOralReadingPercent: 100 })
      ]
      : [buildTestTasks(subject, allItems, catalog, () => 0.25, allItems.length)];
    for (const task of variants.flat()) addTaskClips(task, "test", 3);
  }

  // 第五优先级：数学题目变体
  const orderedMath = [...(catalog.math || [])].sort((left, right) => {
    const leftStage = STAGE_PRIORITY.indexOf(Number(left.stage));
    const rightStage = STAGE_PRIORITY.indexOf(Number(right.stage));
    return (leftStage < 0 ? 99 : leftStage) - (rightStage < 0 ? 99 : rightStage)
      || (Number(left.order) || 0) - (Number(right.order) || 0);
  });
  for (const task of buildAllMathVoiceTasks(orderedMath)) addTaskClips(task, "lesson", 4);

  // 第六优先级：全词库提示（任意随机选项都可能触发的易混提示）
  for (const subject of ["hanzi", "english_letter"]) {
    for (const item of catalog[subject] || []) {
      for (const questionType of ["recognition", "choice"]) {
        const task = { subject, questionType, target: { display: item.display }, correctAnswer: item.optionDisplay, options: [item.optionDisplay] };
        for (const hint of taskHintVariants(task)) add(hintSpeechText(task, hint), 5);
      }
    }
  }

  return tiers;
}
