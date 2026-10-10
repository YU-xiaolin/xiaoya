// 小芽家庭学习 · PC 端云同步助手（只读正式数据，不修改任何正式文件）。
//
// 用途：补齐「电脑 ↔ 云端」两个方向，Windows 端软件本身不需要改动：
//   node tools/xiaoya-cloud-sync.mjs --push-course
//       读取正式 data/state 与 data/ai/next-lesson.json，生成课程包并发布为云端新版本，
//       手机随后点击「更新学习课程」即可拿到。
//   node tools/xiaoya-cloud-sync.mjs --pull-records [--since=YYYY-MM-DD]
//       从云端下载手机上传的学习记录，导出为 JSON 记录包到 output/cloud-pull-<时间>/。
//       不会写入 data/raw/sessions（该目录只由软件追加）。
//
// 登录方式：环境变量 XIAOYA_EMAIL / XIAOYA_PASSWORD（邮箱 + 密码）。
// 没有邮箱密码时，请直接使用「家长管理网页」的导入/导出功能，效果相同。
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { buildFamilyCoursePackage } from "../../tools/build-course-package.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const dataDir = process.env.FAMILY_LEARNING_DATA_DIR || path.join(projectRoot, "data");
const outRoot = path.join(projectRoot, "output");

const ENDPOINT = process.env.XIAOYA_ENDPOINT || "https://xiaoya-learning.app.workbuddy.host";
const PUBLISHABLE_KEY = process.env.XIAOYA_PUBLISHABLE_KEY
  || "wbpk_GmOXzpfOUNz2OjF2Hyvdj9_B4A2hcHXU4KX4cvUwf1QLoHRx9OsNC51";
const EMAIL = process.env.XIAOYA_EMAIL;
const PASSWORD = process.env.XIAOYA_PASSWORD;
const COURSE_KEY = "family-package";
const STUDENT_CODE = process.env.XIAOYA_STUDENT_CODE || "student-01";

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sha256HexSync(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  publishableKey: PUBLISHABLE_KEY,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth"
});

async function signIn() {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "缺少登录信息。请设置环境变量 XIAOYA_EMAIL 与 XIAOYA_PASSWORD 后重试；"
      + "或者直接使用家长管理网页的「导入课程 / 导出记录」功能。"
    );
  }
  const { error } = await cloud.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`登录失败：${error.message || error}`);
  console.log(`已登录：${EMAIL.replace(/^(.).*(@.*)$/, "$1***$2")}`);
}

async function pushCourse() {
  const state = JSON.parse(await readFile(path.join(dataDir, "state", "learning-state.json"), "utf8"));
  const lesson = JSON.parse(await readFile(path.join(dataDir, "ai", "next-lesson.json"), "utf8"));
  const { package: pkg, sha256 } = buildFamilyCoursePackage({ state, lesson, source: "windows-pc", studentCode: STUDENT_CODE });

  await signIn();

  const existing = await cloud.database
    .from("xiaoya_course_versions")
    .select("version")
    .eq("course_key", COURSE_KEY)
    .order("version", { ascending: false })
    .limit(1);
  if (existing.error) throw new Error(`读取云端版本失败：${existing.error.message}`);
  const version = (existing.data?.[0]?.version || 0) + 1;

  const inserted = await cloud.database.from("xiaoya_course_versions").upsert({
    course_key: COURSE_KEY,
    version,
    subject: lesson?.tasks?.[0]?.subject || null,
    title: lesson?.title || `课程包第 ${version} 版`,
    generated_at: pkg.generatedAt,
    source: "windows-pc",
    payload: pkg,
    payload_sha256: sha256,
    is_active: false
  }, { onConflict: "owner_id,course_key,version" });
  if (inserted.error) throw new Error(`写入课程失败：${inserted.error.message}`);

  const off = await cloud.database.from("xiaoya_course_versions")
    .update({ is_active: false }).eq("course_key", COURSE_KEY).eq("is_active", true).select("version");
  if (off.error) throw new Error(`停用旧版本失败：${off.error.message}`);

  const on = await cloud.database.from("xiaoya_course_versions")
    .update({ is_active: true }).eq("course_key", COURSE_KEY).eq("version", version).select("version");
  if (on.error) throw new Error(`启用新版本失败：${on.error.message}`);
  if (!on.data?.length) throw new Error("没有找到刚写入的版本，发布未生效。");

  const snapshot = await cloud.database.from("xiaoya_catalog_snapshots").insert({
    student_code: STUDENT_CODE,
    summary: pkg.summary,
    catalog: pkg.catalog,
    catalog_sha256: sha256HexSync(JSON.stringify(pkg.catalog)),
    source: "windows-pc"
  });
  if (snapshot.error) console.warn(`目录快照未写入（不影响课程发布）：${snapshot.error.message}`);

  const dir = path.join(outRoot, `cloud-push-${timestamp()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "course-package.meta.json"), `${JSON.stringify({
    version, sha256, generatedAt: pkg.generatedAt, lessonId: lesson?.lessonId,
    lessonTasks: lesson?.tasks?.length || 0,
    counts: { hanzi: pkg.catalog.hanzi.length, english_letter: pkg.catalog.english_letter.length, math: pkg.catalog.math.length }
  }, null, 2)}\n`, "utf8");

  console.log(`已发布课程第 ${version} 版（${lesson?.tasks?.length || 0} 道题）。手机端点击「更新学习课程」即可获取。`);
  console.log(`本地留档：${dir}`);
}

async function pullRecords() {
  const sinceArgument = process.argv.find(argument => argument.startsWith("--since="));
  const since = sinceArgument ? new Date(`${sinceArgument.slice("--since=".length)}T00:00:00`).toISOString() : null;

  await signIn();

  let query = cloud.database
    .from("xiaoya_sessions")
    .select("session_id,student_code,device_code,lesson_id,activity_mode,started_at,ended_at,completed,stop_reason,event_count,payload,payload_sha256,uploaded_at")
    .order("uploaded_at", { ascending: true })
    .limit(2000);
  if (since) query = query.gt("uploaded_at", since);
  const { data, error } = await query;
  if (error) throw new Error(`读取云端记录失败：${error.message}`);

  const rows = data || [];
  const bundle = {
    protocol: "XIAOYA_RECORD_BUNDLE_V1",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: "cloud",
    since,
    studentCode: STUDENT_CODE,
    sessionCount: rows.length,
    sessions: rows.map(row => row.payload).filter(Boolean)
  };
  const dir = path.join(outRoot, `cloud-pull-${timestamp()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "records.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "records.index.json"), `${JSON.stringify(rows.map(row => ({
    session_id: row.session_id,
    student_code: row.student_code,
    device_code: row.device_code,
    activity_mode: row.activity_mode,
    ended_at: row.ended_at,
    event_count: row.event_count
  })), null, 2)}\n`, "utf8");

  console.log(`已下载云端 ${rows.length} 份学习记录。`);
  console.log(`记录包：${path.join(dir, "records.json")}`);
  console.log("注意：没有写入 data/raw/sessions（该目录只由小芽软件追加）。");
}

async function main() {
  const wantPush = process.argv.includes("--push-course");
  const wantPull = process.argv.includes("--pull-records");
  if (!wantPush && !wantPull) {
    console.log("用法：");
    console.log("  node app-mobile/scripts/cloud-sync.mjs --push-course");
    console.log("  node app-mobile/scripts/cloud-sync.mjs --pull-records [--since=YYYY-MM-DD]");
    return;
  }
  if (wantPush) await pushCourse();
  if (wantPull) await pullRecords();
}

try {
  await main();
} catch (error) {
  console.error(`\n未完成：${error?.message || error}`);
  process.exitCode = 1;
}
