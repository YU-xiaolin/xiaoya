// 从正式数据生成手机端课程包（catalog + summary + lesson）。
//
// 隐私边界（重要）：
//   随应用发布的课程包是**公开静态产物**，任何人都能下载。
//   因此这里只输出「通用课程定义」——编号、字形/字母/数字展示、阶段与顺序等
//   对家庭没有区分度的教学元数据。
//   真实家庭学习进度（status / lastSeenAt / incorrectCount / parentConfirmedAt /
//   needsAssessment 以及按学科的已学计数）一律不写入，改由家长登录后
//   通过云端授权接口下载到该家庭的本机空间。
//
// 目录编号仍完全由正式 state 的 items 派生，不重新发明编号，保证与 Windows 端一致。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const dataDir = process.env.FAMILY_LEARNING_DATA_DIR || path.join(projectRoot, "data");
const outDir = path.join(projectRoot, "app-mobile", "public", "course");

export const COURSE_PACKAGE_PROTOCOL = "XIAOYA_COURSE_PACKAGE_V1";
export const COURSE_PACKAGE_VISIBILITY = "public-generic";

async function readJson(fileName) {
  return JSON.parse(await readFile(fileName, "utf8"));
}

function pick(item, key) {
  return item?.[key] === undefined ? null : item[key];
}

// 只保留通用课程字段。任何与「这个家庭学到哪儿了」有关的字段都在这里被丢弃。
export function catalogFromState(state) {
  const catalogFor = subject => {
    const items = state?.items?.[subject];
    if (!items || typeof items !== "object") return [];
    return Object.entries(items).map(([ref, item]) => {
      const display = typeof item?.value === "string" ? item.value : ref;
      const optionDisplay = subject === "english_letter" && typeof item?.uppercase === "string"
        ? item.uppercase
        : display;
      return {
        ref,
        display,
        optionDisplay,
        association: pick(item, "association"),
        stage: pick(item, "stage"),
        stageName: pick(item, "stageName"),
        order: pick(item, "order"),
        kind: pick(item, "kind"),
        number: pick(item, "number"),
        level: pick(item, "level")
      };
    });
  };
  return {
    hanzi: catalogFor("hanzi"),
    english_letter: catalogFor("english_letter"),
    math: catalogFor("math")
  };
}

// 摘要只包含「课程规模」，不含任何已学/待评估计数。
export function summaryFromState(state) {
  const total = subject => Object.keys(state?.items?.[subject] || {}).length;
  return {
    hanziTotal: total("hanzi"),
    letterTotal: total("english_letter"),
    mathTotal: total("math"),
    formalItemCount: ["hanzi", "english_letter", "math"].reduce((sum, subject) => sum + total(subject), 0)
  };
}

// 发布前自检：静态产物里不允许出现家庭进度字段。
const FORBIDDEN_FAMILY_FIELDS = [
  "status", "lastSeenAt", "incorrectCount", "parentConfirmedAt", "needsAssessment",
  "hanziLearned", "letterLearned", "mathLearned",
  "hanziNeedsAssessment", "letterNeedsAssessment", "mathNeedsAssessment"
];

export function assertNoFamilyProgress(payload) {
  const problems = [];
  if (payload?.lesson?.basedOnSessionIds?.length) {
    problems.push("lesson 含真实学习场次来源；公开包只能使用通用课程");
  }
  for (const subject of ["hanzi", "english_letter", "math"]) {
    for (const item of payload?.catalog?.[subject] || []) {
      for (const field of FORBIDDEN_FAMILY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(item, field)) {
          problems.push(`catalog.${subject}.${item.ref} 含家庭进度字段 ${field}`);
        }
      }
    }
  }
  for (const field of FORBIDDEN_FAMILY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload?.summary || {}, field)) {
      problems.push(`summary 含家庭进度字段 ${field}`);
    }
  }
  return problems;
}

export function buildCoursePackage({ state, lesson, generatedAt = new Date().toISOString(), source = "build-script" }) {
  const catalog = catalogFromState(state);
  const summary = summaryFromState(state);
  const payload = {
    protocol: COURSE_PACKAGE_PROTOCOL,
    schemaVersion: 1,
    generatedAt,
    visibility: COURSE_PACKAGE_VISIBILITY,
    source,
    catalog,
    summary,
    lesson: lesson || null
  };
  const problems = assertNoFamilyProgress(payload);
  if (problems.length) {
    throw new Error(`课程包含家庭进度字段，已阻止发布：${problems[0]}`);
  }
  const canonical = JSON.stringify(payload);
  return {
    package: payload,
    sha256: createHash("sha256").update(canonical).digest("hex").toUpperCase()
  };
}

// 仅供已登录家庭账号的私有云表和本地导入文件使用，绝不能写进 public/dist。
// 正式状态由小芽软件校验维护；此处只读同步，不生成学习证据。
// 现网 0.3.0 使用 JSON.stringify 核验摘要，因此导入包须先使用云数据库
// JSONB 的对象键顺序：UTF-8 字节长度优先，同长度按字节排序；数组顺序不变。
// 只调整传输对象的字段顺序，不能跳过摘要校验，也不修改正式状态。
export function cloudJsonOrder(value) {
  if (Array.isArray(value)) return value.map(cloudJsonOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => {
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");
    return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
  }).map(key => [key, cloudJsonOrder(value[key])]));
}

export function buildFamilyCoursePackage({ state, lesson, studentCode = "student-01", generatedAt = new Date().toISOString(), source = "windows-pc" }) {
  const catalog = catalogFromState(state);
  const summary = summaryFromState(state);
  for (const subject of ["hanzi", "english_letter", "math"]) {
    for (const entry of catalog[subject]) {
      const item = state.items[subject][entry.ref];
      entry.status = item.status;
      entry.lastSeenAt = item.lastSeenAt || item.metrics?.lastSeenAt || null;
      entry.nextReviewAt = item.nextReviewAt || null;
      entry.incorrectCount = item.metrics?.incorrectCount || 0;
      entry.parentConfirmedAt = item.parentConfirmedAt || null;
      entry.needsAssessment = item.needsAssessment === true;
    }
    const prefix = subject === "hanzi" ? "hanzi" : subject === "math" ? "math" : "letter";
    summary[`${prefix}Learned`] = catalog[subject].filter(item => item.status && item.status !== "未学").length;
    summary[`${prefix}NeedsAssessment`] = catalog[subject].filter(item => item.needsAssessment).length;
  }
  const payload = cloudJsonOrder({
    protocol: COURSE_PACKAGE_PROTOCOL, schemaVersion: 1, generatedAt,
    visibility: "family-private", studentCode, source, catalog, summary, lesson: lesson || null
  });
  return {
    package: payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase()
  };
}

async function main() {
  const state = await readJson(path.join(dataDir, "state", "learning-state.json"));
  const lesson = await readJson(path.join(projectRoot, "app-source", "src-tauri", "bootstrap", "initial-next-lesson.json"));
  const { package: pkg, sha256 } = buildCoursePackage({ state, lesson, source: "formal-data-snapshot" });

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "course-package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(outDir, "course-package.meta.json"),
    `${JSON.stringify({
      protocol: pkg.protocol,
      schemaVersion: pkg.schemaVersion,
      generatedAt: pkg.generatedAt,
      visibility: pkg.visibility,
      sha256,
      counts: {
        hanzi: pkg.catalog.hanzi.length,
        english_letter: pkg.catalog.english_letter.length,
        math: pkg.catalog.math.length,
        lessonTasks: pkg.lesson?.tasks?.length || 0
      }
    }, null, 2)}\n`,
    "utf8"
  );
  console.log(`课程包已生成（通用课程定义，不含家庭进度）：汉字 ${pkg.catalog.hanzi.length}、字母 ${pkg.catalog.english_letter.length}、数学 ${pkg.catalog.math.length}、课程题 ${pkg.lesson?.tasks?.length || 0}`);
  console.log(`sha256=${sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
