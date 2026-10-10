import { syntheticState } from "../../tools/test-fixtures.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildCoursePackage, buildFamilyCoursePackage, assertNoFamilyProgress } from "../../tools/build-course-package.mjs";
import { selectTestItems } from "../src/core/test-mode.js";
import { validatePackagePayload } from "../src/sync.js";

const state = syntheticState();
const lesson = JSON.parse(await readFile(new URL("../../app-source/src-tauri/bootstrap/initial-next-lesson.json", import.meta.url), "utf8"));

test("公开课程构建拒绝带学习场次来源的课程，私有家庭包仍保留来源", () => {
  const privateLesson = { ...lesson, basedOnSessionIds: ["synthetic-private-session"] };
  assert.throws(() => buildCoursePackage({ state, lesson: privateLesson }), /真实学习场次来源/);
  assert.deepEqual(buildFamilyCoursePackage({ state, lesson: privateLesson }).package.lesson.basedOnSessionIds, ["synthetic-private-session"]);
});

test("家庭包保留软件确认的已教待测信息，公开包仍不含家庭进度", () => {
  const input = structuredClone(state);
  const ref = Object.keys(input.items.hanzi)[0];
  input.items.hanzi[ref] = {
    ...input.items.hanzi[ref], status: "初见", parentConfirmedAt: "2026-10-09T09:00:00+08:00",
    needsAssessment: true, lastSeenAt: null,
    metrics: { contactSessionIds: [], independentCorrectSessionIds: [], questionTypes: [], incorrectCount: 0 }
  };
  const before = JSON.stringify(input);
  const family = buildFamilyCoursePackage({ state: input, lesson }).package;
  const item = family.catalog.hanzi.find(item => item.ref === ref);
  assert.equal(family.visibility, "family-private");
  assert.equal(item.status, "初见");
  assert.equal(item.needsAssessment, true);
  assert.equal(item.parentConfirmedAt, "2026-10-09T09:00:00+08:00");
  assert.equal(item.lastSeenAt, null, "家长教过不能伪造作答时间");
  assert.equal(item.incorrectCount, 0);
  assert.ok(selectTestItems(family.catalog, "hanzi", "all").some(item => item.ref === ref), "手机全部内容测试必须包含新增已教字");
  assert.ok(!selectTestItems(family.catalog, "hanzi", "today").some(item => item.ref === ref), "未作答不应伪造今日测试记录");
  assert.deepEqual(validatePackagePayload(family), []);
  assert.equal(JSON.stringify(input), before, "打包不能修改正式状态或作答证据");
  const generic = buildCoursePackage({ state: input, lesson }).package;
  assert.equal(generic.visibility, "public-generic");
  assert.equal(generic.studentCode, undefined);
  assert.deepEqual(assertNoFamilyProgress(generic), []);
});

test("家庭包保留已有掌握等级和错误次数，并按正式状态计算摘要", () => {
  const family = buildFamilyCoursePackage({ state, lesson }).package;
  for (const subject of ["hanzi", "english_letter", "math"]) {
    for (const item of family.catalog[subject]) {
      assert.equal(item.status, state.items[subject][item.ref].status);
      assert.equal(item.incorrectCount, state.items[subject][item.ref].metrics?.incorrectCount || 0);
    }
  }
  assert.equal(family.summary.hanziLearned, selectTestItems(family.catalog, "hanzi", "all").length);
});

test("数据库重排对象字段不改变家庭包摘要，题目顺序和内容变化仍会改变摘要", () => {
  const reverseFields = value => {
    if (Array.isArray(value)) return value.map(reverseFields);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseFields(entry)]));
  };
  const common = { state, generatedAt: "2026-10-09T01:00:00.000Z" };
  const original = buildFamilyCoursePackage({ ...common, lesson });
  const reordered = buildFamilyCoursePackage({ ...common, lesson: reverseFields(lesson) });
  assert.equal(reordered.sha256, original.sha256, "对象字段顺序不是课程内容变化");
  assert.deepEqual(reordered.package, original.package);
  const differentOrder = structuredClone(lesson);
  [differentOrder.tasks[0], differentOrder.tasks[1]] = [differentOrder.tasks[1], differentOrder.tasks[0]];
  assert.notEqual(buildFamilyCoursePackage({ ...common, lesson: differentOrder }).sha256, original.sha256, "数组题序必须参与校验");
  const changedContent = structuredClone(lesson);
  changedContent.tasks[0].target.display = "温";
  assert.notEqual(buildFamilyCoursePackage({ ...common, lesson: changedContent }).sha256, original.sha256, "题目内容必须参与校验");
});
