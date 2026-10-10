export const PROTOCOLS = Object.freeze({
  lesson: "FAMILY_LEARNING_LESSON_V1",
  session: "FAMILY_LEARNING_SESSION_V1",
  state: "FAMILY_LEARNING_STATE_V1",
  stateUpdate: "FAMILY_LEARNING_STATE_UPDATE_V1"
});

export const SUBJECTS = Object.freeze(["hanzi", "english_letter", "math"]);
export const QUESTION_TYPES = Object.freeze(["recognition", "choice"]);

const CHILD_FACING_TEXT_FIELDS = Object.freeze([
  "prompt",
  "speechPrompt",
  "context",
  "hint",
  "demonstration",
  "reinforcement"
]);

const THIRD_PERSON_CLASSROOM_PATTERNS = Object.freeze([
  /请孩子/u,
  /让孩子/u,
  /孩子自己/u,
  /听孩子/u,
  /提醒孩子/u,
  /家长/u
]);

export function childFacingAudienceIssue(task) {
  for (const field of CHILD_FACING_TEXT_FIELDS) {
    const text = String(task?.[field] || "").trim();
    if (text && THIRD_PERSON_CLASSROOM_PATTERNS.some(pattern => pattern.test(text))) {
      return { field, text };
    }
  }
  return null;
}

export function choicePromptLeaksAnswer(task) {
  if (task?.questionType !== "choice") return false;
  const prompt = String(task.prompt || "").normalize("NFKC").toLocaleLowerCase();
  const correctAnswer = String(task.correctAnswer || "").normalize("NFKC").trim().toLocaleLowerCase();
  return Boolean(correctAnswer && prompt.includes(correctAnswer));
}

export function validateLesson(lesson) {
  const errors = [];
  if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)) return ["课程文件不是有效对象"];
  if (lesson.protocol !== PROTOCOLS.lesson) errors.push(`protocol 必须为 ${PROTOCOLS.lesson}`);
  if (lesson.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof lesson.lessonId !== "string" || !lesson.lessonId.trim()) errors.push("缺少 lessonId");
  if (!Array.isArray(lesson.tasks)) return [...errors, "tasks 必须是题目数组"];
  if (lesson.tasks.length === 0) errors.push("tasks 至少需要 1 题");
  const isTestLesson = Boolean(lesson.metadata?.testScope);
  if (Array.isArray(lesson.tasks) && lesson.tasks.length > (isTestLesson ? 2000 : 20)) {
    errors.push(isTestLesson ? "单次测试题量超出正式目录上限" : "正常课程最多 20 题");
  }

  const newItems = { hanzi: new Set(), english_letter: new Set(), math: new Set() };
  const taskIds = new Set();
  for (const [index, task] of (lesson.tasks || []).entries()) {
    const label = `第 ${index + 1} 题`;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${label} 必须是有效题目对象`);
      continue;
    }
    if (typeof task.taskId !== "string" || !task.taskId.trim() || taskIds.has(task.taskId)) errors.push(`${label} taskId 缺失或重复`);
    taskIds.add(task.taskId);
    if (!SUBJECTS.includes(task.subject)) errors.push(`${label} subject 仅支持 hanzi、english_letter 或 math`);
    if (!QUESTION_TYPES.includes(task.questionType)) errors.push(`${label} questionType 不受支持`);
    if (typeof task.target?.ref !== "string" || !task.target.ref.trim()
        || typeof task.target?.display !== "string" || !task.target.display.trim()) errors.push(`${label} target.ref/display 缺失`);
    const audienceIssue = childFacingAudienceIssue(task);
    if (audienceIssue) {
      errors.push(`${label} ${audienceIssue.field} 必须直接对孩子说，不能使用“请孩子”或“家长”等旁观口吻`);
    }
    if (task.isNew && SUBJECTS.includes(task.subject)) newItems[task.subject].add(task.target?.ref);
    if (task.questionType === "choice") {
      if (!Array.isArray(task.options) || task.options.length !== 4) errors.push(`${label} 选择题必须恰有 4 个选项`);
      if (Array.isArray(task.options)) {
        const options = task.options.map(option => typeof option === "string" ? option.trim().normalize("NFKC") : "");
        if (options.some(option => !option) || new Set(options).size !== options.length) {
          errors.push(`${label} 选择题选项必须是互不重复的非空文字`);
        }
      }
      if (typeof task.correctAnswer !== "string" || !task.correctAnswer.trim()
          || !Array.isArray(task.options) || !task.options.includes(task.correctAnswer)) errors.push(`${label} correctAnswer 必须出现在 options 中`);
      if (choicePromptLeaksAnswer(task)) errors.push(`${label} 选择题题干不得直接出现正确答案`);
    }
    if (task.composition != null) {
      const whole = task.composition?.whole;
      const left = task.composition?.left;
      if (task.subject !== "math" || task.questionType !== "choice"
          || !["math_visual_model", "math_transfer"].includes(task.evidenceType)
          || !Number.isInteger(whole) || whole < 2 || whole > 5
          || !Number.isInteger(left) || left < 1 || left >= whole
          || task.target?.ref !== `M-COMP-${whole}`
          || task.correctAnswer !== String(whole - left)) {
        errors.push(`${label} 分与合的总数、分组或答案不一致`);
      }
    }
  }
  if (newItems.hanzi.size > 6) errors.push("每课新汉字不得超过 6 个");
  if (newItems.english_letter.size > 6) errors.push("每课新字母不得超过 6 个");
  if (newItems.math.size > 4) errors.push("每课新数学目标不得超过 4 个");
  const metadataRefs = [
    ["previousNewHanziRefs", 6],
    ["nextPreviewHanziRefs", 4]
  ];
  for (const [field, maxItems] of metadataRefs) {
    const refs = lesson.metadata?.[field];
    if (refs == null) continue;
    if (!Array.isArray(refs)) errors.push(`metadata.${field} 必须是数组`);
    else {
      if (refs.length > maxItems) errors.push(`metadata.${field} 最多 ${maxItems} 项`);
      if (new Set(refs).size !== refs.length || refs.some(ref => typeof ref !== "string" || !ref)) {
        errors.push(`metadata.${field} 必须是互不重复的有效编号`);
      }
    }
  }
  return errors;
}

export function newSession(lesson) {
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    protocol: PROTOCOLS.session,
    schemaVersion: 1,
    sessionId: `session-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${suffix}`,
    lessonId: lesson.lessonId,
    basedOnLessonGeneratedAt: lesson.generatedAt,
    startedAt: now,
    endedAt: null,
    completed: false,
    stopReason: null,
    events: []
  };
}
