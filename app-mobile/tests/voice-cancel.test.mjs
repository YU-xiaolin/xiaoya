// R10 的确定性回归测试：在 Node 里给语音层装上假的浏览器环境，
// 直接验证「取消后不得回退到设备语音、只有 unavailable 才回退」。
import { test } from "node:test";
import assert from "node:assert/strict";

const VOICE_PATH = "../src/voice.js";

// 每次测试都用带 query 的同一路径重新 import 会缓存；用动态版本号绕开缓存。
let importCounter = 0;
async function loadVoiceModule() {
  importCounter += 1;
  return import(/* @vite-ignore */ `${VOICE_PATH}?case=${importCounter}`);
}

function installBrowserStubs({ manifestClips = null, clipBehavior = "ended" } = {}) {
  const deviceSpoken = [];
  const state = { clipBehavior, loadCount: 0, cancelCount: 0 };

  globalThis.Audio = class {
    constructor() {
      this.onended = null;
      this.onerror = null;
    }
    pause() { /* no-op */ }
    set currentTime(_value) { /* no-op */ }
    async play() {
      // 由测试用例决定这一片语音文件加载/播放的结果。
      queueMicrotask(() => {
        if (state.clipBehavior === "ended") this.onended?.();
        else if (state.clipBehavior === "unavailable") this.onerror?.();
        // "pending" 时保持不结束，用于测试取消。
      });
    }
  };

  globalThis.URL.createObjectURL = () => `blob:xiaoya-${Math.random()}`;
  globalThis.URL.revokeObjectURL = () => { /* no-op */ };

  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: "zh-CN", name: "Ting-Ting" }],
    cancel() { state.cancelCount += 1; },
    speak(utterance) {
      deviceSpoken.push(utterance.text);
    }
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.volume = 1; }
  };

  globalThis.fetch = async url => {
    state.loadCount += 1;
    if (!manifestClips) return { ok: false, json: async () => ({}) };
    const isManifest = String(url).includes("manifest.json");
    if (isManifest) {
      return { ok: true, json: async () => ({ schemaVersion: 1, clips: manifestClips }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };

  return { deviceSpoken, state };
}

test("R10 语音包播放被取消时不得回退到设备语音", async () => {
  const clips = { "旧题目": { fileName: "old.mp3" } };
  const { deviceSpoken, state } = installBrowserStubs({ manifestClips: clips, clipBehavior: "pending" });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  const pending = voice.speak("旧题目");
  await new Promise(resolve => setTimeout(resolve, 30));
  voice.cancelSpeech();
  const status = await pending;

  assert.equal(status, "cancelled", "被取消的语音应返回 cancelled");
  assert.equal(deviceSpoken.length, 0, `取消后不应回退到设备语音，实际播出：${JSON.stringify(deviceSpoken)}`);
  assert.equal(state.loadCount > 0, true, "应确实走了语音包加载路径");
});

test("R10 语音包本身不可用（unavailable）时才允许回退到设备语音", async () => {
  const clips = { "新题目": { fileName: "new.mp3" } };
  const { deviceSpoken } = installBrowserStubs({ manifestClips: clips, clipBehavior: "unavailable" });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  const status = await voice.speak("新题目");
  assert.equal(deviceSpoken.length, 1, "真正不可用时应回退到设备语音");
  assert.equal(deviceSpoken[0], "新题目");
  assert.equal(status, "ended");
});

test("R10 语音包播放正常结束时返回 ended 且不回退", async () => {
  const clips = { "正常句子": { fileName: "ok.mp3" } };
  const { deviceSpoken } = installBrowserStubs({ manifestClips: clips, clipBehavior: "ended" });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  const status = await voice.speak("正常句子");
  assert.equal(status, "ended");
  assert.equal(deviceSpoken.length, 0, "正常结束不应触发设备语音");
});

test("R10 后一次朗读会作废前一次（代次机制）", async () => {
  const clips = { "第一句": { fileName: "a.mp3" }, "第二句": { fileName: "b.mp3" } };
  const { deviceSpoken } = installBrowserStubs({ manifestClips: clips, clipBehavior: "pending" });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  const first = voice.speak("第一句");
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = voice.speak("第二句");
  await new Promise(resolve => setTimeout(resolve, 20));

  const firstStatus = await first;
  assert.equal(firstStatus, "cancelled", "新的朗读应作废上一次请求");
  voice.cancelSpeech();
  const secondStatus = await second;
  assert.equal(secondStatus, "cancelled");
  assert.equal(deviceSpoken.length, 0, "被作废的请求不得回退到设备语音");
});

test("R10 没有语音包时使用设备语音", async () => {
  const { deviceSpoken } = installBrowserStubs({ manifestClips: null });
  const voice = await loadVoiceModule();
  await voice.initVoice();
  assert.equal(voice.voiceStatus().source, "device");

  const status = await voice.speak("设备语音测试");
  assert.equal(deviceSpoken.length, 1);
  assert.equal(status, "ended");
});

// 这是审核报告复现的确切场景：语音包里的句子正在播，此时取消，
// 旧实现会因为只认 "ended" 而落进 speakWithDevice，把「旧题目」用设备语音再播一遍。
// 用不可用的语音包制造「走到回退分支」的机会。
test("R10 回退分支也受代次约束：取消后不得用设备语音播出旧题目", async () => {
  const clips = { "旧题目": { fileName: "old.mp3" } };
  const { deviceSpoken } = installBrowserStubs({ manifestClips: clips, clipBehavior: "unavailable" });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  // 先确认正常路径下确实会回退（否则本用例没有意义）。
  await voice.speak("旧题目");
  assert.equal(deviceSpoken.length, 1, "前置条件：不可用时应回退一次");

  // 现在是关键场景：取消发生在回退之前。
  const pending = voice.speak("旧题目");
  voice.cancelSpeech();          // 在回退发生前取消
  const status = await pending;

  assert.equal(status, "cancelled", `取消后应返回 cancelled，实际 ${status}`);
  assert.equal(
    deviceSpoken.length,
    1,
    `取消后不得再用设备语音播出，实际播出序列：${JSON.stringify(deviceSpoken)}`
  );
});

test("R10 设备语音朗读过程中被取消时返回 cancelled", async () => {
  const { deviceSpoken } = installBrowserStubs({ manifestClips: null });
  const voice = await loadVoiceModule();
  await voice.initVoice();

  // 设备语音：speakWithDevice 会用 setTimeout 给一个上界，这里直接等它走完，
  // 但期间先取消，验证代次能把它标记为 cancelled。
  const pending = voice.speak("一句很长很长的设备语音测试句子，用来拉长等待时间");
  await new Promise(resolve => setTimeout(resolve, 20));
  voice.cancelSpeech();
  const status = await pending;
  assert.equal(status, "cancelled", `取消后设备语音也应返回 cancelled，实际 ${status}`);
  assert.equal(deviceSpoken.length, 1, "取消前已经开始朗读的这一次不受影响");
});
