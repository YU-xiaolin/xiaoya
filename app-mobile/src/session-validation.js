// Validate imported facts before they can affect observed progress or upload.
// These constraints follow FAMILY_LEARNING_SESSION_V1, with evidence checks.
const sessionKeys = new Set("protocol schemaVersion sessionId lessonId lessonTitle lessonProtocol basedOnLessonGeneratedAt activityMode plannedNewHanziRefs plannedNewLetterRefs plannedNewMathRefs plannedNextPreviewHanziRefs startedAt endedAt completed stopReason lessonTaskCount executedTaskCount events".split(" "));
const eventKeys = new Set("eventId recordedAt taskId originalTaskId subject targetRef targetDisplay questionType evidenceType attempt result independent hintUsed responseTimeMs childAnswer correctAnswer".split(" "));
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const date = value => text(value) && !Number.isNaN(Date.parse(value));

export function validateSessionPayload(payload) {
  if (!isObject(payload)) return ["学习记录必须是对象"];
  const errors = [];
  if (payload.protocol !== "FAMILY_LEARNING_SESSION_V1" || payload.schemaVersion !== 1) errors.push("学习记录协议或版本不正确");
  if (!text(payload.sessionId) || !/^[A-Za-z0-9_-]+$/.test(payload.sessionId) || !text(payload.lessonId)) errors.push("学习记录编号不正确");
  if (!date(payload.startedAt) || !date(payload.endedAt) || Date.parse(payload.endedAt) < Date.parse(payload.startedAt)) errors.push("学习记录时间不正确");
  if (typeof payload.completed !== "boolean" || !text(payload.stopReason)) errors.push("学习记录结束状态不完整");
  if (Object.keys(payload).some(key => !sessionKeys.has(key))) errors.push("学习记录含协议之外的字段");
  if (payload.activityMode != null && !["lesson", "preview", "practice", "test"].includes(payload.activityMode)) errors.push("学习方式不正确");
  for (const key of ["lessonTaskCount", "executedTaskCount"]) if (payload[key] != null && (!Number.isInteger(payload[key]) || payload[key] < (key === "lessonTaskCount" ? 1 : 0))) errors.push(`${key} 不正确`);
  for (const [key, maximum] of [["plannedNewHanziRefs", 6], ["plannedNewLetterRefs", 6], ["plannedNewMathRefs", 4], ["plannedNextPreviewHanziRefs", 4]]) {
    const refs = payload[key];
    if (refs != null && (!Array.isArray(refs) || refs.length > maximum || refs.some(ref => !text(ref)) || new Set(refs).size !== refs.length)) errors.push(`${key} 不正确`);
  }
  if (!Array.isArray(payload.events)) return [...errors, "作答事件必须是数组"];
  const ids = new Set();
  for (const event of payload.events) {
    if (!isObject(event)) { errors.push("作答事件必须是对象"); continue; }
    if (!["eventId", "taskId", "targetRef", "targetDisplay"].every(key => text(event[key])) || ids.has(event.eventId)) errors.push("作答事件编号缺失或重复");
    ids.add(event.eventId);
    if (!date(event.recordedAt) || !["hanzi", "english_letter", "math"].includes(event.subject) || !["recognition", "choice"].includes(event.questionType)) errors.push("作答事件时间、科目或题型不正确");
    if (!["correct", "incorrect", "hint_shown", "demonstrated"].includes(event.result) || !Number.isInteger(event.attempt) || event.attempt < 1) errors.push("作答结果或尝试次数不正确");
    if (typeof event.independent !== "boolean" || typeof event.hintUsed !== "boolean" || !Number.isInteger(event.responseTimeMs) || event.responseTimeMs < 0) errors.push("作答证据不完整");
    if (event.independent && (event.result !== "correct" || event.attempt !== 1 || event.hintUsed)) errors.push("提示后或非首次答对不能作为独立正确证据");
    if (Object.keys(event).some(key => !eventKeys.has(key))) errors.push("作答事件含协议之外的字段");
  }
  return [...new Set(errors)];
}
