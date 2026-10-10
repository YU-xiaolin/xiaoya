import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertNoFamilyProgress } from "./build-course-package.mjs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("app-mobile/public/course/course-package.json", root), "utf8"));
const meta = JSON.parse(await readFile(new URL("app-mobile/public/course/course-package.meta.json", root), "utf8"));
assert.equal(pkg.visibility, "public-generic");
assert.equal(pkg.studentCode, undefined);
assert.deepEqual(assertNoFamilyProgress(pkg), []);
assert.deepEqual(pkg.lesson.basedOnSessionIds, []);
assert.equal(pkg.lesson.lessonId, "lesson-bootstrap-001");
assert.equal(meta.sha256, createHash("sha256").update(JSON.stringify(pkg)).digest("hex").toUpperCase());
for (const privatePath of ["data", "output", "PROJECT_HANDOFF.md", "reference-archive"]) {
  await assert.rejects(access(new URL(privatePath, root)), { code: "ENOENT" });
}
console.log("Public source boundary verified; no runtime data, real-session provenance or family progress.");
