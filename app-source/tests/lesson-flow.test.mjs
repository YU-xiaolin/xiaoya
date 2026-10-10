import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as voice from '../src/voice-text.js';
import { taskHint } from '../src/targeted-hints.js';
import * as composition from '../src/composition-board.js';
const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8'))
  .replace(/^import "\.\/styles.css";\s*/m, '')
  .replace(/^import\s+[\s\S]*?\s+from\s+"[^"]+";\s*/gm, '')
  .replace(/loadDashboard\(\);\s*$/, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const listeners = {}, timers = new Map(), speech = [];
  let nextTimer = 1, activeSpeech;
  const node = { textContent: '', innerHTML: '', insertAdjacentHTML() {}, scrollIntoView() {}, remove() {} };
  const context = vm.createContext({
    ...voice, ...composition, taskHint, crypto: webcrypto, structuredClone, console,
    DEFAULT_DIFFICULTY_WEIGHTS: {}, DEFAULT_HANZI_ORAL_READING_PERCENT: 50,
    document: { querySelector: () => node, querySelectorAll: () => [], addEventListener: (name, fn) => listeners[name] = fn, createElement: () => node, body: { append() {} } },
    window: { setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; } },
    clearTimeout: id => timers.delete(id),
    createSpeechPlayer: () => ({ cancel() { activeSpeech?.(); activeSpeech = null; }, speak(text) { speech.push(text); return new Promise(resolve => { activeSpeech = resolve; }); } }),
    invoke: async () => { throw new Error('simulated save failure'); }
  });
  vm.runInContext(source + `
    renderSubject = () => {};
    runtime.queue = [1,2,3,4].map(n => ({ taskId: 'task-'+n, subject: 'hanzi', target: {ref:'ZH-'+n,display:'木'}, questionType:'recognition', context:'先自己想一想，再大声说出来。', prompt:'请读出屏幕上的汉字。' }));
    runtime.modeSourceTasks = structuredClone(runtime.queue);
    runtime.session = { events: [] };
    runtime.activeLesson = { protocol:'FAMILY_LEARNING_LESSON_V1' };
    runtime.attempt = 1;
    runtime.taskShownAt = Date.now();
    globalThis.api = { runtime, answer, pauseLesson, resumeLesson, advance, stopLesson, finishSession, renderLesson };
  `, context);
  const runTimers = ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
  return { ...context.api, context, speech, listeners, timers, runTimers, finishSpeech: () => { activeSpeech?.(); activeSpeech = null; } };
}

test('答对后先完成鼓励再讲解，慢语音不会被固定计时器截断', async () => {
  const h = harness();
  h.answer(true);
  h.runTimers(1400);
  await flush();
  assert.equal(h.runtime.queueIndex, 0);
  assert.deepEqual(h.speech, ['真棒，答对了！']);
  h.finishSpeech();
  await flush();
  assert.equal(h.runtime.queueIndex, 0);
  assert.equal(h.speech.length, 2);
  assert.ok(!h.speech[1].includes('先自己想'));
  h.finishSpeech();
  await flush();
  assert.equal(h.runtime.queueIndex, 1);
});

test('鼓励播放时可以立即暂停，恢复进入下一题且不重复记录', async () => {
  const h = harness();
  h.answer(true);
  h.pauseLesson();
  await flush();
  assert.equal(h.runtime.paused, true);
  assert.equal(h.runtime.queueIndex, 0);
  h.resumeLesson();
  assert.equal(h.runtime.queueIndex, 1);
  assert.equal(h.runtime.session.events.length, 1);
  assert.equal(h.speech.length, 1);
});

test('点击下一题后旧的反馈异步任务不会再次跳题', async () => {
  const h = harness();
  h.answer(true);
  h.advance();
  await flush();
  h.runTimers(1400);
  await flush();
  assert.equal(h.runtime.queueIndex, 1);
  assert.equal(h.runtime.session.events.length, 1);
});

test('保存失败时快捷键不能继续修改本节事实；重试保留同一结束时间', async () => {
  const h = harness();
  h.answer(false);
  await h.stopLesson();
  const count = h.runtime.session.events.length;
  const endedAt = h.runtime.session.endedAt;
  h.listeners.keydown({ key:'t', target:{closest:()=>null} });
  h.answer(true);
  assert.equal(h.runtime.session.events.length, count);
  await h.finishSession(false, 'parent_stopped');
  assert.equal(h.runtime.session.endedAt, endedAt);
  assert.equal(h.runtime.session.events.length, count);
});

test('长按答错键只计第一次错误，不自动触发第二次示范', () => {
  const h = harness();
  const event = {key:'f', target:{closest:()=>null}};
  h.listeners.keydown(event);
  h.listeners.keydown({...event,repeat:true});
  assert.equal(h.runtime.attempt, 2);
  assert.equal(h.runtime.supportMode, 'hint');
  assert.equal(h.runtime.session.events.filter(e=>e.result==='incorrect').length, 1);
});

test('题目未自动播出时作答，待播题目被取消', async () => {
  const h = harness();
  h.renderLesson();
  h.answer(true);
  h.runTimers(160);
  assert.deepEqual(h.speech, ['真棒，答对了！']);
  h.pauseLesson();
  await flush();
});
