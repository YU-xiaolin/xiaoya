import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "./core/voice-text.js";
import { taskHintVariants } from "./core/targeted-hints.js";
import { compositionInstructions, isCompositionModel } from "./core/composition-board.js";

// Runtime preloading and build auditing use the same task narration list.
export function taskVoiceTexts(task, mode = "lesson") {
  return [...new Set([
    questionSpeechText(task),
    ...(isCompositionModel(task) ? Object.values(compositionInstructions(task.composition)) : []),
    reinforcementSpeechText(task, mode),
    ...taskHintVariants(task).map(hint => hintSpeechText(task, hint)),
    demonstrationSpeechText(task)
  ].map(text => String(text || "").trim()).filter(Boolean))];
}
