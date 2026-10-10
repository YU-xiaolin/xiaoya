import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechPlayer } from "../src/speech-player.js";

const manifest = { clips: { question: { fileName: "q.mp3" }, praise: { fileName: "p.mp3" } } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(loadClip = async name => name) {
  const audios = [], revoked = [], unavailable = [];
  const player = createSpeechPlayer({
    loadClip, createUrl: bytes => `blob:${bytes}`, revokeUrl: url => revoked.push(url),
    onUnavailable: value => unavailable.push(value),
    createAudio: url => {
      const audio = { url, paused: false, currentTime: 5, play() { return Promise.resolve(); }, pause() { this.paused = true; } };
      audios.push(audio);
      return audio;
    }
  });
  return { player, audios, revoked, unavailable };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("点击答对会真正停止旧音频再播放鼓励，旧音频只释放一次", async () => {
  const { player, audios, revoked } = setup();
  const question = player.speak("question", manifest);
  await flush();
  const praise = player.speak("praise", manifest);
  assert.equal(audios[0].paused, true);
  assert.equal(audios[0].currentTime, 0);
  assert.equal(await question, "cancelled");
  await flush();
  audios[1].onended();
  assert.equal(await praise, "ended");
  assert.deepEqual(revoked, ["blob:q.mp3", "blob:p.mp3"]);
});

test("题目文件慢加载时答对，迟到的题目不会播放", async () => {
  const slow = deferred();
  const { player, audios } = setup(name => name === "q.mp3" ? slow.promise : Promise.resolve(name));
  const question = player.speak("question", manifest);
  const praise = player.speak("praise", manifest);
  await flush();
  slow.resolve("q.mp3");
  assert.equal(await question, "cancelled");
  assert.equal(audios.length, 1);
  assert.equal(audios[0].url, "blob:p.mp3");
  audios[0].onended();
  assert.equal(await praise, "ended");
});

test("退出或暂停能撤销加载中的语音，迟到失败不弹错误", async () => {
  const slow = deferred();
  const { player, audios, unavailable } = setup(() => slow.promise);
  const question = player.speak("question", manifest);
  player.cancel();
  slow.reject(new Error("read failed"));
  assert.equal(await question, "cancelled");
  assert.deepEqual(audios, []);
  assert.deepEqual(unavailable, []);
});

test("上一段播放失败的迟到回调不能取消新语音", async () => {
  const { player, audios, unavailable } = setup();
  const question = player.speak("question", manifest);
  await flush();
  const lateError = audios[0].onerror;
  const praise = player.speak("praise", manifest);
  await flush();
  lateError();
  assert.equal(audios[1].paused, false);
  assert.deepEqual(unavailable, []);
  audios[1].onended();
  assert.equal(await question, "cancelled");
  assert.equal(await praise, "ended");
});

test("缺少清单、缺音频和损坏音频都明确报错并结束等待", async () => {
  const { player, audios, unavailable } = setup();
  assert.equal(await player.speak("question", null), "unavailable");
  assert.equal(await player.speak("missing", manifest), "unavailable");
  const question = player.speak("question", manifest);
  await flush();
  audios[0].onerror();
  assert.equal(await question, "unavailable");
  assert.equal(audios[0].paused, true);
  assert.deepEqual(unavailable, [false, false, true]);
});
