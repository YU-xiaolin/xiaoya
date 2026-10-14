import { hanziDemonstration, taskHint } from "./targeted-hints.js";
import { naturalSpeechText } from "./natural-hints.js";
import { HANZI_WORDS } from "./hanzi-hints.js";

export function questionSpeechText(task) {
  return String(task?.speechPrompt || task?.prompt || "").trim();
}

export function hintSpeechText(task, hint = taskHint(task)) {
  return naturalSpeechText(hint);
}

function englishLetterName(task) {
  const source = String(task?.correctAnswer || task?.target?.display || "");
  return source.match(/[A-Za-z]/)?.[0]?.toLocaleUpperCase() || "";
}

function englishAssociation(task) {
  const sources = [task?.context, task?.demonstration].map(value => String(value || ""));
  for (const source of sources) {
    const association = source.match(/[—-]\s*([A-Za-z][A-Za-z'-]{1,})/)?.[1]
      || source.match(/[,，]\s*([A-Za-z][A-Za-z'-]{1,})/)?.[1];
    if (association) return association;
  }
  return "";
}

function englishLetterExplanation(task) {
  const letter = englishLetterName(task);
  if (!letter) return "请看清这个字母的大写和小写样子。";
  const association = englishAssociation(task);
  return association
    ? `这是字母 ${letter}。${association} 这个单词以它开头。`
    : `这是字母 ${letter}。请看清它的大写和小写样子。`;
}

export function reinforcementSpeechText(task, studyMode) {
  if (!task?.target?.display) return "";
  if (task.subject === "hanzi") {
    const character = String(task.correctAnswer || task.target.display).trim();
    const words = HANZI_WORDS[character];
    return words?.length ? `${character}，${words.join("、")}。` : `${character}。`;
  }
  if (studyMode === "test" || studyMode === "practice") return "";
  if (task.subject === "english_letter") return englishLetterExplanation(task);
  const explicit = String(task.reinforcement || "").trim();
  if (explicit) return explicit;
  // Context belongs before the answer; it may ask the child to think or read.
  // Only explicit reinforcement or an answer demonstration is safe after success.
  return demonstrationSpeechText(task);
}

export function demonstrationSpeechText(task) {
  if (task?.subject === "english_letter") return englishLetterExplanation(task);
  const hanziText = hanziDemonstration(task);
  if (hanziText) return hanziText;
  const answer = String(task?.correctAnswer || task?.target?.display || "").trim();
  if (task?.subject === "math" && /^math_digit_/.test(String(task?.evidenceType || ""))) {
    return answer === "0" ? "这是数字 0，表示一个也没有。" : `这是数字 ${answer}。`;
  }
  const demonstration = String(task?.demonstration || "").trim();
  return `${answer ? `答案是${answer}。` : ""}${demonstration}`.trim();
}
