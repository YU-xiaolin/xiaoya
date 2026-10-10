// 把 Windows 端 app-source/src 中的教学逻辑模块同步到手机端 app-mobile/src/core。
// 单一事实源仍是 app-source/src；本脚本复制并写入哈希清单，用于检测漂移。
// 不修改 app-source，不影响 Windows 构建。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sourceDir = path.join(projectRoot, "app-source", "src");
const targetDir = path.join(projectRoot, "app-mobile", "src", "core");

// 只同步与平台无关的纯教学逻辑。main.js 依赖 Tauri，不在此列。
export const SHARED_MODULES = Object.freeze([
  "protocol.js",
  "speech-player.js",
  "composition-board.js",
  "hanzi-hints.js",
  "natural-hints.js",
  "targeted-hints.js",
  "voice-text.js",
  "math-mode.js",
  "test-mode.js"
]);

async function sha256(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

if (process.argv.includes("--check")) {
  const manifestPath = path.join(targetDir, "core-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const drifted = [];
  for (const name of SHARED_MODULES) {
    const sourceHash = await sha256(path.join(sourceDir, name));
    if (manifest.modules[name]?.sha256 !== sourceHash) drifted.push(name);
  }
  if (drifted.length) {
    console.error(`共用核心已漂移：${drifted.join("、")}。请运行 node tools/sync-core.mjs 重新同步。`);
    process.exit(1);
  }
  console.log(`共用核心一致：${SHARED_MODULES.length}/${SHARED_MODULES.length}`);
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });
const modules = {};
for (const name of SHARED_MODULES) {
  const source = path.join(sourceDir, name);
  await copyFile(source, path.join(targetDir, name));
  modules[name] = { sha256: await sha256(source) };
}
await writeFile(
  path.join(targetDir, "core-manifest.json"),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceDir: "app-source/src",
    note: "本目录由 tools/sync-core.mjs 从 app-source/src 复制生成，请勿手工编辑。",
    modules
  }, null, 2)}\n`,
  "utf8"
);
console.log(`共用核心已同步：${SHARED_MODULES.length} 个模块 -> app-mobile/src/core`);
