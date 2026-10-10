// 语音层：优先使用随应用发布的晓伊自然语音包；缺失时退回设备自带中文语音，
// 并在家长页明确说明，绝不假装语音包已完整。
import { createSpeechPlayer } from "./core/speech-player.js";

let manifest = null;
let voiceSource = "device";
const listeners = new Set();

const player = createSpeechPlayer({
  loadClip: async fileName => {
    const response = await fetch(`./voice/${fileName}`, { cache: "force-cache" });
    if (!response.ok) throw new Error(`语音文件 ${fileName} 不可用`);
    return new Uint8Array(await response.arrayBuffer());
  },
  createAudio: url => new Audio(url),
  createUrl: (bytes, fileName) => URL.createObjectURL(
    new Blob([bytes], { type: fileName.endsWith(".wav") ? "audio/wav" : "audio/mpeg" })
  ),
  revokeUrl: url => URL.revokeObjectURL(url),
  onUnavailable: () => { /* 由 speak() 统一处理回退。 */ }
});

export function onVoiceStatusChange(callback) {
  listeners.add(callback);
  callback({ source: voiceSource, clipCount: manifest ? Object.keys(manifest.clips).length : 0 });
  return () => listeners.delete(callback);
}

function emitVoiceStatus() {
  const status = { source: voiceSource, clipCount: manifest ? Object.keys(manifest.clips).length : 0 };
  for (const callback of listeners) callback(status);
}

export async function initVoice() {
  try {
    const response = await fetch("./voice/manifest.json", { cache: "force-cache" });
    if (response.ok) {
      const parsed = await response.json();
      if (parsed?.schemaVersion === 1 && parsed.clips && Object.keys(parsed.clips).length) {
        manifest = parsed;
        voiceSource = "pack";
      }
    }
  } catch {
    manifest = null;
    voiceSource = "device";
  }
  emitVoiceStatus();
  return voiceSource;
}

export function voiceStatus() {
  return { source: voiceSource, clipCount: manifest ? Object.keys(manifest.clips).length : 0 };
}

function pickChineseVoice(synth) {
  const voices = synth.getVoices?.() || [];
  const chinese = voices.filter(voice => /^zh/i.test(voice.lang || ""));
  if (!chinese.length) return null;
  // 尽量挑一个偏自然的本地语音；不同系统命名不一，只做优先级排序，不做硬编码。
  const preferred = chinese.find(voice => /tingting|ting-ting|sinji|mei-jia|yaoyao|huihui|xiaoxiao|yunxi|female/i.test(voice.name || ""));
  return preferred || chinese[0];
}

function speakWithDevice(text, generation) {
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return Promise.resolve("unavailable");
  return new Promise(resolve => {
    let settled = false;
    const finish = status => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const utterance = new Utterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1.05;
    const voice = pickChineseVoice(synth);
    if (voice) utterance.voice = voice;
    utterance.onend = () => finish(generation === activeGeneration ? "ended" : "cancelled");
    utterance.onerror = () => finish(generation === activeGeneration ? "unavailable" : "cancelled");
    try {
      synth.cancel();
      synth.speak(utterance);
    } catch {
      finish("unavailable");
      return;
    }
    // 某些浏览器（尤其 iOS）不触发 onend；按文本长度给一个上界，避免卡住流程。
    setTimeout(() => finish(generation === activeGeneration ? "ended" : "cancelled"), Math.max(2000, text.length * 380));
  });
}

// 语音请求代次：取消后旧请求必须立即失效，绝不允许它再回退到设备语音重新播出。
let activeGeneration = 0;

// 供主流程调用的统一朗读入口：先查语音包，再退回设备语音。
export async function speak(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "empty";
  const generation = ++activeGeneration;
  const fresh = () => generation === activeGeneration;

  if (manifest?.clips?.[normalized]?.fileName) {
    const result = await player.speak(normalized, manifest);
    // 被取消（cancelled）或被更新的请求取代，直接结束，绝不回退到设备语音重新播出。
    if (result === "cancelled" || !fresh()) return "cancelled";
    if (result === "ended") return "ended";
    // 只有确实「不可用」（unavailable）才允许回退到设备语音。
    if (result !== "unavailable") return result;
  }
  if (!fresh()) return "cancelled";
  return speakWithDevice(normalized, generation);
}

export function cancelSpeech() {
  // 代次自增：任何仍在进行中的文件加载或设备朗读都会在完成时判定为 cancelled。
  activeGeneration += 1;
  player.cancel();
  try { globalThis.speechSynthesis?.cancel(); } catch { /* 设备不支持设备语音。 */ }
}

// iOS/部分安卓要求首次播放由用户手势触发；在第一次触摸时预热一次静音语音。
let unlocked = false;
export function armAudioUnlock() {
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    try {
      const synth = globalThis.speechSynthesis;
      const Utterance = globalThis.SpeechSynthesisUtterance;
      if (synth && Utterance) {
        const silent = new Utterance(" ");
        silent.volume = 0;
        synth.speak(silent);
      }
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AudioContext) {
        const context = new AudioContext();
        context.resume?.().finally(() => context.close?.());
      }
    } catch { /* 预热失败不影响后续播放。 */ }
    document.removeEventListener("touchend", unlock);
    document.removeEventListener("click", unlock);
  };
  document.addEventListener("touchend", unlock, { passive: true });
  document.addEventListener("click", unlock);
}
