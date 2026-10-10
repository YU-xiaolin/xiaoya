// 本地课程与身份信息。
// 学习记录只写 IndexedDB；云端只在用户点击“上传学习记录”时写入。
import { APP_VERSION, DEFAULT_STUDENT_CODE, PROTOCOLS } from "./config.js";
import { getMeta, setMeta, putPackage, getPackage, appendLog } from "./db.js";

const META_KEYS = Object.freeze({
  deviceCode: "deviceCode",
  studentCode: "studentCode",
  packageVersion: "packageVersion",
  packageReceivedAt: "packageReceivedAt",
  lastUploadAt: "lastUploadAt"
});

function randomCode(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 12)}`;
}

export async function deviceCode() {
  let code = await getMeta(META_KEYS.deviceCode);
  if (!code) {
    code = randomCode("dev");
    await setMeta(META_KEYS.deviceCode, code);
  }
  return code;
}

export async function studentCode() {
  const code = await getMeta(META_KEYS.studentCode);
  return code || DEFAULT_STUDENT_CODE;
}

export async function setStudentCode(code) {
  const normalized = String(code || "").trim() || DEFAULT_STUDENT_CODE;
  await setMeta(META_KEYS.studentCode, normalized);
  return normalized;
}

export function detectPlatform() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh/i.test(ua)) return "macos";
  return "web";
}

export async function sha256Hex(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/* ---------------- 课程包 ---------------- */

export const ACTIVE_PACKAGE_KEY = "active";
// 上一次替换前的课程包，用于校验失败/写入失败时回滚。
export const ROLLBACK_PACKAGE_KEY = "rollback";

// 首次启动：读取随应用发布的课程包（由 tools/build-course-package.mjs 从正式数据生成）。
export async function ensureBundledPackage() {
  const current = await getPackage(ACTIVE_PACKAGE_KEY);
  if (current) return current;
  const response = await fetch("./course/course-package.json", { cache: "force-cache" });
  if (!response.ok) throw new Error("内置课程包不可用，请联网后点击“更新学习课程”。");
  const payload = await response.json();
  const expected = await sha256Hex(JSON.stringify(payload));
  const record = {
    key: ACTIVE_PACKAGE_KEY,
    package: payload,
    sha256: expected,
    receivedAt: new Date().toISOString(),
    source: "bundled"
  };
  await putPackage(ACTIVE_PACKAGE_KEY, record);
  await setMeta(META_KEYS.packageVersion, 0);
  await setMeta(META_KEYS.packageReceivedAt, record.receivedAt);
  return record;
}

export async function loadActivePackage() {
  return (await getPackage(ACTIVE_PACKAGE_KEY)) || ensureBundledPackage();
}

export async function saveActivePackage(record) {
  await putPackage(ACTIVE_PACKAGE_KEY, record);
  await setMeta(META_KEYS.packageVersion, record.version ?? 0);
  await setMeta(META_KEYS.packageReceivedAt, record.receivedAt);
  await appendLog({ type: "package", action: "apply", source: record.source, version: record.version ?? 0, sha256: record.sha256 });
  return record;
}

export async function packageInfo() {
  const record = await loadActivePackage();
  return {
    source: record.source,
    version: await getMeta(META_KEYS.packageVersion, 0),
    receivedAt: record.receivedAt,
    sha256: record.sha256,
    lessonId: record.package?.lesson?.lessonId || null,
    generatedAt: record.package?.generatedAt || null
  };
}

/* ---------------- 会话校验 ---------------- */

// 与 Windows 端 app-source/src/protocol.js 的 newSession 保持一致，便于两端合并。
export function newSession(lesson) {
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    protocol: PROTOCOLS.session,
    schemaVersion: 1,
    sessionId: `session-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${suffix}`,
    lessonId: lesson.lessonId,
    basedOnLessonGeneratedAt: lesson.generatedAt,
    startedAt: now,
    endedAt: null,
    completed: false,
    stopReason: null,
    events: []
  };
}

export { APP_VERSION };
