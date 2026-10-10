// 儿童学习界面。教学逻辑全部来自 ./core（与 Windows 端同一份源码），
// 这里只负责触屏排版、作答记录与语音调度。
import {
  allocateDifficultyCounts,
  allocateHanziQuestionMix,
  buildPracticeTasks,
  buildPreviewTasks,
  buildTestLessons,
  DEFAULT_DIFFICULTY_WEIGHTS,
  DEFAULT_HANZI_ORAL_READING_PERCENT,
  DIFFICULTY_BUCKETS,
  normalizeDifficultyWeights,
  normalizeHanziOralReadingPercent,
  normalizeTestDays,
  normalizeTestQuestionCount,
  sampleTestItemsByDifficulty,
  selectTestItems,
  TEST_SCOPE_LABELS
} from "./core/test-mode.js";
import { buildMathLesson, buildMathPracticeTasks, mathStageProgress } from "./core/math-mode.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "./core/voice-text.js";
import { taskHint } from "./core/targeted-hints.js";
import { compositionInstructions, createCompositionBoard, isCompositionModel, moveCompositionBoard } from "./core/composition-board.js";
import { validateLesson } from "./core/protocol.js";
import { cancelSpeech, speak } from "./voice.js";
import { newSession, sha256Hex, deviceCode, studentCode, detectPlatform } from "./store.js";
import { appendLog, putSession, putDraft, deleteDraft, latestDraft, listSessions } from "./db.js";
import { analyzeSessions, mergeCatalogProgress } from "./analysis.js";
import { captureFocus, restoreFocus } from "./focus-keep.js";

// 测试设置页里会被输入/拖动的控件。这些控件触发 change 后页面会重绘，
// 重绘必须把焦点交还给同一个控件，否则手机上连续填写题量和占比时会不断失焦。
function testInputSelector(node) {
  for (const attr of ["data-custom-test-days", "data-test-question-count", "data-hanzi-reading-percent"]) {
    if (node.hasAttribute(attr)) return `[${attr}]`;
  }
  const weight = node.getAttribute("data-difficulty-weight");
  return weight != null ? `[data-difficulty-weight="${weight}"]` : null;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function subjectName(subject) {
  return subject === "hanzi" ? "汉字" : subject === "math" ? "数学" : "英语字母";
}

function learningItemLabel(subject, count) {
  if (subject === "hanzi") return `${count} 个字`;
  if (subject === "math") return `${count} 个数学目标`;
  return `${count} 个字母`;
}

export function createChildApp({ root, toast, getPackage, onNeedParent, onSessionSaved }) {
  const runtime = {
    view: "home",
    selectedSubject: null,
    studyMode: "lesson",
    pkg: null,
    mathStage: 6,
    queue: [],
    modeSourceTasks: [],
    queueIndex: 0,
    session: null,
    attempt: 1,
    taskShownAt: 0,
    taskElapsedMs: 0,
    scheduledRetests: [],
    supportMode: null,
    activeHint: "",
    compositionBoard: null,
    paused: false,
    answerLocked: false,
    saved: false,
    saveFailed: false,
    sessionEnding: false,
    feedbackActive: false,
    feedbackAdvancePending: false,
    feedbackTimer: null,
    feedbackToken: 0,
    questionTimer: null,
    testScope: "today",
    customTestDays: 7,
    testQuestionCount: 20,
    testWeights: { ...DEFAULT_DIFFICULTY_WEIGHTS },
    hanziOralReadingPercent: DEFAULT_HANZI_ORAL_READING_PERCENT
  };

  // 随应用发布的课程包是「通用课程」：不含家庭学习进度（避免把私人进度放进公开静态文件）。
  // 因此孩子端使用的目录 = 内置目录 + 本机真实作答证据推导出的 status / lastSeenAt，
  // 否则小测试会永远显示「暂无记录」。
  runtime.observedCatalog = null;

  async function refreshObservedCatalog() {
    const base = runtime.pkg?.package?.catalog || { hanzi: [], english_letter: [], math: [] };
    try {
      const rows = await listSessions();
      runtime.observedCatalog = mergeCatalogProgress(base, analyzeSessions(rows));
    } catch {
      runtime.observedCatalog = mergeCatalogProgress(base, { targets: [] });
    }
    return runtime.observedCatalog;
  }

  function catalog() {
    return runtime.observedCatalog || runtime.pkg?.package?.catalog || { hanzi: [], english_letter: [], math: [] };
  }

  function summary() {
    return runtime.pkg?.package?.summary || {};
  }

  function lesson() {
    return runtime.pkg?.package?.lesson || null;
  }

  function mathLesson() {
    return buildMathLesson(catalog().math || [], new Date(), { stage: runtime.mathStage });
  }

  function subjectTasks(subject) {
    if (subject === "math") return mathLesson().tasks || [];
    return (lesson()?.tasks || []).filter(task => task.subject === subject);
  }

  function modeTasks(mode, subject) {
    if (subject === "math") {
      if (mode === "practice") return buildMathPracticeTasks(catalog().math || []);
      return subjectTasks(subject);
    }
    const tasks = subjectTasks(subject);
    const metadata = lesson()?.metadata || {};
    const previewRefs = subject === "hanzi" ? metadata.nextPreviewHanziRefs : metadata.nextPreviewLetterRefs;
    const previousNewRefs = subject === "hanzi" ? metadata.previousNewHanziRefs : metadata.previousNewLetterRefs;
    if (mode === "preview") return buildPreviewTasks(subject, tasks, catalog(), previewRefs, 4);
    if (mode === "practice") return buildPracticeTasks(subject, tasks, catalog(), previousNewRefs);
    return tasks;
  }

  function testItems(scope = runtime.testScope) {
    return selectTestItems(catalog(), runtime.selectedSubject, scope, runtime.customTestDays);
  }

  function currentTask() {
    return runtime.queue[runtime.queueIndex];
  }

  function hasPaused() {
    return Boolean(runtime.paused && runtime.session && !runtime.saved);
  }

  /* ---------------- 草稿：刷新/关闭不丢已发生的作答 ---------------- */

  // 草稿只记录「恢复这一节所需的最小状态」，与最终记录分开存放。
  function draftSnapshot() {
    if (!runtime.session || runtime.saved) return null;
    const task = currentTask();
    return {
      sessionId: runtime.session.sessionId,
      session: runtime.session,
      studyMode: runtime.studyMode,
      selectedSubject: runtime.selectedSubject,
      queue: runtime.queue,
      modeSourceTasks: runtime.modeSourceTasks,
      queueIndex: runtime.queueIndex,
      scheduledRetests: runtime.scheduledRetests,
      attempt: runtime.attempt,
      supportMode: runtime.supportMode,
      activeHint: runtime.activeHint,
      compositionBoard: runtime.compositionBoard,
      taskElapsedMs: Math.max(0, runtime.taskElapsedMs + (runtime.taskShownAt ? Date.now() - runtime.taskShownAt : 0)),
      answerLocked: runtime.answerLocked,
      paused: runtime.paused,
      pausedAtTaskId: task?.taskId || null,
      mathStage: runtime.mathStage
    };
  }

  let draftWriteChain = Promise.resolve();

  // 串行写入，避免连续快速作答时后写的草稿被先写的覆盖。
  function persistDraft() {
    const snapshot = draftSnapshot();
    if (!snapshot) return draftWriteChain;
    draftWriteChain = draftWriteChain
      .then(() => putDraft(snapshot))
      .catch(() => { /* 草稿写入失败不阻塞作答；最终记录仍会在结束时尝试保存。 */ });
    return draftWriteChain;
  }

  function clearDraft() {
    const sessionId = runtime.session?.sessionId;
    if (!sessionId) return;
    draftWriteChain = draftWriteChain
      .then(() => deleteDraft(sessionId))
      .catch(() => { /* 清理失败不影响流程。 */ });
  }

  // 启动时检查是否有未完成的一节（例如上次直接关掉了页面）。
  async function findResumableDraft() {
    try {
      const draft = await latestDraft();
      if (!draft?.session) return null;
      if (!Array.isArray(draft.session.events) || draft.session.events.length === 0) {
        await deleteDraft(draft.sessionId);
        return null;
      }
      return draft;
    } catch {
      return null;
    }
  }

  function restoreDraft(draft) {
    runtime.session = draft.session;
    runtime.studyMode = draft.studyMode || "lesson";
    runtime.selectedSubject = draft.selectedSubject || runtime.selectedSubject;
    runtime.queue = Array.isArray(draft.queue) ? draft.queue : [];
    runtime.modeSourceTasks = Array.isArray(draft.modeSourceTasks) ? draft.modeSourceTasks : [];
    runtime.queueIndex = Number.isInteger(draft.queueIndex) ? draft.queueIndex : 0;
    runtime.scheduledRetests = Array.isArray(draft.scheduledRetests) ? draft.scheduledRetests : [];
    // 恢复中断时刻的作答状态：attempt / supportMode / activeHint / 分合盘 / 锁定 / 计时。
    runtime.attempt = Number.isInteger(draft.attempt) && draft.attempt > 0 ? draft.attempt : 1;
    runtime.supportMode = draft.supportMode || null;
    runtime.activeHint = draft.activeHint || "";
    runtime.compositionBoard = draft.compositionBoard || null;
    runtime.taskElapsedMs = Number.isFinite(draft.taskElapsedMs) ? draft.taskElapsedMs : 0;
    runtime.answerLocked = Boolean(draft.answerLocked);
    runtime.paused = true;
    runtime.saved = false;
    runtime.saveFailed = false;
    runtime.sessionEnding = false;
    runtime.feedbackActive = false;
    runtime.feedbackAdvancePending = false;
    if (Number.isInteger(draft.mathStage)) runtime.mathStage = draft.mathStage;
    // 恢复后仍处于「暂停」态，由孩子主动选择继续或结束，避免回到首页时状态含糊。
    return draft;
  }

  /* ---------------- 视图 ---------------- */

  function renderHome() {
    runtime.view = "home";
    root.innerHTML = `
      <main class="welcome">
        <div class="welcome-sun">☀</div>
        <header class="welcome-brand"><div class="brand-mark">芽</div><div><h1>小芽家庭学习</h1><p>每天一点点，知识发新芽</p></div></header>
        <section class="welcome-copy"><h2>你好呀，<br><em>准备开始了吗？</em></h2><p>选一个入口，我们一起度过轻松的学习时光。</p></section>
        <section class="entry-stack">
          <button class="entry-card child" data-action="child-home"><span class="entry-art">🌱</span><span class="entry-text"><small>孩子入口</small><strong>开始学习</strong><i>汉字 · 英语 · 数学</i></span><b>→</b></button>
          <button class="entry-card parent" data-action="parent-home"><span class="entry-art">📊</span><span class="entry-text"><small>家长入口</small><strong>家长管理</strong><i>上传记录 · 更新课程</i></span><b>→</b></button>
        </section>
        <footer class="welcome-footer">本地保存 · 可离线学习 · 家庭专用</footer>
      </main>`;
  }

  function renderChildHome() {
    runtime.view = "child-home";
    const s = summary();
    const paused = hasPaused();
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="home" aria-label="返回首页">←</button>
          <div class="topbar-title"><h1>今天想学什么？</h1><p>选一个学科，开始新的探索</p></div>
        </header>
        ${paused ? pausedBanner() : ""}
        <section class="subject-stack">
          <button class="subject-card hanzi" data-subject="hanzi"><span class="subject-icon">字</span><span class="subject-text"><small>认识中国字</small><strong>汉字学习</strong><i>课程共 ${s.hanziTotal || 1000} 个汉字</i></span><b>开始 →</b></button>
          <button class="subject-card english" data-subject="english_letter"><span class="subject-icon">Aa</span><span class="subject-text"><small>认识英文字母</small><strong>英语字母学习</strong><i>课程共 ${s.letterTotal || 26} 个字母</i></span><b>开始 →</b></button>
          <button class="subject-card math" data-subject="math"><span class="subject-icon">123</span><span class="subject-text"><small>数感优先，逐步进入运算</small><strong>数学学习</strong><i>课程共 ${s.mathTotal || 35} 项</i></span><b>开始 →</b></button>
        </section>
        <section class="tip-card"><span>💡</span><div><strong>小芽提醒</strong><p>每天学习 10 分钟就很好，专注比时间更重要。</p></div></section>
        <button class="text-back" data-action="parent-home">家长管理：查看掌握情况 · 上传记录</button>
      </main>`;
  }

  function renderSubject() {
    runtime.view = "subject";
    const subject = runtime.selectedSubject;
    if (subject === "math") return renderMathSubject();
    const isHanzi = subject === "hanzi";
    const lessonErrors = validateLesson(lesson());
    const ready = Boolean(lesson()) && lessonErrors.length === 0;
    const paused = hasPaused();
    const modes = [
      ["lesson", "今日课程", "按计划完成新学与复习", "🌿"],
      ["preview", "轻松预习", "预习下一课前 4 个新内容", "👀"],
      ["practice", "巩固练习", "练习上一次课程新学的内容", "✏️"],
      ["test", "小小测试", "看看已经记住多少", "🏅"]
    ];
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="${paused ? "paused-nav" : "child-home"}" aria-label="返回">←</button>
          <div class="topbar-title"><h1>${isHanzi ? "汉字学习" : "英语学习"}</h1><p>${escapeHtml(lesson()?.title || "等待下一课")}</p></div>
        </header>
        ${paused ? pausedBanner() : ""}
        ${ready ? "" : `<div class="notice warn">这个科目的课程暂时还没准备好，请让家长在家长管理中更新课程。</div>`}
        <section class="mode-stack">${modes.map(([key, name, detail, emoji]) => {
          const tasks = key === "test" ? [] : modeTasks(key, subject);
          const count = key === "test" ? testItems("all").length : tasks.length;
          const available = key === "test" ? count > 0 : ready && count > 0;
          const itemCount = new Set(tasks.map(task => task.target?.ref).filter(Boolean)).size;
          // 小测试的范围来自「本机真实作答记录」（公开课程包不再携带家庭进度），
          // 所以没有记录时要直接说明原因，而不是只写「暂无内容」让人以为是故障。
          const countLabel = key === "test" && !count ? "先完成一节课程"
            : !count ? "暂无内容"
              : key === "test" ? `已学 ${learningItemLabel(subject, count)}`
                : key === "lesson" ? `${count} 道题 · ${learningItemLabel(subject, itemCount)}`
                  : key === "preview" ? `${itemCount} 个预习内容`
                    : `${itemCount} 个上次新学内容`;
          return `<button class="mode-card" data-mode="${key}" ${available && !paused ? "" : "disabled"}><span>${emoji}</span><span class="mode-text"><strong>${name}</strong><p>${detail}</p><i>${countLabel}</i></span></button>`;
        }).join("")}</section>
        ${testItems("all").length ? "" : `<p class="hint-text">小测试按这台手机的真实作答记录出题。先完成一节“今日课程”，或者请家长在家长管理里点“更新学习课程”，把家里已经学过的内容同步到这台手机。</p>`}
        <button class="text-back" data-action="${paused ? "paused-nav" : "child-home"}">换一个学科</button>
      </main>`;
  }

  function renderMathSubject() {
    const catalogMath = catalog().math || [];
    const stageProgress = mathStageProgress(catalogMath);
    const activeStage = runtime.mathStage;
    const currentStage = stageProgress.find(stage => stage.stage === activeStage);
    const lessonValue = mathLesson();
    const lessonErrors = validateLesson(lessonValue);
    const lessonReady = Boolean(lessonValue?.tasks?.length) && lessonErrors.length === 0;
    const practiceTasks = modeTasks("practice", "math");
    const learnedCount = testItems("all").length;
    const paused = hasPaused();
    const modes = [
      ["lesson", "今日数学", "练习选中的阶段，每次换一组题", "🔢", lessonValue?.tasks?.length || 0],
      ["practice", "巩固练习", "优先练习薄弱和易错内容", "🧩", practiceTasks.length],
      ["test", "小小测试", "从已经学过的数学目标中抽题", "🏅", learnedCount]
    ];
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="${paused ? "paused-nav" : "child-home"}" aria-label="返回">←</button>
          <div class="topbar-title"><h1>数学学习</h1><p>第 ${activeStage} / 6 阶段</p></div>
        </header>
        ${paused ? pausedBanner() : ""}
        <section class="math-hero"><span>🔢</span><div><small>当前学习阶段</small><h2>${escapeHtml(currentStage?.title || "数字与数量 0～5")}</h2><p>${escapeHtml(currentStage?.detail || "")}</p></div></section>
        <section class="mode-stack">${modes.map(([key, name, detail, emoji, count]) => `
          <button class="mode-card" data-mode="${key}" ${(key === "lesson" ? lessonReady : count > 0) && !paused ? "" : "disabled"}><span>${emoji}</span><span class="mode-text"><strong>${name}</strong><p>${detail}</p><i>${count ? `${count} 道题` : key === "test" ? "先完成一节数学课" : "完成学习后开放"}</i></span></button>`).join("")}
        </section>
        ${learnedCount ? "" : `<p class="hint-text">小小测试按这台手机的真实作答记录出题。先完成一节“今日数学”，或者请家长在家长管理里点“更新学习课程”，把家里已经学过的内容同步到这台手机。</p>`}
        <h3 class="section-title">选择阶段</h3>
        <section class="stage-grid">${stageProgress.map(stage => `
          <button class="stage-card ${stage.stage === activeStage ? "current" : ""}" data-math-stage="${stage.stage}" ${paused ? "disabled" : ""}>
            <b>${stage.stage}</b><strong>${escapeHtml(stage.title)}</strong>
            <div class="stage-bar"><span style="width:${stage.total ? Math.round(stage.ready / stage.total * 100) : 0}%"></span></div>
            <i>${stage.learned} / ${stage.total} 项已接触</i>
          </button>`).join("")}
        </section>
        <button class="text-back" data-action="${paused ? "paused-nav" : "child-home"}">换一个学科</button>
      </main>`;
  }

  function pausedBanner() {
    return `<section class="paused-banner"><span>⏸</span><div><strong>本次学习已暂停</strong><p>停在第 ${runtime.queueIndex + 1} 题，作答进度仍然保留。</p></div>
      <div class="paused-actions"><button class="button primary" data-action="resume-lesson">继续学习</button><button class="button secondary" data-action="end-paused">结束本次</button></div></section>`;
  }

  function renderTestSetup() {
    runtime.view = "test-setup";
    // 手机上输入数字时，任何一次重绘都必须把焦点和光标交还给同一个输入框，
    // 否则软键盘会被收起、刚输入的数字也会消失。
    const focusSnapshot = captureFocus(root, testInputSelector);
    if (!testItems(runtime.testScope).length) {
      runtime.testScope = ["today", "two_days", "three_days", "all"].find(scope => testItems(scope).length) || "today";
    }
    const subject = runtime.selectedSubject;
    const isHanzi = subject === "hanzi";
    const title = isHanzi ? "汉字小测试" : subject === "math" ? "数学小测试" : "英语小测试";
    const scopes = [
      ["today", "今天", "只测今天学过的内容", "☀️"],
      ["two_days", "近 2 天", "把昨天的内容也带上", "🌱"],
      ["three_days", "近 3 天", "做一次短期巩固", "🌿"],
      ["all", "全部内容", "从所有已学内容中出题", "🏆"]
    ];
    const selectedItems = testItems();
    const learnedAll = testItems("all");
    runtime.testQuestionCount = normalizeTestQuestionCount(runtime.testQuestionCount, learnedAll.length);
    runtime.testWeights = normalizeDifficultyWeights(runtime.testWeights);
    const weightTotal = Object.values(runtime.testWeights).reduce((sum, value) => sum + value, 0);
    const plan = allocateDifficultyCounts(learnedAll, runtime.testQuestionCount, runtime.testWeights);
    const questionCount = runtime.testScope === "weighted" ? plan.questionCount : selectedItems.length;
    runtime.hanziOralReadingPercent = normalizeHanziOralReadingPercent(runtime.hanziOralReadingPercent);
    const mix = allocateHanziQuestionMix(questionCount, runtime.hanziOralReadingPercent);
    const canStart = questionCount > 0 && (runtime.testScope !== "weighted" || weightTotal === 100);
    const label = runtime.testScope === "custom" ? `近 ${runtime.customTestDays} 天内容` : TEST_SCOPE_LABELS[runtime.testScope] || "";
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="subject-home" aria-label="返回">←</button>
          <div class="topbar-title"><h1>${title}</h1><p>从正式学习记录中自动出题</p></div>
        </header>
        <section class="test-hero"><div><small>先选范围，再开始</small><h2>今天想挑战多少内容？</h2></div><b>${questionCount}<small>题</small></b></section>
        <section class="scope-grid">${scopes.map(([scope, name, detail, emoji]) => {
          const count = testItems(scope).length;
          return `<button class="scope-card ${runtime.testScope === scope ? "selected" : ""}" data-test-scope="${scope}" ${count ? "" : "disabled"}>
            <span>${emoji}</span><div><strong>${name}</strong><p>${detail}</p></div><i>${count ? `${count} 题` : "暂无记录"}</i></button>`;
        }).join("")}</section>
        <section class="custom-range">
          <div><strong>自定义最近天数</strong><p>输入 1～30 天，周末集中复习时很有用。</p></div>
          <label>最近 <input type="number" min="1" max="30" value="${runtime.customTestDays}" data-custom-test-days> 天</label>
          <button class="button secondary" data-action="start-custom-test">按这个范围开始</button>
        </section>
        ${isHanzi ? `<section class="mix-card">
          <div><strong>选择题与自己读的比例</strong><p>“自己读”只显示汉字、不播出答案，由家长根据孩子实际读音记录对错。</p></div>
          <div class="mix-values"><div><small>选择题</small><strong>${100 - mix.oralReadingPercent}%</strong></div><div><small>自己读</small><strong>${mix.oralReadingPercent}%</strong></div></div>
          <input type="range" min="0" max="100" step="10" value="${mix.oralReadingPercent}" data-hanzi-reading-percent aria-label="孩子自己读的比例">
          <div class="mix-actual">按本次题量：选择题 ${mix.choiceCount} 题 · 自己读 ${mix.oralReadingCount} 题</div>
        </section>` : ""}
        <section class="weight-card ${runtime.testScope === "weighted" ? "selected" : ""}">
          <div class="weight-head"><div><strong>自定义题量和难度占比</strong><p>从全部已学内容随机抽题，某档不足会自动补足。</p></div><button class="chip" data-test-scope="weighted">${runtime.testScope === "weighted" ? "已选择" : "选这个"}</button></div>
          <label class="count-row">这次抽 <input type="number" min="1" max="${Math.max(1, learnedAll.length)}" value="${runtime.testQuestionCount}" data-test-question-count> 题</label>
          <div class="weight-grid">${DIFFICULTY_BUCKETS.map(({ key, label: bucketLabel, detail }) => `
            <div class="weight-item"><strong>${bucketLabel}</strong><small>${detail}</small>
            <label><input type="number" min="0" max="100" step="5" value="${runtime.testWeights[key]}" data-difficulty-weight="${key}"> %</label>
            <small>可抽 ${plan.availability[key]} 项 · 预计 ${plan.actualCounts[key]} 题</small></div>`).join("")}
          </div>
          <div class="weight-total ${weightTotal === 100 ? "" : "invalid"}">占比合计 ${weightTotal}%${weightTotal === 100 ? "" : "，请调整到正好 100%"}</div>
        </section>
        <button class="button primary big" data-action="start-selected-test" ${canStart ? "" : "disabled"}>开始测试 →</button>
        <p class="hint-text">当前选择：${escapeHtml(label)}</p>
      </main>`;
    restoreFocus(root, focusSnapshot);
  }

  // resumeTaskId：恢复中断的同一题时必须传当前 taskId，此时保留 attempt / supportMode /
  // activeHint / 分合盘 / 计时与锁定状态；展示新题时才重置。
  function renderTask(resumeTaskId = null) {
    runtime.view = "task";
    cancelSpeech();
    const task = currentTask();
    if (!task) return finishSession(true, "completed");
    const resuming = resumeTaskId !== null && resumeTaskId === task.taskId;
    if (!resuming) {
      runtime.taskElapsedMs = 0;
      runtime.attempt = 1;
      runtime.supportMode = null;
      runtime.activeHint = "";
      runtime.compositionBoard = createCompositionBoard(task);
      runtime.answerLocked = false;
      runtime.paused = false;
      runtime.taskShownAt = Date.now();
    } else {
      // 恢复：仅重置「本题计时窗口」的起点，累计已用时间已在 taskElapsedMs 中。
      runtime.taskShownAt = Date.now();
      if (!runtime.compositionBoard) runtime.compositionBoard = createCompositionBoard(task);
    }

    const progress = Math.min(100, ((runtime.queueIndex + 1) / runtime.queue.length) * 100);
    const isLetter = task.subject === "english_letter";
    const isMath = task.subject === "math";
    const isOral = task.evidenceType === "hanzi_oral_reading" || task.evidenceType === "math_digit_reading";
    const correctLabel = isOral ? "读对了" : "答对了";
    const wrongLabel = isOral ? "暂时没读对" : "没答对";
    const modeLabel = { lesson: "今日课程", preview: "轻松预习", practice: "巩固练习", test: "小小测试" }[runtime.studyMode];
    const choicesDisabled = runtime.answerLocked;
    // 恢复提示态时，把已经给出过的提示原样呈现，不重新当作首次展示。
    const supportVisible = Boolean(runtime.supportMode);
    const boardPhase = runtime.compositionBoard?.phase;

    root.innerHTML = `
      <main class="lesson">
        <header class="lesson-top">
          <button class="icon-button" data-action="lesson-back" aria-label="返回">←</button>
          <div class="lesson-progress"><span>第 ${runtime.queueIndex + 1} / ${runtime.queue.length} 题</span><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>
        </header>
        <div class="task-tag">${subjectName(task.subject)} · ${modeLabel}${task.isRetest ? " · 稍后再试" : ""}</div>
        <section class="stage">
          <div class="prompt">${escapeHtml(task.prompt)}</div>
          ${task.visualPrompt ? `<div class="visual ${isMath ? "" : "compact"}">${escapeHtml(task.visualPrompt)}</div>` : ""}
          ${isCompositionModel(task) ? compositionBoardHtml(task) : ""}
          ${task.questionType === "choice"
            ? `<div id="choice-area">${isCompositionModel(task) && boardPhase !== "answer" ? "" : choicesHtml(task, choicesDisabled)}</div>`
            : `${task.visualPrompt ? "" : `<div class="glyph ${isLetter ? "letter" : ""}">${escapeHtml(task.target.display)}</div>`}
               <div class="context">${escapeHtml(task.context || "认真看一看，再说出来。")}</div>
               <div class="answer-row">
                 <button class="button primary big" data-answer="correct" ${choicesDisabled ? "disabled" : ""}>${correctLabel}</button>
                 <button class="button danger big" data-answer="wrong" ${choicesDisabled ? "disabled" : ""}>${wrongLabel}</button>
               </div>`}
          <div id="support">${supportVisible ? supportHtml(task) : ""}</div>
        </section>
        <footer class="lesson-bottom">
          <button class="voice-button" data-action="repeat-question">🔊 再听一次题目</button>
          <button class="button secondary" data-action="stop">今天先到这里</button>
        </footer>
      </main>`;

    if (runtime.answerLocked && !supportVisible) {
      document.querySelectorAll("[data-choice], [data-answer]").forEach(node => { node.disabled = true; });
    }

    const spokenTaskId = task.taskId;
    clearTimeout(runtime.questionTimer);
    // 恢复提示/示范态时不再自动朗读题目，避免覆盖已经给出的引导语音。
    if (supportVisible) return;
    runtime.questionTimer = window.setTimeout(() => {
      if (!runtime.feedbackActive && !runtime.paused && !runtime.sessionEnding && currentTask()?.taskId === spokenTaskId) {
        const text = runtime.supportMode === "hint"
          ? hintSpeechText(task, runtime.activeHint || taskHint(task))
          : runtime.supportMode === "demo" ? demonstrationSpeechText(task)
            : isCompositionModel(task)
              ? compositionInstructions(task.composition)[runtime.compositionBoard?.phase || "left"]
              : questionSpeechText(task);
        speak(text);
      }
    }, 180);
  }

  function choicesHtml(task, disabled = false) {
    return `<div class="choices">${task.options.map((option, index) => `
      <button class="choice" data-choice="${escapeHtml(option)}" ${disabled ? "disabled" : ""}>
        <span class="choice-number">${index + 1}</span>
        <span class="choice-value">${escapeHtml(option)}</span>
      </button>`).join("")}</div>`;
  }

  function compositionApples(count) {
    return Array.from({ length: count }, () => "<span aria-hidden=\"true\">🍎</span>").join("");
  }

  function compositionBoardHtml(task) {
    const board = runtime.compositionBoard;
    if (!board || !isCompositionModel(task)) return "";
    const instruction = compositionInstructions(task.composition)[board.phase];
    const joined = board.phase === "answer";
    const remaining = joined ? board.whole : board.whole - board.left - board.right;
    return `<div class="composition-board">
      <div class="composition-instruction">${escapeHtml(instruction)}</div>
      ${board.phase === "join" ? "" : `<div class="tray"><strong>${joined ? "合起来" : "原来有"}</strong><div class="apples">${compositionApples(remaining)}</div></div>`}
      ${joined ? `<button class="chip" data-composition="restart">↺ 再摆一次</button>` : `
        <div class="bowls">
          <button class="bowl" data-composition="left" ${board.phase === "left" ? "" : "disabled"}><strong>左边盘子</strong><div class="apples">${compositionApples(board.left)}</div></button>
          <button class="bowl" data-composition="right" ${board.phase === "right" ? "" : "disabled"}><strong>右边盘子</strong><div class="apples">${compositionApples(board.right)}</div></button>
        </div>
        ${board.phase === "join" ? `<button class="button warm" data-composition="join">合起来，再数一数</button>` : ""}`}
    </div>`;
  }

  function supportHtml(task) {
    if (runtime.supportMode === "hint") {
      return `<div class="hint-panel"><span>💡 小线索</span><strong>${escapeHtml(runtime.activeHint || taskHint(task))}</strong><button class="voice-button" data-action="repeat-hint">🔊 再听一次</button></div>`;
    }
    if (runtime.supportMode === "demo") {
      return `<div class="demo-panel"><span>🔊 跟我说一次</span><strong>${escapeHtml(demonstrationSpeechText(task))}</strong></div>
        <div class="answer-row"><button class="button warm big" data-action="continue">跟读后继续</button><button class="voice-button" data-action="repeat-demo">再听一次</button></div>`;
    }
    return "";
  }

  /* ---------------- 作答 ---------------- */

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
    // 每次作答立即落盘草稿：刷新或关闭页面后仍能恢复这一节。
    persistDraft();
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
        isRetest: true
      }
    });
  }

  function insertDueRetest() {
    const dueIndex = runtime.scheduledRetests.findIndex(item => item.dueAfter <= runtime.queueIndex);
    if (dueIndex < 0) return;
    const [due] = runtime.scheduledRetests.splice(dueIndex, 1);
    runtime.queue.splice(runtime.queueIndex, 0, due.task);
  }

  async function showFeedback(title, detail, voiceText, followUp, onDone) {
    cancelFeedback();
    const token = runtime.feedbackToken;
    const stillCurrent = () => token === runtime.feedbackToken && !runtime.paused && !runtime.sessionEnding;
    runtime.feedbackActive = true;
    runtime.feedbackAdvancePending = true;
    document.querySelectorAll("[data-answer], [data-choice]").forEach(node => { node.disabled = true; });
    document.querySelector(".stage")?.insertAdjacentHTML("beforeend", `
      <div class="feedback" role="status"><div class="feedback-card"><div class="feedback-mark">👍</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>
      <button class="button primary big" data-action="next-feedback">下一题 →</button></div></div>`);
    const minimum = new Promise(resolve => {
      runtime.feedbackTimer = window.setTimeout(resolve, 1300);
    });
    await Promise.all([speak(voiceText), minimum]);
    if (!stillCurrent()) return;
    if (followUp) {
      const heading = document.querySelector(".feedback h2");
      const paragraph = document.querySelector(".feedback p");
      if (heading) heading.textContent = "一起记一记";
      if (paragraph) paragraph.textContent = followUp;
      await speak(followUp);
    }
    if (!stillCurrent()) return;
    runtime.feedbackActive = false;
    runtime.feedbackAdvancePending = false;
    onDone();
  }

  function cancelFeedback() {
    runtime.feedbackToken += 1;
    clearTimeout(runtime.feedbackTimer);
    runtime.feedbackActive = false;
  }

  function answer(isCorrect, childAnswer = null) {
    if (runtime.answerLocked || runtime.paused || runtime.saved || runtime.sessionEnding || !document.querySelector(".stage")) return;
    const task = currentTask();
    if (isCompositionModel(task) && runtime.compositionBoard?.phase !== "answer") return;
    cancelSpeech();
    if (isCorrect) {
      runtime.answerLocked = true;
      recordEvent("correct", { childAnswer, correctAnswer: task.correctAnswer || task.target.display });
      const independent = runtime.attempt === 1;
      showFeedback(
        independent ? "真棒，答对了！" : "太好了，找到了！",
        task.composition ? `${task.composition.whole}＝${task.composition.left}＋${task.correctAnswer}` : `答案是“${task.correctAnswer || task.target.display}”`,
        independent ? "真棒，答对了！" : "太好了，这次答对了！",
        independent ? reinforcementSpeechText(task, runtime.studyMode) : "",
        advance
      );
      return;
    }
    recordEvent("incorrect", { childAnswer, correctAnswer: task.correctAnswer || task.target.display });
    scheduleRetest(task);
    const support = document.querySelector("#support");
    if (runtime.attempt === 1) {
      recordEvent("hint_shown", { independent: false });
      runtime.supportMode = "hint";
      runtime.activeHint = taskHint(task, childAnswer);
      if (support) support.innerHTML = supportHtml(task);
      support?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      speak(hintSpeechText(task, runtime.activeHint));
      runtime.attempt = 2;
      runtime.taskElapsedMs = 0;
      runtime.taskShownAt = Date.now();
      // 支持状态变更后再落盘，确保草稿记录的是「已进入提示态、attempt=2」。
      persistDraft();
      return;
    }
    recordEvent("demonstrated", { independent: false });
    runtime.supportMode = "demo";
    runtime.answerLocked = true;
    if (support) support.innerHTML = supportHtml(task);
    support?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    speak(demonstrationSpeechText(task));
    document.querySelectorAll("[data-answer], [data-choice]").forEach(node => { node.disabled = true; });
    persistDraft();
  }

  function updateComposition(action) {
    const task = currentTask();
    if (!isCompositionModel(task) || runtime.answerLocked || runtime.feedbackActive || runtime.paused || runtime.saved || runtime.sessionEnding) return;
    const before = runtime.compositionBoard;
    const after = moveCompositionBoard(before, action);
    if (after === before) return;
    runtime.compositionBoard = after;
    const boardNode = document.querySelector(".composition-board");
    if (boardNode) boardNode.outerHTML = compositionBoardHtml(task);
    const choices = document.querySelector("#choice-area");
    if (choices) choices.innerHTML = after.phase === "answer" ? choicesHtml(task) : "";
    if (after.phase !== before.phase) {
      speak(compositionInstructions(task.composition)[after.phase]);
    }
    persistDraft();
  }

  function advance() {
    if (runtime.paused || runtime.sessionEnding || runtime.saved) return;
    cancelFeedback();
    runtime.feedbackAdvancePending = false;
    runtime.queueIndex += 1;
    insertDueRetest();
    renderTask();
    persistDraft();
  }

  function pauseLesson() {
    cancelFeedback();
    if (!runtime.session || runtime.saved) return renderSubject();
    if (runtime.session.events.length === 0) {
      clearDraft();
      runtime.session = null;
      runtime.queue = [];
      runtime.scheduledRetests = [];
      runtime.supportMode = null;
      runtime.paused = false;
      return renderSubject();
    }
    runtime.taskElapsedMs += Math.max(0, Date.now() - runtime.taskShownAt);
    runtime.paused = true;
    // 暂停即落盘：关掉页面也不会丢已发生的作答与当前题状态。
    persistDraft();
    renderSubject();
  }

  function resumeLesson() {
    if (!hasPaused()) return;
    runtime.paused = false;
    if (runtime.feedbackAdvancePending) advance();
    else renderTask(currentTask()?.taskId || null);
    persistDraft();
  }

  async function stopLesson() {
    cancelFeedback();
    if (!runtime.session?.events?.length) {
      clearDraft();
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
    cancelSpeech();
    runtime.sessionEnding = true;
    runtime.answerLocked = true;
    runtime.paused = false;
    runtime.session.endedAt ||= new Date().toISOString();
    runtime.session.completed = completed;
    runtime.session.stopReason = stopReason;
    runtime.session.lessonTaskCount = runtime.modeSourceTasks.length;
    runtime.session.executedTaskCount = new Set(runtime.session.events.map(event => event.taskId)).size;
    runtime.session.lessonProtocol = "FAMILY_LEARNING_LESSON_V1";
    runtime.session.lessonTitle = runtime.session.lessonTitle || "";
    root.innerHTML = `<main class="boot"><div class="boot-mark">芽</div><p>正在保存本节作答记录…</p></main>`;
    try {
      const [code, device] = await Promise.all([studentCode(), deviceCode()]);
      const payloadSha256 = await sha256Hex(runtime.session);
      await putSession({
        sessionId: runtime.session.sessionId,
        studentCode: code,
        deviceCode: device,
        platform: detectPlatform(),
        startedAt: runtime.session.startedAt,
        endedAt: runtime.session.endedAt,
        uploaded: false,
        uploadedAt: null,
        payload: runtime.session,
        payloadSha256
      });
      runtime.saved = true;
      // 最终记录已落盘，草稿完成使命，删除以免下次误恢复。
      clearDraft();
      // 刚答过的内容要立刻反映到目录里：否则本节结束后点“小测试”仍然显示「暂无记录」。
      await refreshObservedCatalog();
      await appendLog({ type: "session", action: "save", sessionId: runtime.session.sessionId, events: runtime.session.events.length });
      const count = runtime.session.events.length;
      onSessionSaved?.(runtime.session);
      root.innerHTML = `
        <main class="shell">
          <section class="done-card">
            <div class="done-mark">🌱</div>
            <small>本节已保存在这台手机上</small>
            <h2>${completed && runtime.studyMode === "test" ? `全部 ${runtime.modeSourceTasks.length} 题完成啦` : completed ? "今天的学习完成啦" : "今天就学到这里"}</h2>
            <p>原始作答已经写入手机本地，不会被自动改写。记录还会保留到家长点击“上传学习记录”为止。</p>
            <div class="pill-row"><span class="pill">${count} 条作答记录</span><span class="pill">未直接改写正式进度</span></div>
            <button class="button primary big" data-action="home">回到首页</button>
            <button class="button secondary" data-action="parent-home">去家长管理上传记录</button>
          </section>
        </main>`;
    } catch (error) {
      runtime.saved = false;
      root.innerHTML = `<main class="shell"><section class="done-card"><h2>保存失败</h2><p>${escapeHtml(error.message)}</p>
        <button class="button primary big" data-action="retry-save">重试保存</button></section></main>`;
    }
  }

  function startLesson(mode = "lesson") {
    if (hasPaused()) return toast("请先继续或结束当前学习");
    if (mode === "test") return renderTestSetup();
    const activeLesson = runtime.selectedSubject === "math" ? mathLesson() : lesson();
    const errors = validateLesson(activeLesson);
    if (errors.length) return toast("课程暂时不可执行：" + errors[0]);
    const selected = modeTasks(mode, runtime.selectedSubject);
    if (!selected.length) return toast("这个学习方式暂时没有可用内容");
    beginLesson(mode, activeLesson, selected, false);
  }

  function beginLesson(mode, activeLesson, selected, isTest) {
    runtime.studyMode = mode;
    runtime.queue = structuredClone(selected);
    runtime.modeSourceTasks = structuredClone(selected);
    runtime.queueIndex = 0;
    runtime.session = newSession(activeLesson);
    runtime.session.lessonTitle = activeLesson.title;
    runtime.session.activityMode = mode;
    runtime.session.lessonProtocol = activeLesson.protocol;
    runtime.session.lessonTaskCount = selected.length;
    runtime.session.plannedNewHanziRefs = mode === "lesson" ? [...new Set(selected.filter(t => t.subject === "hanzi" && t.isNew).map(t => t.target.ref))] : [];
    runtime.session.plannedNewLetterRefs = mode === "lesson" ? [...new Set(selected.filter(t => t.subject === "english_letter" && t.isNew).map(t => t.target.ref))] : [];
    runtime.session.plannedNewMathRefs = mode === "lesson" ? [...new Set(selected.filter(t => t.subject === "math" && t.isNew).map(t => t.target.ref))] : [];
    runtime.session.plannedNextPreviewHanziRefs = mode === "lesson" ? [...new Set(activeLesson?.metadata?.nextPreviewHanziRefs || [])] : [];
    runtime.scheduledRetests = [];
    runtime.supportMode = null;
    runtime.feedbackActive = false;
    runtime.paused = false;
    runtime.saved = false;
    runtime.sessionEnding = false;
    runtime.feedbackAdvancePending = false;
    renderTask();
    persistDraft();
  }

  function startTest(scope = runtime.testScope, customDays = runtime.customTestDays) {
    if (hasPaused()) return toast("请先继续或结束当前学习");
    const days = normalizeTestDays(customDays);
    let selected = testItems(scope, days);
    if (!selected.length) return toast("这个范围内还没有学过的内容");
    let difficultyPlan = null;
    if (scope === "weighted") {
      const weightTotal = Object.values(runtime.testWeights).reduce((sum, value) => sum + value, 0);
      if (weightTotal !== 100) return toast(`四档占比当前合计 ${weightTotal}%，请调整为 100%`);
      const localSample = sampleTestItemsByDifficulty(selected, runtime.testQuestionCount, runtime.testWeights);
      selected = localSample.items;
      difficultyPlan = { weights: localSample.weights, availability: localSample.availability, requestedCounts: localSample.requestedCounts, actualCounts: localSample.actualCounts };
    }
    const testLessons = buildTestLessons(
      runtime.selectedSubject, selected, catalog(), scope, days, new Date(), Math.random,
      { difficultyPlan, hanziOralReadingPercent: runtime.selectedSubject === "hanzi" ? runtime.hanziOralReadingPercent : 0 }
    );
    const errors = testLessons.flatMap(validateLesson);
    if (errors.length) return toast("测试暂时无法开始：" + errors[0]);
    runtime.testScope = scope;
    runtime.customTestDays = days;
    beginLesson("test", testLessons[0], testLessons[0].tasks, true);
  }

  async function refreshData(pkg) {
    runtime.pkg = pkg;
    await refreshObservedCatalog();
    if (runtime.view === "home") renderHome();
  }

  /* ---------------- 事件 ---------------- */

  root.addEventListener("click", async event => {
    if (event.target.closest("button:disabled") || event.detail > 1) return;
    // PIN 输入界面由 main.js 接管；此时孩子界面不应响应任何动作。
    if (event.target.closest("[data-pin]")) return;
    const action = event.target.closest("[data-action]")?.dataset.action;
    const answerKind = event.target.closest("[data-answer]")?.dataset.answer;
    const choice = event.target.closest("[data-choice]")?.dataset.choice;
    const subject = event.target.closest("[data-subject]")?.dataset.subject;
    const mode = event.target.closest("[data-mode]")?.dataset.mode;
    const scope = event.target.closest("[data-test-scope]")?.dataset.testScope;
    const stage = event.target.closest("[data-math-stage]")?.dataset.mathStage;
    const composition = event.target.closest("[data-composition]")?.dataset.composition;

    if (composition) { updateComposition(composition); return; }
    if (stage) {
      if (hasPaused()) return toast("请先继续或结束当前学习");
      runtime.mathStage = Number(stage);
      try { localStorage.setItem("xiaoya.math-stage", stage); } catch { /* 本次仍可用。 */ }
      return renderSubject();
    }
    if (answerKind) return answer(answerKind === "correct");
    if (choice != null) return answer(choice === currentTask().correctAnswer, choice);
    if (subject) { runtime.selectedSubject = subject; return renderSubject(); }
    if (mode) return startLesson(mode);
    if (scope) { runtime.testScope = scope; return renderTestSetup(); }

    switch (action) {
      case "home": renderHome(); break;
      case "child-home":
        if (hasPaused()) { renderSubject(); toast("请先继续或结束当前学习"); }
        else renderChildHome();
        break;
      case "parent-home": onNeedParent?.(); break;
      case "subject-home": renderSubject(); break;
      case "lesson-back": pauseLesson(); break;
      case "resume-lesson": resumeLesson(); break;
      case "end-paused": await stopLesson(); break;
      case "paused-nav": toast("请先继续或结束当前学习"); break;
      case "next-feedback": if (runtime.feedbackActive) advance(); break;
      case "repeat-question": {
        const task = currentTask();
        if (!task || runtime.feedbackActive) break;
        speak(isCompositionModel(task) ? compositionInstructions(task.composition)[runtime.compositionBoard?.phase || "left"] : questionSpeechText(task));
        break;
      }
      case "repeat-hint": speak(hintSpeechText(currentTask(), runtime.activeHint || taskHint(currentTask()))); break;
      case "repeat-demo": speak(demonstrationSpeechText(currentTask())); break;
      case "continue": if (runtime.supportMode === "demo") advance(); break;
      case "stop": await stopLesson(); break;
      case "start-selected-test": startTest(); break;
      case "start-custom-test": startTest("custom", document.querySelector("[data-custom-test-days]")?.value); break;
      case "retry-save": await finishSession(runtime.session?.completed, runtime.session?.stopReason); break;
      default: break;
    }
  });

  root.addEventListener("change", event => {
    if (event.target.matches("[data-hanzi-reading-percent]")) {
      runtime.hanziOralReadingPercent = normalizeHanziOralReadingPercent(event.target.value);
      return renderTestSetup();
    }
    if (event.target.matches("[data-test-question-count], [data-difficulty-weight]")) {
      const countInput = document.querySelector("[data-test-question-count]");
      if (countInput) runtime.testQuestionCount = normalizeTestQuestionCount(countInput.value, testItems("all").length);
      const weights = { ...runtime.testWeights };
      document.querySelectorAll("[data-difficulty-weight]").forEach(input => { weights[input.dataset.difficultyWeight] = input.value; });
      runtime.testWeights = normalizeDifficultyWeights(weights);
      runtime.testScope = "weighted";
      return renderTestSetup();
    }
  });

  function setStage(stage) {
    runtime.mathStage = Number(stage) || 6;
  }

  function restoreStage() {
    try {
      const saved = Number(localStorage.getItem("xiaoya.math-stage"));
      runtime.mathStage = saved >= 1 && saved <= 6 && Number.isInteger(saved) ? saved : 6;
    } catch { runtime.mathStage = 6; }
  }

  return {
    renderHome,
    renderChildHome,
    renderSubject,
    renderTestSetup,
    refreshData,
    restoreStage,
    setStage,
    findResumableDraft,
    restoreDraft,
    resumeLesson,
    hasPaused,
    currentView: () => runtime.view,
    runtime
  };
}
