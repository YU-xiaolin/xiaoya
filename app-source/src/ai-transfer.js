import { buildPracticeTasks, buildPreviewTasks, buildTestTasks } from "./test-mode.js";
import { validateLesson } from "./protocol.js";
import { taskHintVariants } from "./targeted-hints.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "./voice-text.js";

const SUBJECTS = ["hanzi", "english_letter"];
const VOICE = "zh-CN-XiaoyiNeural";

export function parseAiResult(text) {
  let bundle;
  try { bundle = JSON.parse(String(text).replace(/^\uFEFF/u, "")); }
  catch { throw new Error("这个文件无法读取。请让 AI 把处理结果保存为完整的 JSON 文件，再选择该文件。"); }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("文件中没有有效的 AI 处理结果，请重新选择 AI 生成的结果文件。");
  }
  return bundle;
}

function seededRandom(seed) {
  let value = 2166136261;
  for (const char of String(seed)) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = Math.imul(value ^ value >>> 15, value | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function copyRefs(refs, catalog, subject, label, maximum) {
  if (!Array.isArray(refs) || refs.length > maximum || new Set(refs).size !== refs.length) {
    throw new Error(`${label}安排不完整，请让 AI 按导出文件中的要求重新生成结果。`);
  }
  const available = new Set((catalog?.[subject] || []).map(item => item.ref));
  if (refs.some(ref => typeof ref !== "string" || !available.has(ref))) {
    throw new Error(`${label}中有软件不认识的学习内容，请重新生成结果。`);
  }
  return [...refs];
}

// The model chooses targets and order; the app owns every classroom sentence.
export function compileAiLesson(bundle, context) {
  const plan = bundle?.lessonPlan;
  const catalog = context?.catalog;
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 20) {
    throw new Error("下一课需要安排 1 到 20 个学习任务，请让 AI 重新生成结果。");
  }
  if (typeof bundle?.exportId !== "string" || !bundle.exportId || !Array.isArray(bundle.basedOnSessionIds)
      || !context?.lessonId || typeof context.generatedAt !== "string" || !Number.isFinite(Date.parse(context.generatedAt))) {
    throw new Error("导入准备没有完成，请重新选择结果文件。");
  }
  const newRefs = { hanzi: new Set(), english_letter: new Set() };
  const tasks = plan.tasks.map((task, index) => {
    if (!SUBJECTS.includes(task?.subject)
        || !["recognition", "choice"].includes(task?.questionType)
        || (task.subject === "english_letter" && task.questionType !== "choice")
        || typeof task.isNew !== "boolean") {
      throw new Error(`第 ${index + 1} 个任务不适用于这份课程。数学仍在软件中单独选课，请让 AI 按文件说明重新安排。`);
    }
    const item = catalog?.[task.subject]?.find(candidate => candidate.ref === task.targetRef);
    if (!item?.display) throw new Error(`第 ${index + 1} 个任务引用了软件不认识的学习内容，请让 AI 重新生成结果。`);
    if (task.isNew) newRefs[task.subject].add(task.targetRef);
    const [compiled] = buildTestTasks(task.subject, [item], catalog,
      seededRandom(`${bundle.exportId}:${index}:${task.subject}:${task.targetRef}`), 1,
      { hanziOralReadingPercent: task.questionType === "recognition" ? 100 : 0 });
    return { ...compiled, taskId: `transfer-${bundle.exportId}-${index + 1}`, isNew: task.isNew };
  });
  if (newRefs.hanzi.size > 6 || newRefs.english_letter.size > 6) {
    throw new Error("一课新汉字或新字母不能超过 6 个，请让 AI 重新安排。");
  }
  const lesson = {
    protocol: "FAMILY_LEARNING_LESSON_V1",
    schemaVersion: 1,
    lessonId: context.lessonId,
    generatedAt: context.generatedAt,
    basedOnSessionIds: [...bundle.basedOnSessionIds],
    isBootstrap: false,
    title: plan.title,
    teacherNote: plan.teacherNote,
    metadata: {
      estimatedMinutes: plan.estimatedMinutes,
      newHanziCount: newRefs.hanzi.size,
      newLetterCount: newRefs.english_letter.size,
      previousNewHanziRefs: copyRefs(plan.previousNewHanziRefs, catalog, "hanzi", "巩固练习", 6),
      nextPreviewHanziRefs: copyRefs(plan.nextPreviewHanziRefs, catalog, "hanzi", "下次预习", 4)
    },
    tasks
  };
  const errors = validateLesson(lesson);
  if (errors.length) throw new Error(`这份课程还不能使用：${errors.join("；")}`);
  return lesson;
}

// Match generate-edge-voice-pack's first-text-wins order and speech profiles.
export function collectAiVoiceRequirements(lesson, catalog) {
  const clips = new Map();
  function add(text, rate, pitch) {
    const normalized = String(text || "").trim();
    if (!normalized || clips.has(normalized)) return;
    clips.set(normalized, { text: normalized, voice: VOICE, rate, pitch, volume: "+0%" });
  }
  function addTask(task, mode) {
    add(questionSpeechText(task), "+14%", "+6Hz");
    add(reinforcementSpeechText(task, mode), "+10%", "+4Hz");
    for (const hint of taskHintVariants(task)) add(hintSpeechText(task, hint), "+12%", "+5Hz");
    add(demonstrationSpeechText(task), "+10%", "+4Hz");
  }
  add("真棒，答对了！", "+18%", "+8Hz");
  add("太好了，这次答对了！", "+16%", "+7Hz");
  for (const task of lesson.tasks) addTask(task, "lesson");
  for (const subject of SUBJECTS) {
    const tasks = lesson.tasks.filter(task => task.subject === subject);
    const previewRefs = subject === "hanzi" ? lesson.metadata.nextPreviewHanziRefs : lesson.metadata.nextPreviewLetterRefs;
    const previousRefs = subject === "hanzi" ? lesson.metadata.previousNewHanziRefs : lesson.metadata.previousNewLetterRefs;
    for (const task of buildPreviewTasks(subject, tasks, catalog, previewRefs, 4)) addTask(task, "preview");
    for (const task of buildPracticeTasks(subject, tasks, catalog, previousRefs, () => 0.25)) addTask(task, "practice");
  }
  return [...clips.values()];
}

export function missingAiVoiceTexts(requirements, manifest) {
  return requirements.filter(required => {
    const clip = manifest?.clips?.[required.text];
    return typeof clip?.fileName !== "string" || !clip.fileName.endsWith(".mp3") || /[\\/]/u.test(clip.fileName)
      || ["voice", "rate", "pitch", "volume"].some(field => clip[field] !== required[field]);
  }).map(required => required.text);
}
