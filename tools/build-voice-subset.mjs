// 为手机端裁剪晓伊自然语音包。
// 文本枚举来自 tools/voice-text-catalog.mjs（与覆盖率校验、单元测试共用同一份逻辑），
// 默认「全量收录」：应用会朗读的每一句都必须有晓伊语音，避免回退到设备机器音。
// 需要控制体积时可显式传 --max-mb=N，此时按优先级从低到高舍弃并在报告里列出被舍弃的文本。
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectVoiceTexts, TIER_NAMES } from "./voice-text-catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const dataDir = process.env.FAMILY_LEARNING_DATA_DIR || path.join(projectRoot, "data");
const voiceDir = path.join(dataDir, "audio", "voice-pack");
const targetDir = path.join(projectRoot, "app-mobile", "public", "voice");
const reportDir = path.join(projectRoot, "output", "work-20261010-0930-mobile-bugfix");

// 默认不设体积上限：宁可多带几个文件，也不让孩子的某一句话变成系统机器音。
// 需要限制体积时显式传 --max-mb=N（N>0）。
const maxMbArgument = process.argv.find(argument => argument.startsWith("--max-mb="));
const maxMb = maxMbArgument ? Number(maxMbArgument.slice("--max-mb=".length)) : 0;
const MAX_BYTES = Number.isFinite(maxMb) && maxMb > 0 ? Math.round(maxMb * 1024 * 1024) : Infinity;

if (!existsSync(path.join(voiceDir, "manifest.json"))) {
  throw new Error(`没有找到语音包清单：${path.join(voiceDir, "manifest.json")}`);
}

const manifest = JSON.parse(await readFile(path.join(voiceDir, "manifest.json"), "utf8"));
const packagePath = path.join(projectRoot, "app-mobile", "public", "course", "course-package.json");
const coursePackage = JSON.parse(await readFile(packagePath, "utf8"));

const tiers = collectVoiceTexts({ lesson: coursePackage.lesson, catalog: coursePackage.catalog });

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const clips = {};
let totalBytes = 0;
let copied = 0;
const skipped = [];

outer:
for (const [tierIndex, texts] of tiers.entries()) {
  for (const text of texts) {
    const clip = manifest.clips?.[text];
    if (!clip?.fileName) { skipped.push({ text, reason: "清单中缺少该文本", tier: tierIndex }); continue; }
    const sourcePath = path.join(voiceDir, clip.fileName);
    let info;
    try { info = await stat(sourcePath); } catch { skipped.push({ text, reason: "语音文件缺失", tier: tierIndex }); continue; }
    if (!info.isFile() || info.size <= 0) { skipped.push({ text, reason: "语音文件为空", tier: tierIndex }); continue; }
    if (totalBytes + info.size > MAX_BYTES) {
      skipped.push({ text, reason: "超出体积上限", tier: tierIndex });
      continue;
    }
    // 同一段文本可能共用同一个音频文件，复制一次即可（重复复制开销很小，保持逻辑简单）。
    await copyFile(sourcePath, path.join(targetDir, clip.fileName));
    clips[text] = { fileName: clip.fileName, voice: clip.voice, rate: clip.rate, volume: clip.volume, pitch: clip.pitch };
    totalBytes += info.size;
    copied += 1;
  }
}

const limited = Number.isFinite(MAX_BYTES);
const trimmed = {
  schemaVersion: 1,
  provider: manifest.provider,
  source: "小芽家庭学习 手机版语音包",
  note: limited
    ? `按优先级裁剪，上限 ${(MAX_BYTES / 1024 / 1024).toFixed(1)}MB；未收录的文本在手机上会使用设备自带中文语音。`
    : "收录应用会朗读的全部文本，均使用晓伊自然语音（Microsoft Edge TTS）。",
  generatedAt: new Date().toISOString(),
  clipCount: copied,
  clips
};
await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");

const report = {
  at: trimmed.generatedAt,
  maxBytes: limited ? MAX_BYTES : null,
  copied,
  totalBytes,
  totalMb: Number((totalBytes / 1024 / 1024).toFixed(2)),
  skippedCount: skipped.length,
  skippedByTier: skipped.reduce((accumulator, item) => {
    const key = `tier-${item.tier ?? "?"}`;
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {}),
  skippedSample: skipped.slice(0, 20),
  tierTotals: tiers.map((texts, index) => ({ tier: index, name: TIER_NAMES[index], texts: texts.length }))
};
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "voice-subset-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`已收录 ${copied} 条语音，共 ${report.totalMb}MB${limited ? `（上限 ${(MAX_BYTES / 1024 / 1024).toFixed(1)}MB）` : "（全量）"}，跳过 ${skipped.length} 条。`);
console.log(`各优先级文本数：${report.tierTotals.map(item => `tier${item.tier}=${item.texts}`).join(" ")}`);
if (skipped.length) {
  console.warn(`⚠️ 仍有 ${skipped.length} 条文本没有晓伊语音，会在手机上回退设备机器音。`);
  for (const item of skipped.slice(0, 10)) console.warn(`   - [${item.reason}] ${item.text}`);
  process.exitCode = 1;
}
