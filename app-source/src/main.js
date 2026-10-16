import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { newSession, validateLesson } from "./protocol.js";
import {
  allocateDifficultyCounts,
  allocateHanziQuestionMix,
  buildPracticeTasks,
  buildPreviewTasks,
  buildTestLessons,
  DEFAULT_DIFFICULTY_WEIGHTS,
  DEFAULT_HANZI_ORAL_READING_PERCENT,
  DIFFICULTY_BUCKETS,
  normalizeHanziOralReadingPercent,
  normalizeDifficultyWeights,
  normalizeTestDays,
  normalizeTestQuestionCount,
  sampleTestItemsByDifficulty,
  selectTestItems,
  TEST_SCOPE_LABELS
} from "./test-mode.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "./voice-text.js";
import { taskHint } from "./targeted-hints.js";
import { createSpeechPlayer } from "./speech-player.js";
import { collectAiVoiceRequirements, compileAiLesson, missingAiVoiceTexts, parseAiResult } from "./ai-transfer.js";
import {
  buildMathLesson,
  buildMathPracticeTasks,
  mathStageProgress
} from "./math-mode.js";
import {
  compositionInstructions,
  createCompositionBoard,
  isCompositionModel,
  moveCompositionBoard
} from "./composition-board.js";

const app = document.querySelector("#app");

const runtime = {
  view: "home",
  selectedSubject: null,
  studyMode: "lesson",
  dashboard: null,
  lesson: null,
  mathLesson: null,
  selectedMathStage: 6,
  activeLesson: null,
  queue: [],
  modeSourceTasks: [],
  queueIndex: 0,
  session: null,
  attempt: 0,
  taskShownAt: 0,
  scheduledRetests: [],
  feedbackTimer: null,
  feedbackResolve: null,
  feedbackToken: 0,
  feedbackAdvancePending: false,
  taskElapsedMs: 0,
  sessionEnding: false,
  feedbackActive: false,
  supportMode: null,
  activeHint: "",
  compositionBoard: null,
  questionTimer: null,
  paused: false,
  answerLocked: false,
  saved: false,
  testScope: "today",
  customTestDays: 7,
  customTestQuestionCount: 20,
  testDifficultyWeights: { ...DEFAULT_DIFFICULTY_WEIGHTS },
  hanziOralReadingPercent: DEFAULT_HANZI_ORAL_READING_PERCENT,
  testLessons: [],
  voiceManifest: null,
  aiTransferBusy: false,
  aiTransferMessage: null
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 2400);
}

const speechPlayer = createSpeechPlayer({
  loadClip: fileName => command("load_voice_clip", { fileName }),
  createAudio: url => new Audio(url),
  createUrl: (bytes, fileName) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], {
    type: fileName.endsWith(".wav") ? "audio/wav" : "audio/mpeg"
  })),
  revokeUrl: url => URL.revokeObjectURL(url),
  onUnavailable: exists => toast(exists
    ? "语音暂时无法播放，请点击重听"
    : "这句自然语音还没准备好，请先更新语音包")
});

function cancelSpeech() {
  clearTimeout(runtime.questionTimer);
  runtime.questionTimer = null;
  speechPlayer.cancel();
}

function speak(text) {
  clearTimeout(runtime.questionTimer);
  runtime.questionTimer = null;
  return speechPlayer.speak(text, runtime.voiceManifest);
}

function cancelFeedback() {
  runtime.feedbackToken += 1;
  clearTimeout(runtime.feedbackTimer);
  runtime.feedbackResolve?.();
  runtime.feedbackResolve = null;
  runtime.feedbackActive = false;
  cancelSpeech();
}

function playSuccessChime() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    const context = new AudioContext();
    const start = context.currentTime;
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.11, start + index * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.08 + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * 0.08);
      oscillator.stop(start + index * 0.08 + 0.32);
    });
    window.setTimeout(() => context.close(), 900);
  } catch {
    // Some systems block synthesized tones; spoken feedback still works.
  }
}

async function command(name, args) {
  try {
    return await invoke(name, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : error?.message || "本地操作失败");
  }
}

function aiLabel(status) {
  return {
    missing: ["warn", "等待 AI 处理", "完成学习后，可导出学习资料交给 AI 分析，再导入结果。"],
    applied: ["ok", "状态更新已通过", "软件已校验并合并这次 AI 状态建议。"],
    already_applied: ["ok", "状态已是最新", "这份状态更新此前已经安全合并。"],
    invalid: ["warn", "AI 文件未通过校验", "软件没有采用这份更新，请按错误提示重新生成。"]
  }[status] || ["warn", "等待检查", "尚未取得 AI 文件状态。"];
}

function baselineLabel(status, summary) {
  const pending = (summary.hanziNeedsAssessment || 0) + (summary.letterNeedsAssessment || 0) + (summary.mathNeedsAssessment || 0);
  return {
    missing: ["", "没有待导入的家长确认清单", "需要补录旧学习内容时再使用。"],
    applied: ["ok", "家长确认内容已录入", `已校验词库编号，当前有 ${pending} 项等待测试。`],
    already_applied: ["ok", "家长确认内容已录入", `清单不会重复写入，当前有 ${pending} 项等待测试。`],
    invalid: ["warn", "家长确认清单未通过校验", "软件没有写入不完整或编号不匹配的内容。"]
  }[status] || ["warn", "等待检查家长确认清单", "尚未取得录入状态。"];
}

function renderHome() {
  app.innerHTML = `
    <main class="welcome-shell">
      <div class="welcome-cloud cloud-one"></div><div class="welcome-cloud cloud-two"></div>
      <header class="welcome-brand"><div class="brand-mark">芽</div><div><h1>小芽家庭学习</h1><p>每天一点点，知识发新芽</p></div></header>
      <section class="welcome-copy"><span class="sun-badge">☀ 今日学习已准备好</span><h2>你好呀，<br><em>准备开始了吗？</em></h2><p>选一个入口，我们一起度过轻松的学习时光。</p></section>
      <section class="entry-grid">
        <button class="entry-card child-entry" data-action="child-home"><span class="entry-art">🌱</span><span><small>孩子入口</small><strong>开始学习</strong><i>汉字 · 英语 · 数学</i></span><b>→</b></button>
        <button class="entry-card parent-entry" data-action="parent-home"><span class="entry-art">📊</span><span><small>家长入口</small><strong>家长管理</strong><i>进度 · 报告 · 学习资料</i></span><b>→</b></button>
      </section>
      <footer class="welcome-footer">本地保存 · 安心陪伴 · 适合家庭学习</footer>
    </main>`;
}

function subjectTasks(subject) {
  if (subject === "math") return runtime.mathLesson?.tasks || [];
  return (runtime.lesson?.tasks || []).filter(task => task.subject === subject);
}

function renderChildHome() {
  const summary = runtime.dashboard?.stateSummary || {};
  app.innerHTML = `
    <main class="portal-shell">
      <header class="portal-head"><button class="icon-button" data-action="home" aria-label="返回首页">←</button><div class="brand"><div class="brand-mark">芽</div><div><h1>今天想学什么？</h1><p>选择一个学科，开始新的探索</p></div></div><div class="streak">🌟 每天进步一点点</div></header>
      <section class="subject-grid">
        <button class="subject-card hanzi-card" data-subject="hanzi"><span class="subject-icon">字</span><span class="subject-copy"><small>认识中国字</small><strong>汉字学习</strong><i>已学习 ${summary.hanziLearned || 0} 个汉字</i></span><b>开始 →</b></button>
        <button class="subject-card english-card" data-subject="english_letter"><span class="subject-icon">Aa</span><span class="subject-copy"><small>认识英文字母</small><strong>英语学习</strong><i>已学习 ${summary.letterLearned || 0} / 26 个字母</i></span><b>开始 →</b></button>
        <button class="subject-card math-card" data-subject="math"><span class="coming ready">正式开放</span><span class="subject-icon">123</span><span class="subject-copy"><small>数感优先，逐步进入运算</small><strong>数学学习</strong><i>已学习 ${summary.mathLearned || 0} / ${summary.mathTotal || 35} 项</i></span><b>开始 →</b></button>
      </section>
      <section class="gentle-tip"><span>💡</span><div><strong>小芽提醒</strong><p>每天学习 10 分钟就很好，专注比时间更重要。</p></div></section>
    </main>`;
}

function modeTasks(mode, subject) {
  if (subject === "math") {
    if (mode === "practice") return buildMathPracticeTasks(runtime.dashboard?.testCatalog?.math || []);
    return subjectTasks(subject);
  }
  const tasks = subjectTasks(subject);
  const metadata = runtime.lesson?.metadata || {};
  const previewRefs = subject === "hanzi" ? metadata.nextPreviewHanziRefs : metadata.nextPreviewLetterRefs;
  const previousNewRefs = subject === "hanzi" ? metadata.previousNewHanziRefs : metadata.previousNewLetterRefs;
  if (mode === "preview") return buildPreviewTasks(subject, tasks, runtime.dashboard?.testCatalog, previewRefs, 4);
  if (mode === "practice") return buildPracticeTasks(subject, tasks, runtime.dashboard?.testCatalog, previousNewRefs);
  return tasks;
}

function learningItemLabel(subject, count) {
  if (subject === "hanzi") return `${count} 个字`;
  if (subject === "math") return `${count} 个数学目标`;
  return `${count} 个字母`;
}

function uniqueTargetCount(tasks) {
  return new Set(tasks.map(task => task.target?.ref).filter(Boolean)).size;
}

function testItems(scope = runtime.testScope, customDays = runtime.customTestDays) {
  return selectTestItems(
    runtime.dashboard?.testCatalog,
    runtime.selectedSubject,
    scope,
    customDays
  );
}

function difficultyWeightTotal(weights = runtime.testDifficultyWeights) {
  return Object.values(normalizeDifficultyWeights(weights)).reduce((sum, value) => sum + value, 0);
}

function syncDifficultyControls() {
  const allLearned = testItems("weighted");
  const countInput = document.querySelector("[data-test-question-count]");
  if (countInput) runtime.customTestQuestionCount = normalizeTestQuestionCount(countInput.value, allLearned.length);
  const weights = { ...runtime.testDifficultyWeights };
  document.querySelectorAll("[data-difficulty-weight]").forEach(input => {
    weights[input.dataset.difficultyWeight] = input.value;
  });
  runtime.testDifficultyWeights = normalizeDifficultyWeights(weights);
}

function hasPausedLesson() {
  return Boolean(runtime.paused && runtime.session && !runtime.saved);
}

function renderSubject() {
  const subject = runtime.selectedSubject;
  if (subject === "math") {
    const catalog = runtime.dashboard?.testCatalog?.math || [];
    const stageProgress = mathStageProgress(catalog);
    const activeStage = runtime.selectedMathStage;
    const currentStage = stageProgress.find(stage => stage.stage === activeStage);
    const lesson = runtime.mathLesson;
    const lessonErrors = validateLesson(lesson);
    const lessonReady = Boolean(lesson?.tasks?.length) && lessonErrors.length === 0;
    const practiceTasks = modeTasks("practice", "math");
    const learnedCount = testItems("all").length;
    const paused = hasPausedLesson();
    const modes = [
      ["lesson", "今日数学", "练习选中的阶段，每次换一组题", "🔢", lesson?.tasks?.length || 0],
      ["practice", "巩固练习", "优先练习薄弱和易错内容", "🧩", practiceTasks.length],
      ["test", "小小测试", "从已经学过的数学目标中抽题", "🏅", learnedCount]
    ];
    app.innerHTML = `<main class="portal-shell"><header class="portal-head"><button class="icon-button" data-action="${paused ? "paused-navigation" : "child-home"}" aria-label="返回学科选择">←</button><div class="brand"><div class="brand-mark math-mark">123</div><div><h1>数学学习</h1><p>${escapeHtml(lesson?.title || "数学启蒙")}</p></div></div><div class="streak">第 ${activeStage} / 6 阶段</div></header>
      <section class="math-hero"><span>🔢</span><div><small>当前学习阶段</small><h2>${escapeHtml(currentStage?.title || "数字与数量 0～5")}</h2><p>${escapeHtml(currentStage?.detail || "先认识数字，再理解数量。")} 每天学一小会儿，先用实物想明白，不用急着写数字。</p></div></section>
      ${paused ? `<section class="paused-banner"><span>⏸</span><div><strong>本次数学学习已暂停</strong><p>停在第 ${runtime.queueIndex + 1} 题，作答进度仍然保留。</p></div><button class="button primary" data-action="resume-lesson">继续学习</button><button class="button secondary" data-action="end-paused">结束本次</button></section>` : ""}
      ${lessonErrors.length ? `<div class="error-box math-error">${lessonErrors.map(escapeHtml).join("<br>")}</div>` : ""}
      <section class="math-mode-grid">${modes.map(([key, name, detail, emoji, count]) => `<button class="mode-card math-mode-card" data-mode="${key}" ${(key === "lesson" ? lessonReady : count > 0) && !paused ? "" : "disabled"}><span>${emoji}</span><strong>${name}</strong><p>${detail}</p><i>${count ? `${count} 道题${key === "test" ? " · 可自定义难度" : ""}` : "完成学习后开放"}</i></button>`).join("")}</section>
      <p class="math-stage-instruction">六个阶段已全部开放，点选下方阶段，再开始今日数学。</p>
      <section class="math-roadmap">${stageProgress.map(stage => {
        const state = stage.stage === activeStage ? "current" : stage.ready === stage.total ? "completed" : "available";
        const badge = state === "current" ? "已选择" : "可学习";
        return `<button class="math-step ${state}" data-math-stage="${stage.stage}" aria-pressed="${stage.stage === activeStage}" ${paused ? "disabled" : ""}><b>${stage.stage}</b><small>${badge}</small><h3>${escapeHtml(stage.title)}</h3><p>${escapeHtml(stage.detail)}</p><div class="math-stage-progress"><span style="width:${stage.total ? Math.round(stage.ready / stage.total * 100) : 0}%"></span></div><i>${stage.learned} / ${stage.total} 项已接触 · ${stage.ready} 项达到学习中</i></button>`;
      }).join("")}</section>
      <section class="math-note"><span>🌱</span><div><strong>每次练习都会记下你的进步</strong><p>认真完成每一道题，已经会的内容和还要多练的内容都会保存下来。</p></div></section>
      <button class="text-back" data-action="${paused ? "paused-navigation" : "child-home"}">换一个学科</button>
    </main>`;
    return;
  }
  const isHanzi = subject === "hanzi";
  const lessonErrors = [...new Set([
    ...(runtime.dashboard?.lessonValidation?.errors || []),
    ...validateLesson(runtime.lesson)
  ])];
  const lessonWarnings = [...new Set(runtime.dashboard?.lessonValidation?.warnings || [])];
  const lessonReady = Boolean(runtime.lesson) && lessonErrors.length === 0;
  const needsRefresh = lessonReady && lessonWarnings.length > 0;
  const title = isHanzi ? "汉字学习" : "英语学习";
  const icon = isHanzi ? "字" : "Aa";
  const paused = hasPausedLesson();
  const modes = [
    ["lesson", "今日课程", "按计划完成新学与复习", "🌿"],
    ["preview", "轻松预习", "预习下一课前 4 个新内容", "👀"],
    ["practice", "巩固练习", "练习上一次课程新学的内容", "✏️"],
    ["test", "小小测试", "看看已经记住多少", "🏅"]
  ];
  app.innerHTML = `<main class="portal-shell"><header class="portal-head"><button class="icon-button" data-action="${paused ? "paused-navigation" : "child-home"}">←</button><div class="brand"><div class="brand-mark ${isHanzi ? "" : "english-mark"}">${icon}</div><div><h1>${title}</h1><p>${escapeHtml(runtime.lesson?.title || "等待下一课")}</p></div></div></header>
    <section class="mode-intro ${needsRefresh || !lessonReady ? "mode-intro-warn" : ""}"><span>${needsRefresh || !lessonReady ? "⏳" : icon}</span><div><small>${!lessonReady ? "今天的课程还在准备" : needsRefresh ? "可以继续学习" : "今天的学习建议"}</small><h2>${!lessonReady ? "这个科目的课程暂时还没准备好" : needsRefresh ? "当前课程可以继续" : "选择一种学习方式"}</h2><p>${!lessonReady ? "请稍后再来，或者先选择其他已经准备好的学习内容。" : needsRefresh ? "今日课程、轻松预习和巩固练习都可以正常进入。" : "第一次学习建议从“今日课程”开始。"}</p></div></section>
    ${paused ? `<section class="paused-banner"><span>⏸</span><div><strong>本次学习已暂停</strong><p>停在第 ${runtime.queueIndex + 1} 题，作答和提示都还保留着。</p></div><button class="button primary" data-action="resume-lesson">继续学习</button><button class="button secondary" data-action="end-paused">结束本次</button></section>` : ""}
    <section class="mode-grid">${modes.map(([key, name, detail, emoji]) => {
      const tasks = key === "test" ? [] : modeTasks(key, subject);
      const count = key === "test" ? testItems("all").length : tasks.length;
      const available = key === "test" ? count > 0 : lessonReady && count > 0;
      const itemCount = uniqueTargetCount(tasks);
      const countLabel = !count ? "暂无内容"
        : key === "test" ? `已学 ${learningItemLabel(subject, count)} · 可选范围`
        : key === "lesson" ? `${count} 道题 · ${learningItemLabel(subject, itemCount)}`
        : key === "preview" ? subject === "hanzi" ? `${itemCount} 个下一课预习字` : `${itemCount} 个下一课预习字母`
        : subject === "hanzi" ? `${itemCount} 个上次新字 · 全部练习` : `${itemCount} 个上次新字母 · 全部练习`;
      return `<button class="mode-card" data-mode="${key}" ${available && !paused ? "" : "disabled"}><span>${emoji}</span><strong>${name}</strong><p>${detail}</p><i>${paused && key === runtime.studyMode ? "当前学习方式" : countLabel}</i></button>`;
    }).join("")}</section>
    <button class="text-back" data-action="${paused ? "paused-navigation" : "child-home"}">换一个学科</button></main>`;
}

function renderTestSetup() {
  if (!testItems(runtime.testScope).length) {
    runtime.testScope = ["today", "two_days", "three_days", "all"].find(scope => testItems(scope).length) || "today";
  }
  const isHanzi = runtime.selectedSubject === "hanzi";
  const isMath = runtime.selectedSubject === "math";
  const title = isHanzi ? "汉字小测试" : isMath ? "数学小测试" : "英语小测试";
  const subjectIcon = isHanzi ? "字" : isMath ? "123" : "Aa";
  const subjectMarkClass = isHanzi ? "" : isMath ? "math-mark" : "english-mark";
  const scopes = [
    ["today", "今天", "只测今天学过的内容", "☀️"],
    ["two_days", "近 2 天", "把昨天的内容也带上", "🌱"],
    ["three_days", "近 3 天", "做一次短期巩固", "🌿"],
    ["all", "全部内容", "从所有已学内容中出题", "🏆"]
  ];
  const selectedItems = testItems();
  const selectedLabel = runtime.testScope === "custom"
    ? `近 ${runtime.customTestDays} 天内容`
    : TEST_SCOPE_LABELS[runtime.testScope] || TEST_SCOPE_LABELS.today;
  const allLearned = testItems("weighted");
  runtime.customTestQuestionCount = normalizeTestQuestionCount(runtime.customTestQuestionCount, allLearned.length);
  runtime.testDifficultyWeights = normalizeDifficultyWeights(runtime.testDifficultyWeights);
  const weightTotal = difficultyWeightTotal();
  const difficultyPlan = allocateDifficultyCounts(allLearned, runtime.customTestQuestionCount, runtime.testDifficultyWeights);
  const questionCount = runtime.testScope === "all"
    ? selectedItems.length
    : runtime.testScope === "weighted"
      ? difficultyPlan.questionCount
      : selectedItems.length;
  runtime.hanziOralReadingPercent = normalizeHanziOralReadingPercent(runtime.hanziOralReadingPercent);
  const questionMix = allocateHanziQuestionMix(questionCount, runtime.hanziOralReadingPercent);
  const difficultySummary = DIFFICULTY_BUCKETS
    .map(({ key, label }) => `${label} ${difficultyPlan.actualCounts[key]} 题`)
    .join(" · ");
  const canStart = questionCount > 0 && (runtime.testScope !== "weighted" || weightTotal === 100);
  const selectionDetail = !selectedItems.length
    ? "这个范围内还没有正式学习记录。"
    : runtime.testScope === "all"
      ? `共 ${selectedItems.length} 项已学内容，全部在这一次测试中连续完成。`
      : runtime.testScope === "weighted"
        ? weightTotal === 100
          ? `从 ${allLearned.length} 项已学内容中随机抽 ${questionCount} 题。预计：${difficultySummary}；某档不足会自动补位。`
          : `四档占比当前合计 ${weightTotal}%，请调整为 100% 后开始。`
        : `共找到 ${selectedItems.length} 项已学内容，本次出 ${questionCount} 题。`;
  const questionMixDetail = isHanzi
    ? `题型安排：选择题 ${questionMix.choiceCount} 题，孩子自己读 ${questionMix.oralReadingCount} 题。`
    : "";

  app.innerHTML = `
    <main class="portal-shell test-setup-shell">
      <header class="portal-head"><button class="icon-button" data-action="subject-home" aria-label="返回学习方式">←</button><div class="brand"><div class="brand-mark ${subjectMarkClass}">${subjectIcon}</div><div><h1>${title}</h1><p>选择测试范围，系统会自动从正式学习记录中出题</p></div></div></header>
      <section class="test-hero"><div><span>🎯</span><div><small>先选范围或难度，再开始</small><h2>今天想挑战多少内容？</h2><p>可以按学习日期测试，也可以从全部已学内容中自定义题量和错误难度比例；所选题目在一次测试中连续完成。</p></div></div><b>${questionCount}<small>题</small></b></section>
      <section class="test-scope-grid">${scopes.map(([scope, name, detail, emoji]) => {
        const count = testItems(scope).length;
        return `<button class="test-scope-card ${runtime.testScope === scope ? "selected" : ""}" data-test-scope="${scope}" ${count ? "" : "disabled"}><span>${emoji}</span><div><strong>${name}</strong><p>${detail}</p></div><i>${count ? `${count} 题` : "暂无记录"}</i></button>`;
      }).join("")}</section>
      <section class="custom-test-range">
        <div><span>📅</span><div><strong>自定义最近天数</strong><p>可以输入 1～30 天，适合周末集中复习。</p></div></div>
        <label>最近 <input type="number" min="1" max="30" value="${runtime.customTestDays}" data-custom-test-days> 天</label>
        <button class="button secondary" data-action="start-custom-test">按这个范围开始</button>
      </section>
      ${isHanzi ? `<section class="question-mix-builder">
        <div class="question-mix-head"><span>🗣️</span><div><strong>选择题与自己读的比例</strong><p>“自己读”只显示汉字，不播放答案；由家长根据孩子实际读音记录对错。</p></div></div>
        <div class="question-mix-values"><div><small>选择题</small><strong>${100 - questionMix.oralReadingPercent}%</strong></div><div><small>孩子自己读</small><strong>${questionMix.oralReadingPercent}%</strong></div></div>
        <input class="question-mix-range" type="range" min="0" max="100" step="10" value="${questionMix.oralReadingPercent}" data-hanzi-reading-percent aria-label="孩子自己读题目的比例">
        <div class="question-mix-scale"><span>全部选择题</span><span>各占一半</span><span>全部自己读</span></div>
        <div class="question-mix-actual">按本次题量，实际生成：选择题 ${questionMix.choiceCount} 题 · 自己读 ${questionMix.oralReadingCount} 题</div>
      </section>` : ""}
      <section class="difficulty-test-builder ${runtime.testScope === "weighted" ? "selected" : ""}">
        <div class="difficulty-builder-head"><span>⚖️</span><div><strong>自定义题量和难度占比</strong><p>从全部已学内容随机抽题。错误次数采用正式记录，四档互不重叠；某档数量不够时会由其他档自动补足。</p></div><button data-test-scope="weighted">${runtime.testScope === "weighted" ? "已选择" : "选择此方式"}</button></div>
        <div class="difficulty-question-count"><label>这次抽 <input type="number" min="1" max="${Math.max(1, allLearned.length)}" value="${runtime.customTestQuestionCount}" data-test-question-count> 题</label><span>当前共有 ${allLearned.length} 项已学内容，全部在一次测试中连续完成。</span></div>
        <div class="difficulty-weight-grid">${DIFFICULTY_BUCKETS.map(({ key, label, detail }) => `<div class="difficulty-weight-card"><strong>${label}</strong><small>${detail}</small><label><input type="number" min="0" max="100" step="5" value="${runtime.testDifficultyWeights[key]}" data-difficulty-weight="${key}"> %</label><small>当前可抽 ${difficultyPlan.availability[key]} 项 · 预计 ${difficultyPlan.actualCounts[key]} 题</small></div>`).join("")}</div>
        <div class="difficulty-total ${weightTotal === 100 ? "" : "invalid"}">占比合计 ${weightTotal}% · ${weightTotal === 100 ? difficultySummary : "请把四项调整到正好 100%"}</div>
      </section>
      <section class="test-start-bar"><div><small>当前选择</small><strong>${escapeHtml(selectedLabel)}</strong><span>${selectionDetail}${questionMixDetail ? ` ${questionMixDetail}` : ""}</span></div><button class="button primary test-start-button" data-action="start-selected-test" ${canStart ? "" : "disabled"}>开始测试 →</button></section>
    </main>`;
}

function renderParentDashboard() {
  runtime.view = "parent";
  const data = runtime.dashboard;
  const lesson = data.lesson;
  const localErrors = validateLesson(lesson);
  const validationErrors = [...new Set([...(data.lessonValidation?.errors || []), ...localErrors])];
  const validationWarnings = [...new Set(data.lessonValidation?.warnings || [])];
  const lessonReady = Boolean(lesson) && validationErrors.length === 0;
  const mathReady = Boolean(runtime.mathLesson?.tasks?.length) && validateLesson(runtime.mathLesson).length === 0;
  const meta = lesson?.metadata || {};
  const status = aiLabel(data.ai?.stateUpdateStatus);
  const summary = data.stateSummary || {};
  const totalNeedsAssessment = (summary.hanziNeedsAssessment || 0)
    + (summary.letterNeedsAssessment || 0)
    + (summary.mathNeedsAssessment || 0);
  const baseline = baselineLabel(data.ai?.parentBaselineStatus, summary);
  const report = data.ai?.parentReport;
  const voiceClipCount = Object.keys(runtime.voiceManifest?.clips || {}).length;

  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">芽</div>
          <div><h1>家长管理</h1><p>学习进度、AI 状态与家长报告</p></div>
        </div>
        <div class="top-actions">
          <button class="button secondary" data-action="home" ${runtime.aiTransferBusy ? "disabled" : ""}>返回入口</button>
          <button class="button secondary" data-action="open-folder" ${runtime.aiTransferBusy ? "disabled" : ""}>打开数据文件夹</button>
          <button class="button secondary" data-action="refresh" ${runtime.aiTransferBusy ? "disabled" : ""}>检查 AI 新内容</button>
        </div>
      </header>

      <section class="card ai-transfer-card" aria-labelledby="ai-transfer-title" aria-busy="${Boolean(runtime.aiTransferBusy)}">
        <div class="ai-transfer-intro"><h2 id="ai-transfer-title">把学习记录交给 AI，带回下一课</h2><p>导出包含本机学习记录和课程安排。交给任意能够读取文件的 AI，按文件里的说明分析并下载结果，再回到这里导入。</p></div>
        <div class="ai-transfer-actions">
          <button class="button primary" data-action="export-ai" ${runtime.aiTransferBusy ? "disabled" : ""}>导出学习资料</button>
          <button class="button warm" data-action="import-ai" ${runtime.aiTransferBusy ? "disabled" : ""}>导入 AI 结果</button>
        </div>
        <p class="ai-transfer-help">导出时可选择桌面等位置；导入时选择 AI 生成的结果文件，检查通过后自动加载课程和报告。</p>
        <p class="ai-transfer-local-help">“检查 AI 新内容”用于重新读取本机已生成的 AI 文件，由软件检查并应用；它不会联网调用 AI。</p>
        ${runtime.aiTransferBusy ? `<div class="ai-transfer-status" role="status">${escapeHtml(runtime.aiTransferBusy === "export" ? "正在导出学习资料…" : "正在读取并检查 AI 结果…")}</div>` : ""}
        ${runtime.aiTransferMessage ? `<div class="ai-transfer-status ${runtime.aiTransferMessage.kind === "error" ? "error-box" : "success"}" role="${runtime.aiTransferMessage.kind === "error" ? "alert" : "status"}">${escapeHtml(runtime.aiTransferMessage.text)}</div>` : ""}
      </section>

      <section class="dashboard">
        <article class="card hero">
          <div>
            <div class="eyebrow">${lesson?.isBootstrap ? "第一课已准备" : "下一课已准备"}</div>
            <h2>${escapeHtml(lesson?.title || "等待下一课")}</h2>
            <p class="summary">${escapeHtml(lesson?.teacherNote || "完成当前学习后，导出学习资料，让 AI 分析并安排下一课。")}</p>
            ${validationWarnings.length ? `<div class="warning-box"><strong>有新记录，请准备下一课</strong><br>${validationWarnings.map(escapeHtml).join("<br>")}<br>当前课程仍可继续进入。</div>` : ""}
            ${validationErrors.length ? `<div class="error-box">${validationErrors.map(escapeHtml).join("<br>")}</div>` : ""}
          </div>
          <div class="hero-footer">
            <div class="lesson-meta">
              <span class="pill">约 ${escapeHtml(meta.estimatedMinutes || 10)} 分钟</span>
              <span class="pill">${lesson?.tasks?.length || 0} 个核心任务</span>
              <span class="pill">汉字 ${summary.hanziLearned || 0} / 1000</span>
              <span class="pill">字母 ${summary.letterLearned || 0} / 26</span>
              <span class="pill">数学 ${summary.mathLearned || 0} / ${summary.mathTotal || 35}</span>
              <span class="pill">待测试 ${totalNeedsAssessment} 项</span>
            </div>
            <button class="button primary" data-action="child-home" ${(lessonReady || mathReady) && !runtime.aiTransferBusy ? "" : "disabled"}>进入孩子学习</button>
          </div>
        </article>

        <div class="stack">
          <article class="card">
            <h3>闭环状态</h3>
            <div class="status-row">
              <i class="status-dot ${data.latestSessionId ? "ok" : ""}"></i>
              <div class="status-copy"><strong>${data.latestSessionId ? "已有本地学习记录" : "还没有学习记录"}</strong><span>${data.latestSessionId ? escapeHtml(data.latestSessionId) : "完成第一课后会自动保存，可以导出交给 AI 分析。"}</span></div>
            </div>
            <div class="status-row">
              <i class="status-dot ${status[0]}"></i>
              <div class="status-copy"><strong>${status[1]}</strong><span>${status[2]}</span></div>
            </div>
            <div class="status-row">
              <i class="status-dot ${baseline[0]}"></i>
              <div class="status-copy"><strong>${baseline[1]}</strong><span>${baseline[2]}</span></div>
            </div>
            <div class="status-row">
              <i class="status-dot ${lessonReady && !validationWarnings.length ? "ok" : "warn"}"></i>
              <div class="status-copy"><strong>${!lessonReady ? "课程暂不可执行" : validationWarnings.length ? "当前课程可继续，下一课待准备" : "课程协议有效"}</strong><span>汉字与字母沿用当前课程；数学按六阶段独立生成，每次最多 4 个新数学目标。</span></div>
            </div>
            <div class="status-row">
              <i class="status-dot ${voiceClipCount ? "ok" : "warn"}"></i>
              <div class="status-copy"><strong>${voiceClipCount ? "晓伊自然语音包已启用" : "自然语音包尚未准备"}</strong><span>${voiceClipCount ? `已有 ${voiceClipCount} 条预生成语音；缺失时会明确提示，不会改用机械音。` : "请先生成自然语音包，软件不会用 Windows 机械音冒充。"}</span></div>
            </div>
            ${data.ai?.stateUpdateErrors?.length ? `<div class="error-box">${data.ai.stateUpdateErrors.map(escapeHtml).join("<br>")}</div>` : ""}
            ${data.ai?.parentBaselineErrors?.length ? `<div class="error-box">${data.ai.parentBaselineErrors.map(escapeHtml).join("<br>")}</div>` : ""}
            <div class="path">${escapeHtml(data.dataDir)}</div>
          </article>

          <article class="card">
            <h3>最新家长报告</h3>
            ${report ? `<div class="report">${escapeHtml(report)}</div>` : `<div class="empty">第一课完成后，导出学习资料交给 AI。导入处理结果后，家长报告会显示在这里。</div>`}
          </article>
        </div>
      </section>
    </main>`;
}

async function refreshDashboardData() {
  const [dashboard, voiceManifest] = await Promise.all([
    command("load_dashboard"),
    command("load_voice_manifest").catch(() => null)
  ]);
  runtime.dashboard = dashboard;
  runtime.voiceManifest = voiceManifest;
  runtime.lesson = dashboard.lesson;
  try {
    const savedStage = Number(localStorage.getItem(`xiaoya.math-stage.v025:${dashboard.dataDir}`));
    runtime.selectedMathStage = savedStage >= 1 && savedStage <= 6 && Number.isInteger(savedStage) ? savedStage : 6;
  } catch { runtime.selectedMathStage = 6; }
  runtime.mathLesson = buildMathLesson(dashboard?.testCatalog?.math || [], new Date(), { stage: runtime.selectedMathStage });
}

async function loadDashboard(message, stayInParent = false) {
  app.innerHTML = `<div class="loading">正在检查本地学习资料…</div>`;
  try {
    await refreshDashboardData();
    if (stayInParent) renderParentDashboard();
    else renderHome();
    if (message) toast(message);
  } catch (error) {
    app.innerHTML = `<div class="loading">无法初始化：${escapeHtml(error.message)}</div>`;
  }
}

function chooseAiResultFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.setAttribute("aria-label", "选择 AI 生成的结果文件");
    const finish = file => { input.remove(); resolve(file); };
    input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

async function exportAiBundle() {
  if (runtime.aiTransferBusy) return;
  runtime.aiTransferBusy = "export";
  const previousMessage = runtime.aiTransferMessage;
  runtime.aiTransferMessage = null;
  renderParentDashboard();
  try {
    const result = await command("export_ai_bundle");
    runtime.aiTransferMessage = result.cancelled ? previousMessage : {
      kind: "success",
      text: result.analysisOnly
        ? `资料已导出到 ${result.path}。目前没有未处理的新记录，这份资料可用于复盘；无需导入或更换当前课程。`
        : `已导出 ${result.pendingSessionCount} 份待分析记录到 ${result.path}。把此文件交给 AI，按文件说明分析并下载结果，然后点击“导入 AI 结果”。`
    };
  } catch (error) {
    runtime.aiTransferMessage = { kind: "error", text: `导出没有完成：${error.message}` };
  } finally {
    runtime.aiTransferBusy = false;
    renderParentDashboard();
  }
}

async function importAiResult() {
  if (runtime.aiTransferBusy) return;
  runtime.aiTransferBusy = "import";
  const previousMessage = runtime.aiTransferMessage;
  runtime.aiTransferMessage = null;
  renderParentDashboard();
  let committed = false;
  try {
    const file = await chooseAiResultFile();
    if (!file) { runtime.aiTransferMessage = previousMessage; return; }
    if (file.size > 10 * 1024 * 1024) throw new Error("结果文件过大，请选择 AI 生成的结果文件，不要选择之前导出的学习资料。");
    const bundle = parseAiResult(await file.text());
    const prepared = await command("prepare_ai_import", { bundle });
    if (prepared.alreadyImported) {
      committed = true;
      await refreshDashboardData();
      runtime.aiTransferMessage = { kind: "success", text: prepared.message || "这份结果已经导入过，当前课程已重新加载。" };
      return;
    }
    const lesson = compileAiLesson(prepared.bundle, prepared);
    const voiceRequirements = collectAiVoiceRequirements(lesson, prepared.catalog);
    const manifest = await command("load_voice_manifest").catch(() => null);
    const missing = missingAiVoiceTexts(voiceRequirements, manifest);
    if (missing.length) throw new Error(`这份课程还缺 ${missing.length} 条可用的晓伊自然语音，例如：${missing.slice(0, 3).join("；")}。请先补齐语音后重新导入。`);
    const result = await command("import_ai_result", { bundle: prepared.bundle, lesson, voiceRequirements });
    committed = true;
    await refreshDashboardData();
    runtime.aiTransferMessage = {
      kind: "success",
      text: result.alreadyImported ? result.message : `AI 结果已导入，课程和家长报告已更新。下一课：${runtime.lesson?.title || lesson.title}。`
    };
  } catch (error) {
    runtime.aiTransferMessage = {
      kind: "error",
      text: committed
        ? `结果已保存，刷新显示暂未完成：${error.message}。请重新打开软件查看。`
        : `这次没有导入，原课程继续保留：${error.message}`
    };
  } finally {
    runtime.aiTransferBusy = false;
    renderParentDashboard();
  }
}

function currentTask() {
  return runtime.queue[runtime.queueIndex];
}

function subjectName(subject) {
  return subject === "hanzi" ? "汉字" : subject === "math" ? "数学" : "英语字母";
}

function recordEvent(result, extra = {}) {
  const task = currentTask();
  runtime.session.events.push({
    eventId: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    taskId: task.taskId,
    originalTaskId: task.originalTaskId || task.taskId,
    subject: task.subject,
    targetRef: task.target.ref,
    targetDisplay: task.target.display,
    questionType: task.questionType,
    evidenceType: task.evidenceType || task.questionType,
    attempt: runtime.attempt,
    result,
    independent: result === "correct" && runtime.attempt === 1,
    hintUsed: runtime.attempt > 1,
    responseTimeMs: Math.max(0, runtime.taskElapsedMs + Date.now() - runtime.taskShownAt),
    ...extra
  });
}

function scheduleRetest(task) {
  if (task.isRetest || runtime.scheduledRetests.some(item => item.targetRef === task.target.ref)) return;
  const dueAfter = runtime.queueIndex + 4;
  const fillers = runtime.modeSourceTasks.filter(candidate => candidate.target.ref !== task.target.ref);
  let fillerIndex = 0;
  while (runtime.queue.length < dueAfter && fillers.length) {
    const filler = structuredClone(fillers[fillerIndex % fillers.length]);
    filler.taskId = `${filler.taskId}-gap-${runtime.queue.length}`;
    filler.originalTaskId = filler.originalTaskId || fillers[fillerIndex % fillers.length].taskId;
    filler.isNew = false;
    filler.isRetest = true;
    runtime.queue.push(filler);
    fillerIndex += 1;
  }
  runtime.scheduledRetests.push({
    dueAfter,
    targetRef: task.target.ref,
    task: {
      ...structuredClone(task),
      taskId: `${task.taskId}-auto-retest`,
      originalTaskId: task.originalTaskId || task.taskId,
      isNew: false,
      isRetest: true,
      prompt: task.prompt
    }
  });
}

function insertDueRetest() {
  const dueIndex = runtime.scheduledRetests.findIndex(item => item.dueAfter <= runtime.queueIndex);
  if (dueIndex < 0) return;
  const [due] = runtime.scheduledRetests.splice(dueIndex, 1);
  runtime.queue.splice(runtime.queueIndex, 0, due.task);
}

async function showFeedback(title, detail, voiceText, followUpVoiceText, onDone) {
  cancelFeedback();
  const token = runtime.feedbackToken;
  const stillCurrent = () => token === runtime.feedbackToken && !runtime.paused && !runtime.sessionEnding;
  const stage = document.querySelector(".stage");
  runtime.feedbackActive = true;
  runtime.feedbackAdvancePending = true;
  document.querySelectorAll("[data-answer], [data-choice], [data-action^='repeat-']").forEach(node => { node.disabled = true; });
  stage.insertAdjacentHTML("beforeend", `<div class="feedback" role="status"><div class="feedback-card"><div class="feedback-mark"><span>👍</span><i></i><i></i><i></i></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>${currentTask()?.subject === "hanzi" ? '<button class="button secondary" data-action="repeat-feedback">🔊 再听一遍</button>' : ""}<button class="button secondary" data-action="next-feedback">下一题 →</button></div></div>`);
  playSuccessChime();
  const minimumDisplay = new Promise(resolve => {
    runtime.feedbackResolve = resolve;
    runtime.feedbackTimer = window.setTimeout(resolve, 1400);
  });
  await Promise.all([speak(voiceText), minimumDisplay]);
  if (!stillCurrent()) return;
  runtime.feedbackResolve = null;
  if (followUpVoiceText) {
    document.querySelector(".feedback h2").textContent = "一起记一记";
    document.querySelector(".feedback p").textContent = followUpVoiceText;
    const status = await speak(followUpVoiceText);
    // 保留词语和重播入口，声音失败时不能静默切到下一题。
    if (status !== "ended") return;
  }
  if (!stillCurrent()) return;
  runtime.feedbackActive = false;
  runtime.feedbackAdvancePending = false;
  onDone();
}

function renderSupport(task) {
  if (runtime.supportMode === "hint") {
    return `<div class="hint-panel" role="status"><span>💡 小线索</span><strong>${escapeHtml(runtime.activeHint || taskHint(task))}</strong><button class="voice-button" data-action="repeat-hint" aria-label="再听一次提示">🔊 再听一次</button></div>`;
  }
  if (runtime.supportMode === "demo") {
    return `<div class="demo-panel"><span>🔊 跟我说一次：</span><strong>${escapeHtml(demonstrationSpeechText(task))}</strong></div><div class="manual-controls"><button class="button warm" data-action="continue">跟读后继续</button><button class="voice-button large" data-action="repeat-demo">再听一次</button></div>`;
  }
  return "";
}

function compositionApples(count) {
  return Array.from({ length: count }, () => "<span aria-hidden=\"true\">🍎</span>").join("");
}

function renderCompositionBoard(task) {
  const board = runtime.compositionBoard;
  if (!board || !isCompositionModel(task)) return "";
  const instruction = compositionInstructions(task.composition)[board.phase];
  const joined = board.phase === "answer";
  const remaining = joined ? board.whole : board.whole - board.left - board.right;
  return `<div class="composition-board" aria-label="分与合操作区">
    <div class="composition-instruction" role="status">${escapeHtml(instruction)}</div>
    ${board.phase === "join" ? "" : `<div class="composition-tray"><strong>${joined ? "合起来" : "原来有"}</strong><div class="composition-apples">${compositionApples(remaining)}</div></div>`}
    ${joined ? `<button class="composition-restart" data-composition="restart">↺ 再摆一次</button>` : `
      <div class="composition-bowls">
        <button class="composition-bowl" data-composition="left" aria-label="往左边盘子放一个苹果" ${board.phase === "left" ? "" : "disabled"}>
          <strong>左边的盘子</strong><div class="composition-apples">${compositionApples(board.left)}</div><small>${board.phase === "left" ? "点这里，放一个" : ""}</small>
        </button>
        <button class="composition-bowl" data-composition="right" aria-label="往右边盘子放一个苹果" ${board.phase === "right" ? "" : "disabled"}>
          <strong>右边的盘子</strong><div class="composition-apples">${compositionApples(board.right)}</div><small>${board.phase === "right" ? "点这里，放一个" : ""}</small>
        </button>
      </div>
      ${board.phase === "join" ? `<button class="button warm composition-join" data-composition="join">合起来，再数一数</button>` : ""}`}
  </div>`;
}

function updateCompositionBoard(action) {
  const task = currentTask();
  if (!isCompositionModel(task) || runtime.answerLocked || runtime.feedbackActive
      || runtime.paused || runtime.saved || runtime.sessionEnding) return;
  const before = runtime.compositionBoard;
  const after = moveCompositionBoard(before, action);
  if (after === before) return;
  runtime.compositionBoard = after;
  const boardNode = document.querySelector(".composition-board");
  if (boardNode) boardNode.outerHTML = renderCompositionBoard(task);
  const choices = document.querySelector("#task-choice-area");
  if (choices) choices.innerHTML = after.phase === "answer" ? renderChoices(task) : "";
  if (after.phase !== before.phase) {
    speak(compositionInstructions(task.composition)[after.phase], { rate: 1.04, pitch: 1.08 });
  }
}

function renderLesson(resetTask = true) {
  cancelSpeech();
  const task = currentTask();
  if (!task) return finishSession(true, "completed");
  if (resetTask) {
    runtime.taskElapsedMs = 0;
    runtime.attempt = 1;
    runtime.supportMode = null;
    runtime.activeHint = "";
    runtime.compositionBoard = createCompositionBoard(task);
  }
  if (isCompositionModel(task) && !runtime.compositionBoard) runtime.compositionBoard = createCompositionBoard(task);
  runtime.answerLocked = runtime.supportMode === "demo";
  runtime.paused = false;
  runtime.taskShownAt = Date.now();
  const progress = Math.min(100, ((runtime.queueIndex + 1) / runtime.queue.length) * 100);
  const isLetter = task.subject === "english_letter";
  const isMath = task.subject === "math";
  const isHanziOralReading = task.evidenceType === "hanzi_oral_reading";
  const isMathDigitReading = task.evidenceType === "math_digit_reading";
  const correctButtonLabel = isHanziOralReading
    ? "读对了"
    : isMathDigitReading
      ? "说对了"
      : "答对了";
  const wrongButtonLabel = isHanziOralReading
    ? "暂时没读对"
    : isMathDigitReading
      ? "暂时没说对"
      : "没答对";

  const modeLabel = { lesson: "今日课程", preview: "轻松预习", practice: "巩固练习", test: "小小测试" }[runtime.studyMode];
  app.innerHTML = `
    <main class="lesson-shell">
      <header class="lesson-head">
        <div class="lesson-head-left"><button class="lesson-back" data-action="lesson-back">← 返回学习方式</button><div class="brand"><div class="brand-mark">芽</div><div><h1>${subjectName(task.subject)} · ${modeLabel}</h1><p>一次只做一个小任务</p></div></div></div>
        <div class="progress"><span>第 ${runtime.queueIndex + 1} / ${runtime.queue.length} 题</span><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>
      </header>
      <section class="stage">
        <div class="subject-tag">${modeLabel}${task.isRetest ? " · 稍后再试" : ""}</div>
        <div class="task">
          <div class="prompt">${escapeHtml(task.prompt)}</div>
          ${task.visualPrompt ? `<div class="math-visual ${isMath ? "" : "compact"} ${task.evidenceType === "math_arithmetic_model" ? "model" : ""}">${escapeHtml(task.visualPrompt)}</div>` : ""}
          ${isCompositionModel(task) ? renderCompositionBoard(task) : ""}
          ${task.questionType === "choice" ? `<div id="task-choice-area">${isCompositionModel(task) && runtime.compositionBoard?.phase !== "answer" ? "" : renderChoices(task, runtime.answerLocked)}</div>` : `
            ${task.visualPrompt ? "" : `<div class="glyph ${isLetter ? "letter" : ""}">${escapeHtml(task.target.display)}</div>`}
            <div class="context">${escapeHtml(task.context || "认真看一看，再说出来。")}</div>
            <div class="manual-controls">
              <button class="button primary" data-answer="correct" ${runtime.answerLocked ? "disabled" : ""}>${correctButtonLabel}</button>
              <button class="button danger" data-answer="wrong" ${runtime.answerLocked ? "disabled" : ""}>${wrongButtonLabel}</button>
            </div>`}
          <div id="support">${renderSupport(task)}</div>
        </div>
      </section>
      <footer class="lesson-controls">
        <button class="voice-button" data-action="repeat-question">🔊 再听题目</button>
        <button class="button secondary" data-action="stop">今天先到这里</button>
      </footer>
    </main>`;
  const spokenTaskId = task.taskId;
  clearTimeout(runtime.questionTimer);
  runtime.questionTimer = window.setTimeout(() => {
    if (!runtime.feedbackActive && !runtime.paused && !runtime.sessionEnding && currentTask()?.taskId === spokenTaskId) {
      const text = runtime.supportMode === "hint"
        ? hintSpeechText(task, runtime.activeHint || taskHint(task))
        : runtime.supportMode === "demo" ? demonstrationSpeechText(task)
          : isCompositionModel(task)
            ? compositionInstructions(task.composition)[runtime.compositionBoard?.phase || "left"]
            : questionSpeechText(task);
      speak(text, { rate: 1.04, pitch: 1.08 });
    }
  }, 160);
}

function renderChoices(task, disabled = false) {
  return `<div class="choices">${task.options.map((option, index) => `
    <button class="choice" data-choice="${escapeHtml(option)}" ${disabled ? "disabled" : ""}>
      <span class="choice-number">${index + 1}</span>
      <span class="choice-value">${escapeHtml(option)}</span>
    </button>`).join("")}</div>`;
}

function answer(isCorrect, childAnswer = null) {
  if (runtime.answerLocked || runtime.paused || runtime.saved || runtime.sessionEnding || !document.querySelector(".stage")) return;
  const task = currentTask();
  if (isCompositionModel(task) && runtime.compositionBoard?.phase !== "answer") return;
  cancelSpeech();
  if (isCorrect) {
    runtime.answerLocked = true;
    recordEvent("correct", { childAnswer, correctAnswer: task.correctAnswer || task.target.display });
    showCorrectFeedback(task);
    return;
  }

  recordEvent("incorrect", { childAnswer, correctAnswer: task.correctAnswer || task.target.display });
  scheduleRetest(task);
  const support = document.querySelector("#support");
  if (runtime.attempt === 1) {
    recordEvent("hint_shown", { independent: false });
    runtime.supportMode = "hint";
    runtime.activeHint = taskHint(task, childAnswer);
    support.innerHTML = renderSupport(task);
    support.scrollIntoView({ block: "nearest", behavior: "smooth" });
    speak(hintSpeechText(task, runtime.activeHint), { rate: 1.04, pitch: 1.08 });
    runtime.attempt = 2;
    runtime.taskElapsedMs = 0;
    runtime.taskShownAt = Date.now();
    return;
  }

  recordEvent("demonstrated", { independent: false });
  runtime.supportMode = "demo";
  runtime.answerLocked = true;
  support.innerHTML = renderSupport(task);
  support.scrollIntoView({ block: "nearest", behavior: "smooth" });
  speak(demonstrationSpeechText(task), { rate: 1.02, pitch: 1.06 });
  document.querySelectorAll("[data-answer], [data-choice]").forEach(node => { node.disabled = true; });
}

function showCorrectFeedback(task) {
  const independent = runtime.attempt === 1;
  const reinforcement = independent || task.subject === "hanzi" ? reinforcementSpeechText(task, runtime.studyMode) : "";
  return showFeedback(
    independent ? "真棒，答对了！" : "太好了，找到了！",
    task.composition ? `${task.composition.whole}＝${task.composition.left}＋${task.correctAnswer}`
      : task.subject === "hanzi" ? reinforcement : `答案是“${task.correctAnswer || task.target.display}”`,
    independent ? "真棒，答对了！" : "太好了，这次答对了！",
    reinforcement,
    advance
  );
}

function advance() {
  if (runtime.paused || runtime.sessionEnding || runtime.saved) return;
  cancelFeedback();
  runtime.feedbackAdvancePending = false;
  runtime.queueIndex += 1;
  insertDueRetest();
  renderLesson();
}

function pauseLesson() {
  cancelFeedback();
  if (!runtime.session || runtime.saved) return renderSubject();
  if (runtime.session.events.length === 0) {
    runtime.session = null;
    runtime.queue = [];
    runtime.scheduledRetests = [];
    runtime.supportMode = null;
    runtime.paused = false;
    renderSubject();
    return;
  }
  runtime.taskElapsedMs += Math.max(0, Date.now() - runtime.taskShownAt);
  runtime.paused = true;
  renderSubject();
}

function resumeLesson() {
  if (!hasPausedLesson()) return;
  runtime.paused = false;
  if (runtime.feedbackAdvancePending && currentTask()?.subject === "hanzi") {
    renderLesson(false);
    runtime.answerLocked = true;
    showCorrectFeedback(currentTask());
  } else if (runtime.feedbackAdvancePending) advance();
  else renderLesson(false);
}

async function stopLesson() {
  cancelFeedback();
  if (!runtime.session?.events?.length) {
    runtime.session = null;
    runtime.queue = [];
    runtime.scheduledRetests = [];
    runtime.supportMode = null;
    runtime.paused = false;
    renderSubject();
    toast("还没有作答，本次未生成学习记录");
    return;
  }
  await finishSession(false, "parent_stopped");
}

async function finishSession(completed, stopReason) {
  if (runtime.saved) return;
  cancelFeedback();
  runtime.sessionEnding = true;
  runtime.answerLocked = true;
  runtime.paused = false;
  runtime.saved = true;
  runtime.session.endedAt ||= new Date().toISOString();
  runtime.session.completed = completed;
  runtime.session.stopReason = stopReason;
  runtime.session.lessonTaskCount = runtime.modeSourceTasks.length;
  runtime.session.executedTaskCount = new Set(runtime.session.events.map(event => event.taskId)).size;
  runtime.session.lessonProtocol = runtime.activeLesson.protocol;
  app.innerHTML = `<div class="loading">正在保存本节真实作答记录…</div>`;
  try {
    const result = await command("save_session", { session: runtime.session });
    app.innerHTML = `
      <main class="shell">
        <section class="card hero" style="max-width:850px;margin:10vh auto 0;min-height:360px">
          <div><div class="eyebrow">本节已安全保存</div><h2>${completed && runtime.studyMode === "test" ? `全部 ${runtime.modeSourceTasks.length} 题测试完成啦` : completed ? "今天的学习完成啦" : "今天就学到这里"}</h2><p class="summary">原始记录已经写入本地且不会被 AI 修改。下一步请打开 ChatGPT 桌面版 Work，在这个数据文件夹中说：“处理最新学习记录”。</p><div class="path">${escapeHtml(result.path)}</div></div>
          <div class="hero-footer"><div class="lesson-meta"><span class="pill">${runtime.session.events.length} 条事实记录</span><span class="pill">未直接改写正式进度</span></div><button class="button primary" data-action="home">回到首页</button></div>
        </section>
      </main>`;
  } catch (error) {
    runtime.saved = false;
    app.innerHTML = `<div class="loading">保存失败：${escapeHtml(error.message)}<br><button class="button primary" data-action="retry-save">重试保存</button></div>`;
  }
}

function startLesson(mode = "lesson") {
  if (hasPausedLesson()) return toast("请先继续或结束当前学习");
  if (mode === "test") return renderTestSetup();
  if (runtime.selectedSubject === "math" && mode === "lesson") {
    runtime.mathLesson = buildMathLesson(runtime.dashboard?.testCatalog?.math || [], new Date(), { stage: runtime.selectedMathStage });
  }
  const activeLesson = runtime.selectedSubject === "math" ? runtime.mathLesson : runtime.lesson;
  const errors = validateLesson(activeLesson);
  if (errors.length) return toast(`课程不可执行：${errors[0]}`);
  const selected = modeTasks(mode, runtime.selectedSubject);
  if (!selected.length) return toast("这个学习方式暂时没有可用内容");
  runtime.studyMode = mode;
  runtime.activeLesson = activeLesson;
  runtime.queue = structuredClone(selected);
  runtime.modeSourceTasks = structuredClone(selected);
  runtime.queueIndex = 0;
  runtime.session = newSession(activeLesson);
  runtime.session.lessonTitle = activeLesson.title;
  runtime.session.activityMode = mode;
  runtime.session.plannedNewHanziRefs = mode === "lesson"
    ? [...new Set(selected.filter(task => task.subject === "hanzi" && task.isNew).map(task => task.target.ref))]
    : [];
  runtime.session.plannedNewLetterRefs = mode === "lesson"
    ? [...new Set(selected.filter(task => task.subject === "english_letter" && task.isNew).map(task => task.target.ref))]
    : [];
  runtime.session.plannedNewMathRefs = mode === "lesson"
    ? [...new Set(selected.filter(task => task.subject === "math" && task.isNew).map(task => task.target.ref))]
    : [];
  runtime.session.plannedNextPreviewHanziRefs = mode === "lesson"
    ? [...new Set(activeLesson?.metadata?.nextPreviewHanziRefs || [])]
    : [];
  runtime.scheduledRetests = [];
  runtime.supportMode = null;
  runtime.feedbackActive = false;
  runtime.paused = false;
  runtime.saved = false;
  runtime.sessionEnding = false;
  runtime.feedbackAdvancePending = false;
  renderLesson();
}

function beginTestLesson(index) {
  const testLesson = runtime.testLessons[index];
  if (!testLesson) return renderSubject();
  const errors = validateLesson(testLesson);
  if (errors.length) return toast(`测试暂时无法开始：${errors[0]}`);
  runtime.studyMode = "test";
  runtime.activeLesson = testLesson;
  runtime.queue = structuredClone(testLesson.tasks);
  runtime.modeSourceTasks = structuredClone(testLesson.tasks);
  runtime.queueIndex = 0;
  runtime.session = newSession(testLesson);
  runtime.session.lessonTitle = testLesson.title;
  runtime.session.activityMode = "test";
  runtime.session.plannedNewHanziRefs = [];
  runtime.session.plannedNewLetterRefs = [];
  runtime.session.plannedNewMathRefs = [];
  runtime.session.plannedNextPreviewHanziRefs = [];
  runtime.scheduledRetests = [];
  runtime.supportMode = null;
  runtime.feedbackActive = false;
  runtime.paused = false;
  runtime.saved = false;
  runtime.sessionEnding = false;
  runtime.feedbackAdvancePending = false;
  renderLesson();
}

function startTest(scope = runtime.testScope, customDays = runtime.customTestDays) {
  if (hasPausedLesson()) return toast("请先继续或结束当前学习");
  const normalizedDays = normalizeTestDays(customDays);
  let selected = testItems(scope, normalizedDays);
  if (!selected.length) return toast("这个范围内还没有学过的内容");
  let difficultyPlan = null;
  if (scope === "weighted") {
    syncDifficultyControls();
    const weightTotal = difficultyWeightTotal();
    if (weightTotal !== 100) return toast(`四档占比当前合计 ${weightTotal}%，请调整为 100%`);
    const sample = sampleTestItemsByDifficulty(
      selected,
      runtime.customTestQuestionCount,
      runtime.testDifficultyWeights
    );
    selected = sample.items;
    difficultyPlan = {
      weights: sample.weights,
      availability: sample.availability,
      requestedCounts: sample.requestedCounts,
      actualCounts: sample.actualCounts
    };
  }
  const testLessons = buildTestLessons(
    runtime.selectedSubject,
    selected,
    runtime.dashboard.testCatalog,
    scope,
    normalizedDays,
    new Date(),
    Math.random,
    {
      difficultyPlan,
      hanziOralReadingPercent: runtime.selectedSubject === "hanzi"
        ? runtime.hanziOralReadingPercent
        : 0
    }
  );
  const errors = testLessons.flatMap(validateLesson);
  if (errors.length) return toast(`测试暂时无法开始：${errors[0]}`);

  runtime.testScope = scope;
  runtime.customTestDays = normalizedDays;
  runtime.testLessons = testLessons;
  beginTestLesson(0);
}

document.addEventListener("click", async event => {
  if (event.target.closest("button:disabled") || event.detail > 1) return;
  const action = event.target.closest("[data-action]")?.dataset.action;
  const answerKind = event.target.closest("[data-answer]")?.dataset.answer;
  const choice = event.target.closest("[data-choice]")?.dataset.choice;
  const subject = event.target.closest("[data-subject]")?.dataset.subject;
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  const testScope = event.target.closest("[data-test-scope]")?.dataset.testScope;
  const mathStage = event.target.closest("[data-math-stage]")?.dataset.mathStage;
  const compositionAction = event.target.closest("[data-composition]")?.dataset.composition;

  if (compositionAction) return updateCompositionBoard(compositionAction);

  if (mathStage) {
    if (hasPausedLesson()) return toast("请先继续或结束当前学习");
    runtime.selectedMathStage = Number(mathStage);
    try { localStorage.setItem(`xiaoya.math-stage.v025:${runtime.dashboard.dataDir}`, mathStage); } catch { /* 仍可在本次使用所选阶段。 */ }
    runtime.mathLesson = buildMathLesson(runtime.dashboard?.testCatalog?.math || [], new Date(), { stage: runtime.selectedMathStage });
    renderSubject();
  }

  if (answerKind) answer(answerKind === "correct");
  if (choice != null) answer(choice === currentTask().correctAnswer, choice);
  if (subject) { runtime.selectedSubject = subject; renderSubject(); }
  if (mode) startLesson(mode);
  if (testScope) { runtime.testScope = testScope; renderTestSetup(); }
  if (action === "start") startLesson();
  if (action === "child-home") {
    if (hasPausedLesson()) { renderSubject(); toast("请先继续或结束当前学习"); }
    else renderChildHome();
  }
  if (action === "subject-home") renderSubject();
  if (action === "start-selected-test") {
    syncDifficultyControls();
    startTest();
  }
  if (action === "start-custom-test") {
    const days = normalizeTestDays(document.querySelector("[data-custom-test-days]")?.value);
    startTest("custom", days);
  }
  if (action === "parent-home") renderParentDashboard();
  if (action === "refresh" && !runtime.aiTransferBusy) await loadDashboard("已经重新检查本机 AI 文件", true);
  if (action === "export-ai") await exportAiBundle();
  if (action === "import-ai") await importAiResult();
  if (action === "open-folder") {
    try { await command("open_data_folder"); } catch (error) { toast(error.message); }
  }
  if (action === "lesson-back") pauseLesson();
  if (action === "resume-lesson") resumeLesson();
  if (action === "end-paused") await stopLesson();
  if (action === "paused-navigation") toast("请先继续或结束当前学习");
  if (action === "next-feedback" && runtime.feedbackActive) advance();
  if (action === "repeat-feedback" && runtime.feedbackActive) showCorrectFeedback(currentTask());
  if (action === "repeat-question" && !runtime.feedbackActive) {
    const task = currentTask();
    const instruction = isCompositionModel(task)
      ? compositionInstructions(task.composition)[runtime.compositionBoard?.phase || "left"]
      : questionSpeechText(task);
    speak(instruction);
  }
  if (action === "repeat-hint") speak(hintSpeechText(currentTask(), runtime.activeHint || taskHint(currentTask())), { rate: 1.04, pitch: 1.08 });
  if (action === "repeat-demo") speak(demonstrationSpeechText(currentTask()), { rate: 1.02, pitch: 1.06 });
  if (action === "stop") await stopLesson();
  if (action === "continue" && runtime.supportMode === "demo") advance();
  if (action === "home") renderHome();
  if (action === "retry-save") await finishSession(runtime.session.completed, runtime.session.stopReason);
});

document.addEventListener("change", event => {
  if (event.target.matches("[data-hanzi-reading-percent]")) {
    runtime.hanziOralReadingPercent = normalizeHanziOralReadingPercent(event.target.value);
    renderTestSetup();
    return;
  }
  if (event.target.matches("[data-test-question-count], [data-difficulty-weight]")) {
    syncDifficultyControls();
    runtime.testScope = "weighted";
    renderTestSetup();
  }
});

document.addEventListener("keydown", event => {
  if (!runtime.session || runtime.saved || runtime.paused || runtime.sessionEnding || event.repeat
      || event.ctrlKey || event.altKey || event.metaKey
      || event.target.closest("input, textarea, select, [contenteditable=true]")) return;
  if (/^[1-4]$/.test(event.key) && currentTask()?.questionType === "choice"
      && (!isCompositionModel(currentTask()) || runtime.compositionBoard?.phase === "answer")) {
    const option = currentTask().options[Number(event.key) - 1];
    if (option != null) answer(option === currentTask().correctAnswer, option);
  } else if (event.key.toLowerCase() === "t" && currentTask()?.questionType === "recognition") answer(true);
  else if (event.key.toLowerCase() === "f" && currentTask()?.questionType === "recognition") answer(false);
});

loadDashboard();
