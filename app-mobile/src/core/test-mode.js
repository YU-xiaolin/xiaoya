import { pinyin } from "pinyin-pro";
import { choicePromptLeaksAnswer } from "./protocol.js";
import { buildMathTestTasks } from "./math-mode.js";
import { withTargetedHint } from "./targeted-hints.js";
import { HANZI_READINGS, HANZI_READING_EXAMPLES } from "./hanzi-hints.js";

const TEST_SCOPE_DAYS = Object.freeze({
  today: 1,
  two_days: 2,
  three_days: 3
});

export const TEST_SCOPE_LABELS = Object.freeze({
  today: "今天学习内容",
  two_days: "近 2 天内容",
  three_days: "近 3 天内容",
  all: "全部学习内容",
  custom: "自定义范围",
  weighted: "已学内容 · 难度抽题"
});

export const DIFFICULTY_BUCKETS = Object.freeze([
  { key: "zero", label: "0 次错误", detail: "没有有效错误记录" },
  { key: "low", label: "1–3 次错误", detail: "偶尔答错，适合巩固" },
  { key: "medium", label: "4–5 次错误", detail: "容易混淆，需要多练" },
  { key: "high", label: "6 次及以上", detail: "优先攻克的薄弱内容" }
]);

export const DEFAULT_DIFFICULTY_WEIGHTS = Object.freeze({
  zero: 10,
  low: 30,
  medium: 40,
  high: 20
});

export const DEFAULT_HANZI_ORAL_READING_PERCENT = 50;

export function difficultyBucket(item) {
  const incorrectCount = Math.max(0, Number.parseInt(item?.incorrectCount, 10) || 0);
  if (incorrectCount === 0) return "zero";
  if (incorrectCount <= 3) return "low";
  if (incorrectCount <= 5) return "medium";
  return "high";
}

export function normalizeDifficultyWeights(weights = DEFAULT_DIFFICULTY_WEIGHTS) {
  return Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => {
    const value = Number.parseInt(weights?.[key], 10);
    return [key, Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_DIFFICULTY_WEIGHTS[key]];
  }));
}

export function normalizeTestQuestionCount(value, maxAvailable) {
  const maximum = Math.max(0, Number.parseInt(maxAvailable, 10) || 0);
  if (!maximum) return 0;
  const count = Number.parseInt(value, 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(count) ? count : Math.min(20, maximum)));
}

export function normalizeHanziOralReadingPercent(value) {
  const percent = Number.parseInt(value, 10);
  return Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : DEFAULT_HANZI_ORAL_READING_PERCENT;
}

export function allocateHanziQuestionMix(questionCount, oralReadingPercent = DEFAULT_HANZI_ORAL_READING_PERCENT) {
  const count = Math.max(0, Number.parseInt(questionCount, 10) || 0);
  const normalizedPercent = normalizeHanziOralReadingPercent(oralReadingPercent);
  let oralReadingCount = Math.round(count * normalizedPercent / 100);
  if (count >= 2 && normalizedPercent > 0 && normalizedPercent < 100) {
    oralReadingCount = Math.min(count - 1, Math.max(1, oralReadingCount));
  }
  return {
    questionCount: count,
    oralReadingPercent: normalizedPercent,
    oralReadingCount,
    choiceCount: count - oralReadingCount
  };
}

export function difficultyAvailability(items = []) {
  const availability = Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => [key, 0]));
  for (const item of items) availability[difficultyBucket(item)] += 1;
  return availability;
}

export function allocateDifficultyCounts(items, questionCount, weights = DEFAULT_DIFFICULTY_WEIGHTS) {
  const availableItems = Array.isArray(items) ? items : [];
  const count = normalizeTestQuestionCount(questionCount, availableItems.length);
  const normalizedWeights = normalizeDifficultyWeights(weights);
  const totalWeight = Object.values(normalizedWeights).reduce((sum, value) => sum + value, 0);
  const effectiveWeights = totalWeight > 0
    ? normalizedWeights
    : Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => [key, 1]));
  const effectiveTotal = Object.values(effectiveWeights).reduce((sum, value) => sum + value, 0);
  const availability = difficultyAvailability(availableItems);
  const rawTargets = Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => [key, count * effectiveWeights[key] / effectiveTotal]));
  const requestedCounts = Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => [key, Math.floor(rawTargets[key])]));
  let unassigned = count - Object.values(requestedCounts).reduce((sum, value) => sum + value, 0);
  const remainderOrder = [...DIFFICULTY_BUCKETS].sort((left, right) =>
    (rawTargets[right.key] - requestedCounts[right.key]) - (rawTargets[left.key] - requestedCounts[left.key])
      || effectiveWeights[right.key] - effectiveWeights[left.key]
  );
  for (let index = 0; index < unassigned; index += 1) {
    requestedCounts[remainderOrder[index % remainderOrder.length].key] += 1;
  }

  const actualCounts = Object.fromEntries(DIFFICULTY_BUCKETS.map(({ key }) => [key, Math.min(requestedCounts[key], availability[key])]));
  let missing = count - Object.values(actualCounts).reduce((sum, value) => sum + value, 0);
  while (missing > 0) {
    const candidates = DIFFICULTY_BUCKETS
      .filter(({ key }) => actualCounts[key] < availability[key])
      .sort((left, right) => {
        const leftDeficit = rawTargets[left.key] - actualCounts[left.key];
        const rightDeficit = rawTargets[right.key] - actualCounts[right.key];
        return rightDeficit - leftDeficit
          || effectiveWeights[right.key] - effectiveWeights[left.key]
          || (availability[right.key] - actualCounts[right.key]) - (availability[left.key] - actualCounts[left.key]);
      });
    if (!candidates.length) break;
    actualCounts[candidates[0].key] += 1;
    missing -= 1;
  }

  return { questionCount: count, weights: normalizedWeights, availability, requestedCounts, actualCounts };
}

export function sampleTestItemsByDifficulty(items, questionCount, weights = DEFAULT_DIFFICULTY_WEIGHTS, random = Math.random) {
  const availableItems = Array.isArray(items) ? items : [];
  const plan = allocateDifficultyCounts(availableItems, questionCount, weights);
  const selected = [];
  for (const { key } of DIFFICULTY_BUCKETS) {
    const bucketItems = availableItems.filter(item => difficultyBucket(item) === key);
    selected.push(...shuffled(bucketItems, random).slice(0, plan.actualCounts[key]));
  }
  return { ...plan, items: shuffled(selected, random) };
}

export function normalizeTestDays(value) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days)) return 7;
  return Math.min(30, Math.max(1, days));
}

export function selectTestItems(catalog, subject, scope = "today", customDays = 7, now = new Date()) {
  const items = Array.isArray(catalog?.[subject]) ? catalog[subject] : [];
  const learned = items.filter(item => item.status && item.status !== "未学");
  if (scope === "all" || scope === "weighted") return learned;

  const days = scope === "custom" ? normalizeTestDays(customDays) : TEST_SCOPE_DAYS[scope];
  if (!days) return [];
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const rangeStart = new Date(todayStart);
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  return learned.filter(item => {
    if (!item.lastSeenAt) return false;
    const lastSeen = new Date(item.lastSeenAt);
    return !Number.isNaN(lastSeen.getTime())
      && lastSeen >= rangeStart
      && lastSeen < tomorrowStart;
  });
}

function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function hanziPronunciation(character) {
  return String(HANZI_READINGS[character] || pinyin(character) || "").trim();
}

function buildSafeChoicePrompt(subject, item, correctAnswer) {
  if (subject === "hanzi") {
    const character = item.display || correctAnswer;
    const pronunciation = hanziPronunciation(character);
    const prompt = `找到读音是“${pronunciation}”的字，只要告诉我第几个。`;
    const candidate = { questionType: "choice", prompt, correctAnswer };
    if (pronunciation && !choicePromptLeaksAnswer(candidate)) return prompt;
    const pronunciationOnly = { questionType: "choice", prompt: pronunciation, correctAnswer };
    return pronunciation && !choicePromptLeaksAnswer(pronunciationOnly) ? pronunciation : "🔊";
  }
  return "听一听，找到我读到的大写字母，只要告诉我第几个。";
}

function buildChoiceTasks(subject, selectedItems, catalog, {
  random = Math.random,
  maxTasks = 20,
  shuffleTargets = true,
  taskPrefix = "test"
} = {}) {
  const allItems = Array.isArray(catalog?.[subject]) ? catalog[subject] : [];
  const pronunciations = subject === "hanzi"
    ? new Map(allItems.map(item => {
      const character = item.optionDisplay || item.display;
      return [item.ref, new Set([hanziPronunciation(character), ...pinyin(character, { multiple: true, type: "array" })])];
    }))
    : null;
  const orderedItems = shuffleTargets ? shuffled(selectedItems, random) : [...selectedItems];
  return orderedItems.slice(0, maxTasks).map((item, index) => {
    const correctAnswer = item.optionDisplay || item.display;
    const pronunciation = subject === "hanzi" ? hanziPronunciation(correctAnswer) : "";
    // 听到同一个读音时，同音字也符合题意，不能把它当作错误选项。
    const candidates = allItems.filter(candidate => candidate.ref !== item.ref
      && (!pronunciations || !pronunciations.get(candidate.ref).has(pronunciation)));
    const learned = candidates.filter(candidate => candidate.status && candidate.status !== "未学");
    const unlearned = candidates.filter(candidate => !candidate.status || candidate.status === "未学");
    const distractors = [...new Set([...shuffled(learned, random), ...shuffled(unlearned, random)]
      .map(candidate => candidate.optionDisplay || candidate.display)
      .filter(value => value && value !== correctAnswer))].slice(0, 3);
    const options = shuffled([correctAnswer, ...distractors], random);
    const isLetter = subject === "english_letter";

    return {
      taskId: `${taskPrefix}-${subject}-${item.ref}-${index + 1}`,
      subject,
      questionType: "choice",
      isNew: false,
      prompt: buildSafeChoicePrompt(subject, item, correctAnswer),
      speechPrompt: isLetter
        ? `找到大写 ${correctAnswer}，只要告诉我第几个。`
        : HANZI_READING_EXAMPLES[correctAnswer]
          ? `找到“${HANZI_READING_EXAMPLES[correctAnswer]}”的“${correctAnswer}”，只要告诉我第几个。`
          : `找到“${correctAnswer}”，只要告诉我第几个。`,
      target: { ref: item.ref, display: item.display },
      context: isLetter && item.association
        ? `${item.display} — ${item.association}`
        : "认真看一看每个选项。",
      demonstration: isLetter
        ? `答案是大写 ${correctAnswer}，这是字母 ${correctAnswer}。`
        : `这是“${correctAnswer}”。跟我读：${correctAnswer}。`,
      options,
      correctAnswer
    };
  }).map(withTargetedHint);
}

function buildHanziOralReadingTasks(selectedItems, taskPrefix = "test") {
  return selectedItems.map((item, index) => ({
    taskId: `${taskPrefix}-hanzi-read-${item.ref}-${index + 1}`,
    subject: "hanzi",
    questionType: "recognition",
    evidenceType: "hanzi_oral_reading",
    isNew: false,
    prompt: "请读出屏幕上的汉字。",
    speechPrompt: "请读出屏幕上的汉字。",
    target: { ref: item.ref, display: item.display },
    context: "先自己想一想，再大声读出来。",
    demonstration: "请跟着读一遍。"
  })).map(withTargetedHint);
}

export function buildTestTasks(subject, selectedItems, catalog, random = Math.random, maxTasks = 20, testOptions = {}) {
  if (subject === "math") return buildMathTestTasks(selectedItems, random, maxTasks);
  if (subject === "hanzi") {
    const orderedItems = shuffled(selectedItems, random).slice(0, maxTasks);
    const mix = allocateHanziQuestionMix(orderedItems.length, testOptions.hanziOralReadingPercent);
    const oralReadingItems = orderedItems.slice(0, mix.oralReadingCount);
    const choiceItems = orderedItems.slice(mix.oralReadingCount);
    const oralReadingTasks = buildHanziOralReadingTasks(oralReadingItems);
    const choiceTasks = buildChoiceTasks(subject, choiceItems, catalog, {
      random,
      maxTasks: choiceItems.length,
      shuffleTargets: false
    });
    return shuffled([...oralReadingTasks, ...choiceTasks], random);
  }
  return buildChoiceTasks(subject, selectedItems, catalog, { random, maxTasks });
}

export function buildPreviewTasks(subject, lessonTasks, catalog, previewRefs = [], maxItems = 4) {
  const tasks = Array.isArray(lessonTasks) ? lessonTasks : [];
  const catalogItems = Array.isArray(catalog?.[subject]) ? catalog[subject] : [];
  const todayNewRefs = new Set(
    tasks.filter(task => task.subject === subject && task.isNew).map(task => task.target?.ref).filter(Boolean)
  );
  const explicitRefs = Array.isArray(previewRefs) ? previewRefs.filter(Boolean) : [];
  const derivedRefs = catalogItems
    .filter(item => item.status === "未学" && !todayNewRefs.has(item.ref))
    .map(item => item.ref);
  const refs = (explicitRefs.length ? explicitRefs : derivedRefs)
    .filter((ref, index, values) => !todayNewRefs.has(ref) && values.indexOf(ref) === index)
    .slice(0, maxItems);

  return refs.map((ref, index) => {
    const item = catalogItems.find(candidate => candidate.ref === ref);
    if (!item) return null;
    const isLetter = subject === "english_letter";
    return {
      taskId: `preview-next-${subject}-${ref}-${index + 1}`,
      subject,
      questionType: "recognition",
      isNew: false,
      prompt: isLetter ? "这是哪个英文字母？" : "这个字怎么读？",
      target: { ref: item.ref, display: item.display },
      context: isLetter
        ? `下一课会正式学习 ${item.display}，今天先看看它的样子。`
        : `下一课会正式学习“${item.display}”，今天先看看它的样子。`,
      demonstration: isLetter ? `这是 ${item.display}。` : `这是“${item.display}”。跟我读：${item.display}。`
    };
  }).filter(Boolean).map(withTargetedHint);
}

export function buildPracticeTasks(subject, lessonTasks, catalog, previousNewRefs = [], random = Math.random) {
  const tasks = Array.isArray(lessonTasks) ? lessonTasks : [];
  const newRefs = new Set(
    tasks
      .filter(task => task.subject === subject && task.isNew)
      .map(task => task.target?.ref)
      .filter(Boolean)
  );
  const explicitRefs = Array.isArray(previousNewRefs) ? previousNewRefs.filter(Boolean) : [];
  const reviewRefs = explicitRefs.length ? [...new Set(explicitRefs)] : [];
  if (!reviewRefs.length) {
    for (const task of tasks) {
      const ref = task.target?.ref;
      if (task.subject !== subject || !ref || newRefs.has(ref) || reviewRefs.includes(ref)) continue;
      reviewRefs.push(ref);
    }
  }
  const catalogItems = Array.isArray(catalog?.[subject]) ? catalog[subject] : [];
  const selectedItems = reviewRefs
    .map(ref => catalogItems.find(item => item.ref === ref))
    .filter(Boolean);
  return buildChoiceTasks(subject, selectedItems, catalog, {
    random,
    maxTasks: selectedItems.length,
    shuffleTargets: false,
    taskPrefix: "practice"
  });
}

export function buildTestLesson(subject, selectedItems, catalog, scope, customDays = 7, now = new Date(), random = Math.random, testOptions = {}) {
  const tasks = buildTestTasks(subject, selectedItems, catalog, random, selectedItems.length, testOptions);
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const scopeLabel = scope === "custom"
    ? `近 ${normalizeTestDays(customDays)} 天内容`
    : TEST_SCOPE_LABELS[scope] || TEST_SCOPE_LABELS.today;
  return {
    protocol: "FAMILY_LEARNING_LESSON_V1",
    schemaVersion: 1,
    lessonId: `test-${stamp}-${crypto.randomUUID().slice(0, 8)}`,
    generatedAt: now.toISOString(),
    basedOnSessionIds: [],
    isBootstrap: false,
    title: `${scopeLabel}测试`,
    teacherNote: "测试题由正式学习状态中的已学内容自动生成。",
    metadata: {
      estimatedMinutes: Math.max(2, Math.ceil(tasks.length * 0.6)),
      newHanziCount: 0,
      newLetterCount: 0,
      testScope: scope,
      customDays: scope === "custom" ? normalizeTestDays(customDays) : null,
      ...(subject === "hanzi" ? {
        questionMix: {
          oralReadingPercent: normalizeHanziOralReadingPercent(testOptions.hanziOralReadingPercent),
          oralReadingCount: tasks.filter(task => task.evidenceType === "hanzi_oral_reading").length,
          choiceCount: tasks.filter(task => task.questionType === "choice").length
        }
      } : {})
    },
    tasks
  };
}

export function buildTestLessons(subject, selectedItems, catalog, scope, customDays = 7, now = new Date(), random = Math.random, testOptions = {}) {
  const tasks = buildTestTasks(subject, selectedItems, catalog, random, selectedItems.length, testOptions);
  if (!tasks.length) return [];

  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const planId = `test-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const scopeLabel = scope === "custom"
    ? `近 ${normalizeTestDays(customDays)} 天内容`
    : TEST_SCOPE_LABELS[scope] || TEST_SCOPE_LABELS.today;
  return [{
    protocol: "FAMILY_LEARNING_LESSON_V1",
    schemaVersion: 1,
    lessonId: planId,
    generatedAt: now.toISOString(),
    basedOnSessionIds: [],
    isBootstrap: false,
    title: `${scopeLabel}测试`,
    teacherNote: scope === "all"
      ? `全部 ${tasks.length} 项已学内容在同一次测试中连续完成。`
      : scope === "weighted"
        ? `按错误记录难度比例随机抽取 ${tasks.length} 项；某档不足时由其他档自动补足。`
        : "测试题由正式学习状态中的已学内容自动生成。",
    metadata: {
      estimatedMinutes: Math.max(2, Math.ceil(tasks.length * 0.6)),
      newHanziCount: 0,
      newLetterCount: 0,
      testScope: scope,
      customDays: scope === "custom" ? normalizeTestDays(customDays) : null,
      testPlanId: planId,
      testTotalItems: tasks.length,
      difficultyPlan: scope === "weighted" ? testOptions.difficultyPlan || null : null,
      ...(subject === "hanzi" ? {
        questionMix: {
          oralReadingPercent: normalizeHanziOralReadingPercent(testOptions.hanziOralReadingPercent),
          oralReadingCount: tasks.filter(task => task.evidenceType === "hanzi_oral_reading").length,
          choiceCount: tasks.filter(task => task.questionType === "choice").length
        }
      } : {})
    },
    tasks
  }];
}
