import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!["mobile", "desktop"].includes(target)) throw new Error("Specify mobile or desktop");
const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const payload = { repository: "https://github.com/YU-xiaolin/xiaoya", commit, target, builtAt: new Date().toISOString() };
const destination = target === "mobile" ? "../app-mobile/dist/build-info.json" : "../app-source/src-tauri/target/release/build-info-desktop.json";
await writeFile(new URL(destination, import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);
