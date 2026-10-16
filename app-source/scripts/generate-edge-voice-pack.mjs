import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildPracticeTasks, buildPreviewTasks, buildTestTasks } from "../src/test-mode.js";
import { demonstrationSpeechText, hintSpeechText, questionSpeechText, reinforcementSpeechText } from "../src/voice-text.js";
import { taskHintVariants } from "../src/targeted-hints.js";
import { buildAllMathVoiceTasks } from "../src/math-mode.js";
import { childFacingAudienceIssue } from "../src/protocol.js";
import { compositionInstructions, isCompositionModel } from "../src/composition-board.js";

const dataArgument = process.argv.find(argument => argument.startsWith("--data-dir="));
const dataDir = dataArgument?.slice("--data-dir=".length)
  || process.env.FAMILY_LEARNING_DATA_DIR
  || "C:\\codex\\AI家庭学习\\data";
const userProfile = process.env.USERPROFILE || process.env.HOME || "";
const skillScript = process.env.EDGE_TTS_SKILL_SCRIPT
  || path.resolve("../.codebuddy/tools/edge_tts_voice.py");
const python = process.env.EDGE_TTS_PYTHON || "python";

if (!existsSync(skillScript)) {
  throw new Error(`没有找到 Edge-TTS 技能脚本：${skillScript}`);
}

async function loadJson(fileName) {
  return JSON.parse(await readFile(fileName, "utf8"));
}

async function loadOptionalJson(fileName) {
  try {
    return await loadJson(fileName);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const lesson = await loadJson(path.join(dataDir, "ai", "next-lesson.json"));
const state = await loadJson(path.join(dataDir, "state", "learning-state.json"));
const clips = new Map();

function addClip(text, rate = "+15%", pitch = "+6Hz") {
  const normalized = String(text || "").trim();
  if (!normalized || clips.has(normalized)) return;
  clips.set(normalized, {
    text: normalized,
    voice: "zh-CN-XiaoyiNeural",
    rate,
    volume: "+0%",
    pitch
  });
}

addClip("真棒，答对了！", "+18%", "+8Hz");
addClip("太好了，这次答对了！", "+16%", "+7Hz");

function addTaskClips(task, studyMode) {
  const audienceIssue = childFacingAudienceIssue(task);
  if (audienceIssue) {
    throw new Error(`儿童语音口吻检查失败：${task.taskId || "未知题目"} 的 ${audienceIssue.field} 使用了旁观口吻：${audienceIssue.text}`);
  }
  const prompt = questionSpeechText(task);
  addClip(prompt, "+14%", "+6Hz");
  if (isCompositionModel(task)) {
    for (const text of Object.values(compositionInstructions(task.composition))) {
      if (text !== prompt) addClip(text, "+14%", "+6Hz");
    }
  }
  addClip(reinforcementSpeechText(task, studyMode), "+10%", "+4Hz");
  for (const hint of taskHintVariants(task)) addClip(hintSpeechText(task, hint), "+12%", "+5Hz");
  addClip(demonstrationSpeechText(task), "+10%", "+4Hz");
}

const catalog = {};
for (const [subject, items] of Object.entries(state.items || {})) {
  catalog[subject] = Object.entries(items || {}).map(([ref, item]) => ({
    ref,
    display: item.value,
    optionDisplay: subject === "english_letter" ? item.uppercase : item.value,
    status: item.status,
    lastSeenAt: item.lastSeenAt,
    incorrectCount: item.metrics?.incorrectCount || 0,
    association: item.association
  }));
}

// 汉字展示以当前正式词库为准，进度与作答数据仍来自软件状态。
// 这样可以在家长确认清单导入前，先为新增或更正的词库项准备测试语音。
const hanziCsv = await readFile(path.join(dataDir, "catalog", "幼儿汉字1000字表.csv"), "utf8");
catalog.hanzi = hanziCsv.trim().split(/\r?\n/).slice(1).map(line => {
  const [ref, stage, theme, display] = line.split(",");
  const stateItem = state.items?.hanzi?.[ref];
  return {
    ref,
    display,
    optionDisplay: display,
    stage,
    theme,
    status: stateItem?.status || "未学",
    lastSeenAt: stateItem?.lastSeenAt || null,
    incorrectCount: stateItem?.metrics?.incorrectCount || 0
  };
});

for (const task of lesson.tasks || []) addTaskClips(task, "lesson");

// 全词库的提示提前准备，包括任意随机选项可能触发的易混提示。
// 仅发送教学文字，不发送孩子姓名、状态或作答事实。
for (const subject of ["hanzi", "english_letter"]) {
  for (const item of catalog[subject] || []) {
    for (const questionType of ["recognition", "choice"]) {
      const task = { subject, questionType, target: { display: item.display }, correctAnswer: item.optionDisplay, options: [item.optionDisplay] };
      for (const hint of taskHintVariants(task)) addClip(hintSpeechText(task, hint), "+12%", "+5Hz");
    }
  }
}

for (const subject of ["hanzi", "english_letter"]) {
  const lessonTasks = (lesson.tasks || []).filter(task => task.subject === subject);
  const previewRefs = subject === "hanzi"
    ? lesson.metadata?.nextPreviewHanziRefs
    : lesson.metadata?.nextPreviewLetterRefs;
  const previousNewRefs = subject === "hanzi"
    ? lesson.metadata?.previousNewHanziRefs
    : lesson.metadata?.previousNewLetterRefs;
  for (const task of buildPreviewTasks(subject, lessonTasks, catalog, previewRefs, 4)) {
    addTaskClips(task, "preview");
  }
  for (const task of buildPracticeTasks(subject, lessonTasks, catalog, previousNewRefs, () => 0.25)) {
    addTaskClips(task, "practice");
  }

  // 覆盖整个词库的测试语音，而不是只覆盖「当前已学」。
  // 原因：手机端的小测试范围由本机学习记录推导（app-mobile 的 analysis.mergeCatalogProgress），
  // 只要孩子在本机答过某个字，它就可能成为测试题目；而手机不需要电脑开机，
  // 无法在打包时知道哪些字将来会进入测试。只覆盖已学内容会让测试题和示范句
  // 回退到手机自带的系统机器音，因此这里按整个词库准备语音。
  const learnedItems = catalog[subject] || [];
  const testVariants = subject === "hanzi"
    ? [
        buildTestTasks(subject, learnedItems, catalog, () => 0.25, learnedItems.length, { hanziOralReadingPercent: 0 }),
        buildTestTasks(subject, learnedItems, catalog, () => 0.25, learnedItems.length, { hanziOralReadingPercent: 100 })
      ]
    : [buildTestTasks(subject, learnedItems, catalog, () => 0.25, learnedItems.length)];
  for (const task of testVariants.flat()) {
    addTaskClips(task, "test");
  }
}

// 手动导入可安排任意后续字母，提前覆盖全部标准预习，避免推进到新字母时缺音。
for (const item of catalog.english_letter || []) {
  for (const task of buildPreviewTasks("english_letter", [], catalog, [item.ref], 1)) {
    addTaskClips(task, "preview");
  }
}

const mathCatalog = (await loadJson(path.join(dataDir, "catalog", "数学启蒙课程.json")))
  .map(item => {
    const stateItem = state.items?.math?.[item.ref];
    return {
      ...item,
      display: item.value,
      status: stateItem?.status || "未学",
      lastSeenAt: stateItem?.lastSeenAt || null,
      incorrectCount: stateItem?.metrics?.incorrectCount || 0
    };
  });
for (const task of buildAllMathVoiceTasks(mathCatalog)) addTaskClips(task, "lesson");

const outputDir = path.join(dataDir, "audio", "voice-pack");
await mkdir(outputDir, { recursive: true });
const jobsPath = path.join(outputDir, "edge-tts-jobs.json");
const manifestPath = path.join(outputDir, "manifest.json");

async function auditVoicePack(candidate) {
  const manifest = candidate || await loadJson(manifestPath);
  const missingTexts = [];
  const invalidClips = [];
  for (const text of clips.keys()) {
    const clip = manifest?.clips?.[text];
    if (!clip) {
      missingTexts.push(text);
      continue;
    }
    const expected = clips.get(text);
    if (["voice", "rate", "pitch", "volume"].some(field => clip[field] !== expected[field])
        || !clip.fileName?.endsWith(".mp3") || path.basename(clip.fileName) !== clip.fileName) {
      invalidClips.push(text);
      continue;
    }
    try {
      const file = await stat(path.join(outputDir, clip.fileName));
      if (!file.isFile() || file.size <= 0) invalidClips.push(text);
    } catch {
      invalidClips.push(text);
    }
  }
  if (missingTexts.length || invalidClips.length) {
    const examples = [...missingTexts, ...invalidClips].slice(0, 4).join("；");
    throw new Error(`语音覆盖检查失败：缺少 ${missingTexts.length} 条，无效 ${invalidClips.length} 条。${examples}`);
  }
  console.log(`语音覆盖检查通过：${clips.size}/${clips.size} 条均为晓伊自然语音，文件完整非空`);
}

if (process.argv.includes("--audit-only")) {
  await auditVoicePack();
  process.exit(0);
}

await writeFile(jobsPath, `${JSON.stringify({ clips: [...clips.values()] }, null, 2)}\n`, "utf8");

// 四个有限并发的技能批次，各自使用独立清单；全部成功后才替换正式清单。
// 中途失败仍保留旧清单，重跑时复用按文本和语音参数命名的完整 MP3。
const batchDir = path.join(outputDir, ".generation");
await mkdir(batchDir, { recursive: true });
const batches = Array.from({ length: 4 }, () => []);
[...clips.values()].forEach((clip, index) => batches[index % batches.length].push(clip));
console.log(`开始准备 ${clips.size} 条语音，已有文件会复用，最多同时生成 4 条。`);
const results = await Promise.allSettled(batches.map(async (batch, index) => {
  const batchPath = path.join(batchDir, `jobs-${index}.json`);
  const batchManifest = path.join(batchDir, `manifest-${index}.json`);
  await writeFile(batchPath, JSON.stringify({ clips: batch }), "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(python, [skillScript, "--batch-json", batchPath, "--output-dir", outputDir, "--manifest", batchManifest], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }
    });
    let errorText = "";
    let lineBuffer = "";
    let done = 0;
    child.stderr.on("data", data => { errorText = (errorText + data.toString()).slice(-8000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => {
      lineBuffer += data;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("已完成 ")) {
          done += 1;
          if (done % 40 === 0) console.log(`语音批次 ${index + 1}：${done}/${batch.length}`);
        }
      }
    });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`语音批次 ${index + 1} 失败：${errorText || `退出码 ${code}`}`)));
  });
  console.log(`语音批次 ${index + 1} 已完成：${batch.length} 条`);
  return loadJson(batchManifest);
}));
const failures = results.filter(result => result.status === "rejected");
if (failures.length) throw new AggregateError(failures.map(result => result.reason), "语音包尚未完成，保留了原有清单。可以重跑继续生成。");
const manifests = results.map(result => result.value);
const merged = { ...manifests[0], clips: Object.assign({}, ...manifests.map(manifest => manifest.clips)) };
// 已有的非当前课程语音仍可供回滚程序使用；只保留本地仍存在的有效文件。
const previousManifest = await loadOptionalJson(manifestPath);
for (const [text, clip] of Object.entries(previousManifest?.clips || {})) {
  if (merged.clips[text] || !clip?.fileName || path.basename(clip.fileName) !== clip.fileName
      || !clip.fileName.endsWith(".mp3")) continue;
  try {
    const file = await stat(path.join(outputDir, clip.fileName));
    if (file.isFile() && file.size > 0) merged.clips[text] = clip;
  } catch { /* 过期或缺失的旧语音不写入新清单。 */ }
}
await auditVoicePack(merged);
const temporaryManifest = `${manifestPath}.tmp`;
await writeFile(temporaryManifest, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
await rename(temporaryManifest, manifestPath);
console.log(`小芽 Edge-TTS 语音包已完成：${clips.size} 条`);
