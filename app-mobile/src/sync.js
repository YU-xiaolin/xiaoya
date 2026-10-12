// 同步层：两个核心按钮 + 课程版本管理。
// 原则：本地记录优先；服务端确认后才标记已同步；重复点击不产生重复数据。
import * as cloudApi from "./cloud.js";
import { APP_VERSION, PROTOCOLS, DEFAULT_STUDENT_CODE } from "./config.js";
import {
  appendLog, countSessions, listSessions, markSessionsUploaded, putSession, getSession as getLocalSession,
  putPackage, getPackage
} from "./db.js";
import {
  deviceCode, detectPlatform, loadActivePackage, saveActivePackage, sha256Hex, studentCode,
  ROLLBACK_PACKAGE_KEY, canonicalJson
} from "./store.js";
import { validateLesson } from "./core/protocol.js";

export const FAMILY_PACKAGE_KEY = "family-package";

export class SyncError extends Error {
  constructor(message, kind = "unknown") {
    super(message);
    this.name = "SyncError";
    this.kind = kind;
  }
}

export async function currentSession() {
  const { session, error } = await cloudApi.getSession();
  if (error) return null;
  return session || null;
}

export async function requireSignedIn() {
  const session = await currentSession();
  if (!session) throw new SyncError("请先登录家庭账号后再同步。", "unauthenticated");
  return session;
}

// 登录方式与账号标识：只用于界面展示，不落库、不写日志。
// 云端 5 张表按账号隔离（RLS：只能读写自己账号的行），不同登录方式会建成不同账号，
// 所以界面必须让家长一眼看出"现在登的是哪个账号、用哪种方式登的"。
const OAUTH_PROVIDER_LABELS = Object.freeze({
  wechat: "微信账号",
  workbuddy: "WorkBuddy 账号"
});

function maskPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 7) return String(phone);
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function maskEmail(email) {
  const text = String(email);
  const at = text.lastIndexOf("@");
  if (at <= 0) return text;
  return `${text.slice(0, 1)}***${text.slice(at)}`;
}

// 返回字符串，但内部区分了"用什么方式登录"：
//   手机号 138****1234 / 邮箱 a***@b.com / 微信账号（未绑定手机号）/ WorkBuddy 账号（未绑定手机号）/ 已登录（未绑定手机号）
export function accountLabel(session) {
  const user = session?.user || {};
  const provider = String(user.provider || "").toLowerCase();
  const providerLabel = OAUTH_PROVIDER_LABELS[provider] || null;
  if (user.phone) return `手机号 ${maskPhone(user.phone)}`;
  if (user.email) return `邮箱 ${maskEmail(user.email)}`;
  if (providerLabel) return `${providerLabel}（未绑定手机号）`;
  if (user.name) return `${user.name}（未绑定手机号）`;
  return "已登录（未绑定手机号）";
}

// 会话对象非空 ≠ 会话还能用。服务端对被判为"未登录"的请求是「返回 0 行、不报错」，
// 所以"读不到云端数据"必须回头确认登录态，不能直接当成"云端没有数据"。
export async function sessionIsLive() {
  try {
    const { user, error } = await cloudApi.getUser();
    if (error) return { live: false, user: null, error };
    return { live: Boolean(user), user: user || null, error: null };
  } catch (error) {
    return { live: false, user: null, error };
  }
}

// 云端读不到生效课程时，给出能直接照做的原因判断，而不是一律说"家长还没发布"。
async function describeMissingCloudCourse() {
  const { live, user } = await sessionIsLive();
  if (!live) {
    return {
      updated: false,
      reason: "session-expired",
      message: "登录状态已经失效，所以读不到云端的课程。请到「设置与备份 → 退出登录」后，用手机号 + 短信验证码重新登录，再点一次「更新学习课程」。"
    };
  }
  const provider = String(user?.provider || "").toLowerCase();
  const providerLabel = OAUTH_PROVIDER_LABELS[provider] || null;
  if (providerLabel || (!user?.phone && !user?.email)) {
    const who = providerLabel ? `当前登录的是${providerLabel}` : "当前账号没有绑定手机号或邮箱";
    return {
      updated: false,
      reason: "wrong-account",
      message: `${who}，它与手机号账号的家庭数据互不相通，因此看不到家里已发布的课程。请「退出登录」，改用手机号 + 短信验证码登录发布课程的那个家庭账号。`
    };
  }
  return {
    updated: false,
    reason: "cloud-empty",
    message: `这个家庭账号（${accountLabel({ user })}）在云端还没有生效的课程包。请在已登录同一账号的设备上打开「导入并发布新课程 → 把当前课程发布为新版本」，再回到这台手机点一次。`
  };
}

/* ---------------- 按钮一：上传学习记录 ---------------- */

export async function uploadLearningRecords({ onProgress } = {}) {
  await requireSignedIn();
  if (!navigator.onLine) throw new SyncError("当前没有网络，记录已保存在手机上，联网后可以重新上传。", "offline");

  const [code, device] = await Promise.all([studentCode(), deviceCode()]);
  const pending = await listSessions({ pendingOnly: true });
  const before = await countSessions();
  if (!pending.length) {
    return {
      uploaded: 0,
      skipped: 0,
      pendingBefore: 0,
      pendingAfter: 0,
      total: before.total,
      uploadedAt: null,
      message: "没有需要上传的新记录，云端已是最新。"
    };
  }

  await cloudApi.upsertStudent({ studentCode: code });
  await cloudApi.upsertDevice({
    deviceCode: device,
    studentCode: code,
    platform: detectPlatform(),
    appVersion: APP_VERSION
  });

  const confirmed = [];
  const failures = [];
  for (const [index, row] of pending.entries()) {
    onProgress?.({ done: index, total: pending.length });
    try {
      const payload = row.payload;
      const payloadSha256 = row.payloadSha256 || await sha256Hex(payload);
      await cloudApi.uploadSessionRow({
        session_id: row.sessionId,
        student_code: row.studentCode || code,
        device_code: row.deviceCode || device,
        lesson_id: payload?.lessonId || null,
        activity_mode: payload?.activityMode || null,
        started_at: payload?.startedAt || null,
        ended_at: payload?.endedAt || null,
        completed: Boolean(payload?.completed),
        stop_reason: payload?.stopReason || null,
        event_count: Array.isArray(payload?.events) ? payload.events.length : 0,
        payload,
        payload_sha256: payloadSha256,
        source_platform: row.platform || detectPlatform()
      });
      confirmed.push(row.sessionId);
    } catch (error) {
      failures.push({ sessionId: row.sessionId, message: cloudApi.describeError(error) });
    }
  }
  onProgress?.({ done: pending.length, total: pending.length });

  const uploadedAt = new Date().toISOString();
  if (confirmed.length) await markSessionsUploaded(confirmed, uploadedAt);
  const after = await countSessions();
  await appendLog({
    type: "sync",
    action: "upload",
    requested: pending.length,
    confirmed: confirmed.length,
    failed: failures.length,
    at: uploadedAt
  });

  if (!confirmed.length && failures.length) {
    throw new SyncError(`上传失败：${failures[0].message}`, "upload-failed");
  }

  return {
    uploaded: confirmed.length,
    skipped: pending.length - confirmed.length - failures.length,
    failures,
    pendingBefore: pending.length,
    pendingAfter: after.pending,
    total: after.total,
    uploadedAt,
    message: confirmed.length === pending.length
      ? `已上传 ${confirmed.length} 份学习记录，云端已保存。`
      : `已上传 ${confirmed.length} 份，${failures.length} 份仍留在手机上，可以稍后重试。`
  };
}

/* ---------------- 按钮二：更新学习课程 ---------------- */

// 完整课程包校验：协议、Schema、目录结构、教学业务约束。
// 导入文件、云端更新、恢复备份三条路径共用同一份规则，避免某条路径只用字符串糊弄过去。
export function validatePackagePayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ["课程包不是有效对象"];
  if (payload.protocol !== PROTOCOLS.coursePackage) errors.push(`课程包协议必须为 ${PROTOCOLS.coursePackage}`);
  if (payload.schemaVersion !== 1) errors.push("课程包 schemaVersion 必须为 1");

  const catalog = payload.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    errors.push("课程包缺少 catalog");
    return errors;
  }
  for (const subject of ["hanzi", "english_letter", "math"]) {
    const items = catalog[subject];
    if (!Array.isArray(items)) { errors.push(`catalog.${subject} 必须是数组`); continue; }
    if (items.length === 0) errors.push(`catalog.${subject} 不能为空`);
    const refs = new Set();
    for (const item of items) {
      if (!item || typeof item !== "object") { errors.push(`catalog.${subject} 存在无效条目`); break; }
      if (typeof item.ref !== "string" || !item.ref) { errors.push(`catalog.${subject} 存在缺少 ref 的条目`); break; }
      if (refs.has(item.ref)) { errors.push(`catalog.${subject} 编号重复：${item.ref}`); break; }
      refs.add(item.ref);
      if (typeof item.display !== "string" || !item.display) { errors.push(`catalog.${subject}.${item.ref} 缺少 display`); break; }
    }
  }

  const summary = payload.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) errors.push("课程包缺少 summary");
  else if (typeof summary.formalItemCount !== "number") errors.push("summary.formalItemCount 必须是数字");
  else if (summary.formalItemCount !== ["hanzi", "english_letter", "math"].reduce((sum, subject) => sum + (Array.isArray(catalog[subject]) ? catalog[subject].length : 0), 0)) errors.push("summary.formalItemCount 与目录条目数不一致");

  if (payload.lesson == null) errors.push("课程包缺少 lesson");
  else errors.push(...validateLesson(payload.lesson).map(issue => `课程：${issue}`));

  // 业务一致性：课程引用的 target 必须能在目录里找到，否则孩子会遇到无解题目。
  if (Array.isArray(payload.lesson?.tasks) && catalog) {
    for (const task of payload.lesson.tasks) {
      const ref = task?.target?.ref;
      const items = Array.isArray(catalog[task?.subject]) ? catalog[task.subject] : [];
      const item = items.find(candidate => candidate?.ref === ref);
      if (ref && !item) errors.push(`课程引用了目录中不存在的编号：${ref}`);
      else if (item && item.display !== task.target.display) errors.push(`课程编号与显示内容不一致：${ref}`);
    }
  }
  return errors;
}

// 校验并预览：返回 { ok, errors, preview }。不写任何状态。
export function inspectPackagePayload(payload) {
  const errors = validatePackagePayload(payload);
  const counts = errors.length ? null : {
    hanzi: payload.catalog.hanzi.length,
    english_letter: payload.catalog.english_letter.length,
    math: payload.catalog.math.length,
    lessonTasks: payload.lesson?.tasks?.length || 0
  };
  return {
    ok: errors.length === 0,
    errors,
    preview: {
      title: payload?.lesson?.title || null,
      lessonId: payload?.lesson?.lessonId || null,
      generatedAt: payload?.generatedAt || null,
      counts
    }
  };
}

// 原子替换课程包：先保存回滚副本，写入失败时自动回滚到原版本。
// 只有校验通过的包才允许走到这里。
export async function replaceActivePackage({ payload, version = 0, source = "parent-import", title = null }) {
  const errors = validatePackagePayload(payload);
  if (errors.length) throw new SyncError(`课程包未通过校验：${errors[0]}`, "invalid-payload");
  const previous = await loadActivePackage().catch(() => null);
  const sha = await sha256Hex(canonicalJson(payload));
  if (previous?.key) {
    // 保留可回滚的上一版（同名 key，独立存储）。
    await putPackage(ROLLBACK_PACKAGE_KEY, {
      key: ROLLBACK_PACKAGE_KEY,
      package: previous.package,
      sha256: previous.sha256,
      version: previous.version ?? 0,
      receivedAt: previous.receivedAt,
      source: previous.source,
      title: previous.title || null,
      rolledBackAt: new Date().toISOString()
    });
  }
  try {
    await saveActivePackage({
      key: "active",
      package: payload,
      sha256: sha,
      version,
      receivedAt: new Date().toISOString(),
      source,
      title
    });
  } catch (error) {
    // 写入失败：尝试恢复到上一版，绝不让应用停留在半写入状态。
    if (previous?.package) {
      await saveActivePackage(previous).catch(() => { /* 回滚也失败时保持现状并向上抛出。 */ });
    }
    throw error;
  }
  return { sha256: sha, previous };
}

// 回滚到最近一次替换前的课程包。
export async function rollbackActivePackage() {
  const previous = await getPackage(ROLLBACK_PACKAGE_KEY);
  if (!previous?.package) throw new SyncError("没有可回滚的课程版本。", "no-rollback");
  await saveActivePackage({ ...previous, key: "active" });
  return previous;
}

export async function updateCourse({ onProgress } = {}) {
  await requireSignedIn();
  if (!navigator.onLine) throw new SyncError("当前没有网络，仍可继续使用手机上的现有课程。", "offline");

  onProgress?.({ stage: "query" });
  const active = (await cloudApi.listActiveCourses()).filter(row => row.course_key === FAMILY_PACKAGE_KEY);
  if (!active.length) {
    // 不能一律说"云端还没有发布课程包"：登录态失效或登错了账号时，云端同样是 0 行。
    return await describeMissingCloudCourse();
  }
  const latest = active.sort((left, right) => (right.version || 0) - (left.version || 0))[0];
  const local = await loadActivePackage();
  const localVersion = Number(local.version || 0);

  const payload = latest.payload;
  const errors = validatePackagePayload(payload);
  if (errors.length) {
    throw new SyncError(`云端课程未通过校验，已继续使用原有课程：${errors[0]}`, "invalid-payload");
  }

  const computed = await sha256Hex(canonicalJson(payload));
  const legacyComputed = await sha256Hex(JSON.stringify(payload));
  if (!latest.payload_sha256 || (computed !== latest.payload_sha256 && legacyComputed !== latest.payload_sha256)) {
    throw new SyncError("云端课程内容与校验值不一致，已继续使用原有课程。", "hash-mismatch");
  }

  if (computed === await sha256Hex(canonicalJson(local.package)) && (latest.version || 0) === localVersion) {
    return { updated: false, reason: "up-to-date", version: latest.version, title: latest.title,
      publishedAt: latest.published_at, message: `已是最新课程（第 ${latest.version} 版）。` };
  }

  // 原子替换并保留回滚副本：写入失败自动回到原有课程。
  await replaceActivePackage({
    payload,
    version: latest.version,
    source: latest.source || "cloud",
    title: latest.title || null
  });
  // 只替换课程，不动任何尚未上传的学习记录。
  const sessions = await countSessions();
  return {
    updated: true,
    version: latest.version,
    title: latest.title,
    publishedAt: latest.published_at,
    generatedAt: payload.generatedAt,
    lessonId: payload.lesson?.lessonId || null,
    pendingSessions: sessions.pending,
    message: `课程已更新到第 ${latest.version} 版。`
  };
}

/* ---------------- 课程包发布（家长端） ---------------- */

export async function nextPackageVersion() {
  const versions = (await cloudApi.listCourseVersions(FAMILY_PACKAGE_KEY, 50)).map(row => row.version || 0);
  return (versions.length ? Math.max(...versions) : 0) + 1;
}

export async function publishCoursePackage(payload, { source = "parent-web", studentCodeValue = null } = {}) {
  await requireSignedIn();
  const errors = validatePackagePayload(payload);
  if (errors.length) throw new SyncError(`课程包未通过校验：${errors[0]}`, "invalid-payload");

  const version = await nextPackageVersion();
  const sha = await sha256Hex(canonicalJson(payload));
  await cloudApi.publishCourse({
    courseKey: FAMILY_PACKAGE_KEY,
    version,
    subject: payload.lesson?.tasks?.[0]?.subject || null,
    title: payload.lesson?.title || `课程包第 ${version} 版`,
    generatedAt: payload.generatedAt || null,
    source,
    payload,
    payloadSha256: sha
  });
  await cloudApi.activateCourse({ courseKey: FAMILY_PACKAGE_KEY, version });
  await appendLog({ type: "course", action: "publish", version, source });

  // 同时把课程包里的目录/摘要作为一次快照留存，便于核对。
  if (payload.catalog && payload.summary) {
    try {
      await cloudApi.uploadCatalogSnapshot({
        studentCode: studentCodeValue || DEFAULT_STUDENT_CODE,
        summary: payload.summary,
        catalog: payload.catalog,
        catalogSha256: await sha256Hex(JSON.stringify(payload.catalog)),
        source
      });
    } catch { /* 快照失败不影响课程发布结果。 */ }
  }
  return { version, sha256: sha };
}

/* ---------------- 记录导出（家长端 / ChatGPT Work） ---------------- */

export async function fetchRemoteRecords({ since = null, limit = null } = {}) {
  await requireSignedIn();
  return cloudApi.listRemoteSessions({ since, limit, studentCode: await studentCode() });
}

export async function fetchLocalRecords() {
  return listSessions({});
}

export function buildRecordBundle(sessions, { studentCodeValue = null, source = "unknown" } = {}) {
  const sorted = [...sessions].sort((left, right) =>
    String(left.ended_at || left.endedAt || "").localeCompare(String(right.ended_at || right.endedAt || "")));
  return {
    protocol: PROTOCOLS.recordBundle,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    studentCode: studentCodeValue || DEFAULT_STUDENT_CODE,
    source,
    sessionCount: sorted.length,
    sessions: sorted.map(row => row.payload || row)
  };
}

export async function localSessionCount() {
  return countSessions();
}
