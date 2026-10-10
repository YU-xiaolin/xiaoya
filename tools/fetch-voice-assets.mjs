// Teaching audio is a public build asset, not source code or family progress.
// Pin every file to its checked-in SHA-256 so a remote change cannot enter a release.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "tools", "voice-assets.json"), "utf8"));
const target = path.join(root, "app-mobile", "public", "voice");
const from = process.argv.find(value => value.startsWith("--from-dir="))?.slice(11);
await mkdir(target, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const entries = Object.entries(lock.files);
let cursor = 0;
let completed = 0;
async function worker() {
  while (cursor < entries.length) {
    const [name, expected] = entries[cursor++];
    if (!/^[a-f0-9]+\.mp3$/.test(name)) throw new Error(`Unsafe audio filename: ${name}`);
    const destination = path.join(target, name);
    try {
      const current = await readFile(destination);
      if (current.length === expected.bytes && digest(current) === expected.sha256) { completed++; continue; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    let bytes;
    if (from) {
      bytes = await readFile(path.join(path.resolve(from), name));
    } else {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const response = await fetch(new URL(name, lock.source), { signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${name}`);
          bytes = Buffer.from(await response.arrayBuffer());
          break;
        } catch (error) {
          if (attempt === 7) throw error;
          console.warn(`Retrying audio ${name}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2000 * 2 ** attempt)));
        }
      }
    }
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error(`Audio integrity mismatch: ${name}`);
    await writeFile(destination, bytes);
    completed++;
    if (completed % 500 === 0) console.log(`Verified audio ${completed}/${entries.length}`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log(`Verified audio ${completed}/${entries.length}`);
