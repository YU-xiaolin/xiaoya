import { createMobileSpeechPlayer } from "./mobile-speech-player.js";
import { APP_VERSION } from "./config.js";

export const VOICE_CACHE = "xiaoya-voice-v1";
let manifest = null;
let voiceSource = "device";
let activeGeneration = 0;
let finishDevice = null;
const listeners = new Set();
const player = createMobileSpeechPlayer();

export function voiceStatus() {
  return { source: voiceSource, clipCount: manifest ? Object.keys(manifest.clips).length : 0 };
}
export function onVoiceStatusChange(callback) {
  listeners.add(callback);
  callback(voiceStatus());
  return () => listeners.delete(callback);
}
export async function initVoice() {
  manifest = null;
  voiceSource = "device";
  try {
    // An older service worker may still control the first page after an upgrade.
    // A versioned URL bypasses its old manifest; the plain URL remains the cold
    // offline fallback because it is always included in the shell precache.
    let response;
    try {
      response = await fetch(`./voice/manifest.json?v=${APP_VERSION}`, { cache: "no-cache", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("语音清单暂时不可用");
    } catch {
      response = await fetch("./voice/manifest.json", { cache: "no-cache", signal: AbortSignal.timeout(10000) });
    }
    if (response.ok) {
      const parsed = await response.json();
      if (parsed?.schemaVersion === 1 && parsed.clips && Object.keys(parsed.clips).length) {
        manifest = parsed;
        voiceSource = "pack";
      }
    }
  } catch { /* Learning remains available; playback reports an explicit failure. */ }
  for (const callback of listeners) callback(voiceStatus());
  return voiceSource;
}
function speakWithDevice(text, generation) {
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return Promise.resolve("unavailable");
  const chinese = (synth.getVoices?.() || []).filter(voice => /^zh/i.test(voice.lang || ""));
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finishDevice === finish) finishDevice = null;
      resolve(generation === activeGeneration ? status : "cancelled");
    };
    finishDevice = finish;
    const utterance = new Utterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1.05;
    const voice = chinese.find(item => /tingting|sinji|mei-jia|yaoyao|huihui|xiaoxiao|female/i.test(item.name || "")) || chinese[0];
    if (voice) utterance.voice = voice;
    utterance.onend = () => finish("ended");
    utterance.onerror = event => finish(event?.error === "not-allowed" ? "blocked" : "unavailable");
    timer = setTimeout(() => {
      finish("unavailable");
      try { synth.cancel(); } catch { /* Unavailable device speech. */ }
    }, Math.max(10000, text.length * 600));
    timer?.unref?.();
    try { synth.speak(utterance); } catch { finish("unavailable"); }
  });
}
export function cancelSpeech() {
  activeGeneration += 1;
  player.cancel();
  finishDevice?.("cancelled");
  try { globalThis.speechSynthesis?.cancel(); } catch { /* No device speech. */ }
}
export async function speak(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "empty";
  cancelSpeech();
  const generation = activeGeneration;
  const fresh = () => generation === activeGeneration;
  if (manifest?.clips?.[normalized]?.fileName) {
    const result = await player.speak(normalized, manifest);
    if (result === "cancelled" || !fresh()) return "cancelled";
    if (result !== "unavailable") return result;
  }
  if (!fresh()) return "cancelled";
  return speakWithDevice(normalized, generation);
}

// The current lesson is preloaded automatically. Full offline download is an
// explicit parent action; no private text is transmitted to a speech service.
export async function prepareOfflineVoices({ texts = null, onProgress } = {}) {
  if (!manifest) await initVoice();
  if (!manifest) throw new Error("语音清单暂时不可用，请联网后重试。");
  if (!globalThis.caches) throw new Error("当前浏览器不能保存离线语音。");
  const wanted = texts == null ? Object.keys(manifest.clips) : [...new Set(texts)];
  const names = [...new Set(wanted.map(text => manifest.clips[text]?.fileName).filter(Boolean))];
  const missingTexts = wanted.filter(text => !manifest.clips[text]?.fileName);
  const cache = await caches.open(VOICE_CACHE);
  let cursor = 0;
  let done = 0;
  const failures = [];
  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++];
      try {
        if (!/^[a-zA-Z0-9._-]+\.(mp3|wav)$/i.test(name)) throw new Error("语音文件名无效");
        const url = new URL(`./voice/${name}`, document.baseURI).href;
        if (!await cache.match(url)) {
          const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("语音文件不可用");
          await cache.put(url, response);
        }
        done += 1;
      } catch { failures.push(name); }
      onProgress?.({ done, total: names.length, failed: failures.length });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { done, total: names.length, failed: failures.length, missingTexts: missingTexts.length };
}
export function armAudioUnlock() {
  // Capture phase precedes lesson handlers. Retry after a denied first gesture.
  const unlock = () => player.unlock();
  document.addEventListener("touchend", unlock, { passive: true, capture: true });
  document.addEventListener("click", unlock, { capture: true });
}
