// 语音覆盖回归测试：应用会朗读的每一句都必须有晓伊自然语音。
// 之前的语音子集只按「已学内容」裁剪，导致测试题面（例如“找到‘冲’，只要告诉我第几个。”）
// 与部分数学变体没有语音，手机上会回退成系统机器音。这里用运行时同一份枚举做硬约束。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectVoiceTexts, TIER_NAMES } from "../../tools/voice-text-catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, "..");
const voiceDir = path.join(mobileRoot, "public", "voice");

const coursePackage = JSON.parse(await readFile(path.join(mobileRoot, "public", "course", "course-package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(voiceDir, "manifest.json"), "utf8"));

const tiers = collectVoiceTexts({ lesson: coursePackage.lesson, catalog: coursePackage.catalog });

test("语音包覆盖应用会朗读的全部文本", async () => {
  const missing = [];
  for (const [tierIndex, texts] of tiers.entries()) {
    for (const text of texts) {
      if (!manifest.clips?.[text]?.fileName) missing.push({ tier: TIER_NAMES[tierIndex], text });
    }
  }
  assert.equal(
    missing.length,
    0,
    `缺少 ${missing.length} 条语音，这些句子会在手机上回退成系统机器音：\n`
      + missing.slice(0, 10).map(item => `  - [${item.tier}] ${item.text}`).join("\n")
  );
});

test("语音包里的每条音频文件都存在且非空", async () => {
  const broken = [];
  for (const [text, clip] of Object.entries(manifest.clips || {})) {
    assert.match(clip.fileName, /^[A-Za-z0-9._-]+\.mp3$/, `音频文件名不安全：${clip.fileName}`);
    try {
      const info = await stat(path.join(voiceDir, clip.fileName));
      if (!info.isFile() || info.size <= 0) broken.push(text);
    } catch {
      broken.push(text);
    }
  }
  assert.equal(broken.length, 0, `有 ${broken.length} 条语音文件缺失或为空：${broken.slice(0, 5).join("；")}`);
});

test("语音包使用晓伊自然语音而不是设备语音", () => {
  assert.match(String(manifest.provider || ""), /Edge/i);
  const voices = new Set(Object.values(manifest.clips || {}).map(clip => clip.voice));
  assert.deepEqual([...voices], ["zh-CN-XiaoyiNeural"]);
});
