// 验证随应用发布的课程包：协议、数量、目录结构，以及课程本身能通过教学核心的课程校验。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLesson } from "../src/core/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.resolve(here, "..", "public", "course", "course-package.json");
const metaPath = path.resolve(here, "..", "public", "course", "course-package.meta.json");

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const meta = JSON.parse(await readFile(metaPath, "utf8"));

test("课程包协议与版本正确，且为不含家庭进度的公开产物", () => {
  assert.equal(pkg.protocol, "XIAOYA_COURSE_PACKAGE_V1");
  assert.equal(pkg.schemaVersion, 1);
  assert.ok(pkg.generatedAt);
  assert.equal(pkg.visibility, "public-generic");
  assert.equal(pkg.studentCode, undefined, "公开包不应带学生编号");
});

test("目录数量与 Windows 端正式状态一致", () => {
  assert.equal(pkg.catalog.hanzi.length, 1000);
  assert.equal(pkg.catalog.english_letter.length, 26);
  assert.equal(pkg.catalog.math.length, 35);
  assert.equal(meta.counts.hanzi, 1000);
  assert.equal(meta.counts.english_letter, 26);
  assert.equal(meta.counts.math, 35);
  assert.equal(meta.counts.lessonTasks, pkg.lesson.tasks.length);
});

test("目录条目字段完整且编号唯一，且不含家庭进度字段", () => {
  const forbidden = ["status", "lastSeenAt", "incorrectCount", "parentConfirmedAt", "needsAssessment"];
  for (const subject of ["hanzi", "english_letter", "math"]) {
    const refs = new Set();
    for (const item of pkg.catalog[subject]) {
      assert.equal(typeof item.ref, "string");
      assert.ok(item.ref.length > 0, `${subject} 存在空 ref`);
      assert.ok(!refs.has(item.ref), `${subject} 编号重复：${item.ref}`);
      refs.add(item.ref);
      assert.equal(typeof item.display, "string");
      for (const field of forbidden) {
        assert.equal(field in item, false, `catalog.${subject}.${item.ref} 不应含家庭进度字段 ${field}`);
      }
    }
  }
});

test("字母目录保留大写选项显示", () => {
  const sample = pkg.catalog.english_letter.find(item => item.ref === "AL-01");
  assert.ok(sample, "缺少字母 AL-01");
  assert.equal(sample.optionDisplay, "A");
  assert.equal(sample.display, "A a");
});

test("课程通过教学核心的课程校验", () => {
  const errors = validateLesson(pkg.lesson);
  assert.deepEqual(errors, []);
});

test("摘要只含课程规模，不含任何已学计数", () => {
  assert.equal(pkg.summary.hanziTotal, pkg.catalog.hanzi.length);
  assert.equal(pkg.summary.letterTotal, pkg.catalog.english_letter.length);
  assert.equal(pkg.summary.mathTotal, pkg.catalog.math.length);
  assert.equal(pkg.summary.formalItemCount, 1061);
  for (const field of ["hanziLearned", "letterLearned", "mathLearned", "hanziNeedsAssessment", "letterNeedsAssessment", "mathNeedsAssessment"]) {
    assert.equal(field in pkg.summary, false, `summary 不应含 ${field}`);
  }
});
