// 验证手机端复用的教学核心与 Windows 端 app-source/src 完全一致（单一事实源）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const sourceDir = path.join(projectRoot, "app-source", "src");
const coreDir = path.join(projectRoot, "app-mobile", "src", "core");

const sha256 = async filePath =>
  createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();

test("共用核心清单存在且覆盖 9 个教学模块", async () => {
  const manifest = JSON.parse(await readFile(path.join(coreDir, "core-manifest.json"), "utf8"));
  assert.equal(manifest.sourceDir, "app-source/src");
  assert.equal(Object.keys(manifest.modules).length, 9);
  for (const name of ["protocol.js", "test-mode.js", "math-mode.js", "voice-text.js", "targeted-hints.js"]) {
    assert.ok(manifest.modules[name], `清单缺少 ${name}`);
  }
});

test("手机端核心与 Windows 端源码逐字节一致", async () => {
  const manifest = JSON.parse(await readFile(path.join(coreDir, "core-manifest.json"), "utf8"));
  for (const [name, entry] of Object.entries(manifest.modules)) {
    const sourceHash = await sha256(path.join(sourceDir, name));
    const copyHash = await sha256(path.join(coreDir, name));
    assert.equal(copyHash, sourceHash, `${name} 与 Windows 端源码不一致`);
    assert.equal(entry.sha256, sourceHash, `${name} 清单哈希已过期`);
  }
});

test("教学模块不依赖 Tauri", async () => {
  const manifest = JSON.parse(await readFile(path.join(coreDir, "core-manifest.json"), "utf8"));
  for (const name of Object.keys(manifest.modules)) {
    const content = await readFile(path.join(coreDir, name), "utf8");
    assert.ok(!content.includes("@tauri-apps"), `${name} 不应依赖 Tauri`);
  }
});
