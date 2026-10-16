import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import * as transfer from "../src/ai-transfer.js";
import * as protocol from "../src/protocol.js";
import * as testMode from "../src/test-mode.js";
import * as voice from "../src/voice-text.js";
import * as composition from "../src/composition-board.js";
import { taskHint } from "../src/targeted-hints.js";

const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8"))
  .replace(/^import "\.\/styles.css";\s*/m, "")
  .replace(/^import\s+[\s\S]*?\s+from\s+"[^"]+";\s*/gm, "")
  .replace(/loadDashboard\(\);\s*$/, "");
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const catalog = { hanzi: [..."人大山水火木"].map((display, index) => ({
    ref: `ZH-${index + 1}`, display, optionDisplay: display, status: "初见"
  })), english_letter: [], math: [] };
  const bundle = { protocol: "FAMILY_LEARNING_AI_RESULT_V1", schemaVersion: 1, exportId: "export-ui-synthetic",
    baseRevision: "revision-ui-synthetic", basedOnSessionIds: ["session-ui-synthetic"],
    stateUpdate: { ignoredEventIds: [], changes: [] },
    lessonPlan: { title: "导入的新课程", teacherNote: "先练习两个熟悉的汉字。", estimatedMinutes: 5,
      reducedNewHanziReason: "模拟复习", previousNewHanziRefs: ["ZH-1"], nextPreviewHanziRefs: [],
      tasks: [{ subject: "hanzi", targetRef: "ZH-2", questionType: "choice", isNew: false }] },
    parentReport: "模拟家长报告" };
  const prepared = { bundle, catalog, lessonId: "lesson-ui-new", generatedAt: "2026-10-16T12:00:00Z", updateId: "update-ui-new" };
  const newLesson = transfer.compileAiLesson(bundle, prepared);
  const oldLesson = { ...structuredClone(newLesson), lessonId: "lesson-ui-old", title: "保留的原课程" };
  const oldDashboard = { lesson: oldLesson, stateSummary: {}, ai: {}, testCatalog: catalog, dataDir: "synthetic-only" };
  const newDashboard = { ...oldDashboard, lesson: newLesson, ai: { parentReport: bundle.parentReport } };
  const manifest = { clips: Object.fromEntries(transfer.collectAiVoiceRequirements(newLesson, catalog)
    .map((clip, index) => [clip.text, { ...clip, fileName: `synthetic-${index}.mp3` }])) };
  const calls = [], inputs = [];
  const app = { innerHTML: "" };
  const context = vm.createContext({
    ...transfer, ...protocol, ...testMode, ...voice, ...composition, taskHint,
    crypto: webcrypto, structuredClone, console, clearTimeout,
    buildMathLesson: () => ({ tasks: [] }), createSpeechPlayer: () => ({ cancel() {}, speak() {} }),
    localStorage: { getItem: () => null },
    document: {
      querySelector: selector => selector === "#app" ? app : null,
      querySelectorAll: () => [], addEventListener() {}, body: { append() {} },
      createElement(type) {
        assert.equal(type, "input");
        const listeners = {};
        const input = { files: [], hidden: false, removed: false, setAttribute() {}, click() {},
          addEventListener: (event, handler) => { listeners[event] = handler; },
          remove() { this.removed = true; },
          select(file) { this.files = [file]; listeners.change(); }, cancel() { listeners.cancel(); } };
        inputs.push(input); return input;
      }
    },
    window: { setTimeout },
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](args);
      if (name === "prepare_ai_import") return { ...prepared, bundle: args.bundle };
      if (name === "load_voice_manifest") return manifest;
      if (name === "import_ai_result") return { message: "已导入", alreadyImported: false };
      if (name === "load_dashboard") return newDashboard;
      if (name === "export_ai_bundle") return { cancelled: false, path: "桌面/模拟学习资料.json", pendingSessionCount: 2, analysisOnly: false };
      throw new Error(`Unexpected command: ${name}`);
    }
  });
  vm.runInContext(source + "\nglobalThis.api = { runtime, exportAiBundle, importAiResult, renderParentDashboard };", context);
  context.api.runtime.dashboard = oldDashboard;
  context.api.runtime.lesson = oldLesson;
  context.api.runtime.voiceManifest = manifest;
  return { ...context.api, calls, inputs, app, bundle, prepared, oldDashboard, oldLesson, newLesson, manifest,
    selectFile(text = JSON.stringify(bundle)) { inputs.at(-1).select({ size: text.length, text: async () => text }); } };
}

test("家长页明确本机检查作用，导出可选位置，处理结果导入后才更新课程", () => {
  const h = harness(); h.renderParentDashboard();
  assert.match(h.app.innerHTML, /导出学习资料/u);
  assert.match(h.app.innerHTML, /导入 AI 结果/u);
  assert.match(h.app.innerHTML, /桌面/u);
  assert.match(h.app.innerHTML, /不会联网调用 AI/u);
  assert.doesNotMatch(h.app.innerHTML, /FAMILY_LEARNING|lessonPlan|stateUpdate/u);
});

test("手选结果后先检查并编课，事务成功后才刷新显示，始终留在家长管理", async () => {
  const h = harness();
  const pending = h.importAiResult();
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0].accept, ".json,application/json");
  h.selectFile(`\uFEFF${JSON.stringify(h.bundle)}`);
  await pending;
  assert.deepEqual(h.calls.map(call => call.name), ["prepare_ai_import", "load_voice_manifest", "import_ai_result", "load_dashboard", "load_voice_manifest"]);
  const committed = h.calls.find(call => call.name === "import_ai_result").args;
  assert.deepEqual(committed.lesson, h.newLesson);
  assert.ok(committed.voiceRequirements.length > 2);
  assert.equal(h.runtime.view, "parent");
  assert.equal(h.runtime.lesson.title, "导入的新课程");
  assert.match(h.app.innerHTML, /课程和家长报告已更新/u);
  assert.equal(h.inputs[0].removed, true);
});

test("选择文件与后台检查时禁用操作，双击只能发起一次导入", async () => {
  let finishCommit;
  const h = harness({ import_ai_result: () => new Promise(resolve => { finishCommit = resolve; }) });
  const pending = h.importAiResult();
  await h.importAiResult();
  assert.equal(h.inputs.length, 1);
  assert.equal(h.runtime.aiTransferBusy, "import");
  assert.match(h.app.innerHTML, /data-action="export-ai" disabled/u);
  assert.match(h.app.innerHTML, /data-action="refresh" disabled/u);
  h.selectFile(); await flush();
  await h.importAiResult();
  assert.equal(h.calls.filter(call => call.name === "prepare_ai_import").length, 1);
  assert.equal(h.calls.filter(call => call.name === "import_ai_result").length, 1);
  finishCommit({ alreadyImported: false }); await pending;
  assert.equal(h.runtime.aiTransferBusy, false);
});

test("取消选择安静返回，保留上次提示和课程，不读写后台", async () => {
  const h = harness();
  const previousMessage = { kind: "success", text: "上次已导出" };
  h.runtime.aiTransferMessage = previousMessage;
  const pending = h.importAiResult(); h.inputs[0].cancel(); await pending;
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.lesson, h.oldLesson);
  assert.equal(h.runtime.aiTransferMessage, previousMessage);
  assert.equal(h.runtime.aiTransferBusy, false);
});

test("损坏结果、基线错误或缺语音都保留原课程，不调用加载或提交", async () => {
  for (const [overrides, text, expected] of [
    [{}, "invalid-json", /完整的 JSON/u],
    [{ prepare_ai_import: () => { throw new Error("导出后有新记录，请重新导出"); } }, undefined, /重新导出/u],
    [{ load_voice_manifest: () => ({ clips: {} }) }, undefined, /还缺.*晓伊/u]
  ]) {
    const h = harness(overrides); const pending = h.importAiResult(); h.selectFile(text); await pending;
    assert.equal(h.runtime.lesson, h.oldLesson);
    assert.equal(h.runtime.dashboard, h.oldDashboard);
    assert.ok(!h.calls.some(call => ["load_dashboard", "import_ai_result"].includes(call.name)));
    assert.match(h.app.innerHTML, /原课程继续保留/u);
    assert.match(h.runtime.aiTransferMessage.text, expected);
  }
});

test("后端事务拒绝不刷新正式状态，提交成功但刷新失败会如实区分", async () => {
  const rejected = harness({ import_ai_result: () => { throw new Error("证据不满足"); } });
  let pending = rejected.importAiResult(); rejected.selectFile(); await pending;
  assert.equal(rejected.runtime.lesson, rejected.oldLesson);
  assert.ok(!rejected.calls.some(call => call.name === "load_dashboard"));
  assert.match(rejected.app.innerHTML, /证据不满足/u);
  const committed = harness({ load_dashboard: () => { throw new Error("暂时不能读取"); } });
  pending = committed.importAiResult(); committed.selectFile(); await pending;
  assert.match(committed.app.innerHTML, /结果已保存，刷新显示暂未完成/u);
  assert.doesNotMatch(committed.app.innerHTML, /这次没有导入/u);
});

test("同一已导入结果安全重载，不再次提交；仅复盘导出与另存为取消不改变课程", async () => {
  const duplicate = harness({ prepare_ai_import: () => ({ alreadyImported: true, message: "这份结果此前已导入" }) });
  const pending = duplicate.importAiResult(); duplicate.selectFile(); await pending;
  assert.ok(!duplicate.calls.some(call => call.name === "import_ai_result"));
  assert.match(duplicate.app.innerHTML, /此前已导入/u);
  assert.equal(duplicate.runtime.view, "parent");
  const review = harness({ export_ai_bundle: () => ({ cancelled: false, analysisOnly: true, path: "桌面/复盘.json", pendingSessionCount: 0 }) });
  await review.exportAiBundle();
  assert.equal(review.runtime.lesson, review.oldLesson);
  assert.match(review.app.innerHTML, /可用于复盘；无需导入/u);
  const cancelled = harness({ export_ai_bundle: () => ({ cancelled: true }) });
  await cancelled.exportAiBundle();
  assert.equal(cancelled.runtime.aiTransferMessage, null);
  assert.equal(cancelled.runtime.lesson, cancelled.oldLesson);
  assert.deepEqual(cancelled.calls.map(call => call.name), ["export_ai_bundle"]);
});
