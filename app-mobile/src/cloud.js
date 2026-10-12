// 云访问层：WorkBuddy 云服务的唯一入口。
// 身份与权限由服务端（RLS）决定，前端只负责发起请求与展示状态；
// 前端从不读取、也不发送 owner_id / 数据库密钥。
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { CLOUD_CONFIG } from "./config.js";

export const cloud = createWorkBuddyCloud({
  endpoint: CLOUD_CONFIG.endpoint,
  oauthRelayBaseUrl: CLOUD_CONFIG.oauthRelayBaseUrl,
  publishableKey: CLOUD_CONFIG.publishableKey
});

export const TABLES = Object.freeze({
  students: "xiaoya_students",
  devices: "xiaoya_devices",
  sessions: "xiaoya_sessions",
  courses: "xiaoya_course_versions",
  catalogs: "xiaoya_catalog_snapshots"
});

function unwrap(result) {
  if (result?.error) throw result.error;
  return result?.data;
}

export function describeError(error) {
  const code = error?.code || error?.status || "";
  const kind = error?.kind || "";
  if (code === "23505" || kind === "conflict") return "这条记录已经存在，未重复写入。";
  if (code === "42501" || kind === "forbidden" || kind === "unauthenticated") return "没有权限读写这份数据，请先登录家长账号。";
  if (code === "42P01") return "云端数据表尚未创建，请联系维护者。";
  if (kind === "network") return "网络不可用，请检查手机网络后重试。";
  if (kind === "backend-unavailable") return "云端暂时不可用，请稍后再试。";
  const message = error?.message || String(error || "未知错误");
  return message;
}

/* ---------------- 身份 ---------------- */

export async function getSession() {
  const { data, error } = await cloud.auth.getSession();
  if (error) return { session: null, error };
  return { session: data || null, error: null };
}

export async function getUser() {
  const { data, error } = await cloud.auth.getUser();
  if (error) return { user: null, error };
  return { user: data || null, error: null };
}

// 会话对象里的 user 只有 {id, isAnonymous, raw}：不含手机号、邮箱与昵称。
// 账号标识必须使用 /v1/user/me（getUser）的结果；失败时返回 null，界面降级为中性文案。
export async function getIdentity() {
  try {
    const { data, error } = await cloud.auth.getUser();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

export function onAuthStateChange(callback) {
  return cloud.auth.onAuthStateChange(callback);
}

export async function signOut() {
  unwrap(await cloud.auth.signOut());
}

// 发送验证码：SDK 会在返回里带上 isExistingUser，用于决定后续走登录还是注册。
// 这个标记必须原样保留并传给 verifyOtp，否则已有账号会被当成新账号走注册分支。
export async function sendOtp({ email, phone }) {
  const credentials = phone ? { phone } : { email };
  const data = unwrap(await cloud.auth.sendOtp(credentials));
  return {
    ...(data || {}),
    verificationId: data?.verificationId ?? null,
    isExistingUser: data?.isExistingUser === true
  };
}

// 验证码校验：isExistingUser 必须贯穿同一次挑战，SDK 据此选择 /signin 或 /signup。
export async function verifyOtp({ email, phone, verificationId, token, password, isExistingUser }) {
  const params = { verificationId, token };
  if (phone) params.phone = phone;
  else params.email = email;
  if (password) params.password = password;
  if (typeof isExistingUser === "boolean") params.isExistingUser = isExistingUser;
  return unwrap(await cloud.auth.verifyOtp(params));
}

export async function signInWithPassword({ email, password }) {
  return unwrap(await cloud.auth.signInWithPassword({ email, password }));
}

// 密码重置：必须先在「获取验证码」时创建重置挑战，再拿同一个挑战校验新密码。
// 返回一个只暴露 updateUser 的对象，并逐步检查每一步的 error，避免静默失败。
export async function resetPasswordForEmail(email) {
  const challenge = await cloud.auth.resetPasswordForEmail(email);
  if (challenge?.error) throw challenge.error;
  const inner = challenge?.data;
  if (!inner?.updateUser) throw new Error("无法创建密码重置挑战，请稍后重试。");
  return {
    async updateUser({ nonce, password }) {
      const result = await inner.updateUser({ nonce, password });
      if (result?.error) throw result.error;
      return result?.data ?? null;
    }
  };
}

export async function startOAuth(provider) {
  const redirect = unwrap(await cloud.auth.signInWithOAuth({
    provider,
    redirectTo: `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`
  }));
  return redirect?.url || null;
}

// 应用启动时无条件调用：把 OAuth 回调换成会话，并清掉地址栏上的一次性参数。
export async function completeOAuthCallback() {
  const search = location.search;
  if (!search) return { session: null, handled: false };
  let session = null;
  let handled = false;
  try {
    const wechat = await cloud.auth.handleWechatWebCallback(search);
    if (wechat?.data) { session = wechat.data; handled = true; }
  } catch { /* 不是微信回调。 */ }
  if (!session) {
    try {
      const workbuddy = await cloud.auth.handleWorkBuddyCallback(search);
      if (workbuddy?.data) { session = workbuddy.data; handled = true; }
    } catch { /* 不是 WorkBuddy 回调。 */ }
  }
  if (handled) {
    const url = new URL(location.href);
    for (const key of ["code", "state", "provider", "error", "error_description"]) url.searchParams.delete(key);
    history.replaceState(null, "", url.toString());
  }
  return { session, handled };
}

/* ---------------- 学习数据结构 ---------------- */

export async function upsertStudent({ studentCode, displayName }) {
  const { error } = await cloud.database
    .from(TABLES.students)
    .upsert({ student_code: studentCode, display_name: displayName || null },
      { onConflict: "owner_id,student_code", ignoreDuplicates: true });
  if (error) throw error;
}

export async function upsertDevice({ deviceCode, studentCode, platform, appVersion, label }) {
  const { error } = await cloud.database
    .from(TABLES.devices)
    .upsert({
      device_code: deviceCode,
      student_code: studentCode,
      platform,
      app_version: appVersion,
      label: label || null,
      last_seen_at: new Date().toISOString()
    }, { onConflict: "owner_id,device_code" });
  if (error) throw error;
}

// 唯一记录 ID + 冲突忽略：重复点击上传不会生成重复学习数据。
export async function uploadSessionRow(row) {
  const { data, error } = await cloud.database
    .from(TABLES.sessions)
    .upsert(row, { onConflict: "owner_id,session_id", ignoreDuplicates: true })
    .select("session_id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export async function listRemoteSessions({ since = null, limit = null, studentCode = null } = {}) {
  const rows = [];
  const maximum = limit == null ? Infinity : Math.max(0, Math.floor(Number(limit) || 0));
  while (rows.length < maximum) {
    const pageSize = Math.min(200, maximum - rows.length);
    let query = cloud.database
      .from(TABLES.sessions)
      .select("session_id,student_code,device_code,lesson_id,activity_mode,started_at,ended_at,completed,stop_reason,event_count,payload,payload_sha256,uploaded_at")
      .order("uploaded_at", { ascending: true }).order("session_id", { ascending: true })
      .range(rows.length, rows.length + pageSize - 1);
    if (since) query = query.gte("ended_at", since);
    if (studentCode) query = query.eq("student_code", studentCode);
    const { data, error } = await query;
    if (error) throw error; // Never present a partial export as complete.
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function countRemoteSessions() {
  const { count, error } = await cloud.database
    .from(TABLES.sessions)
    .select("session_id", { count: "exact", head: true });
  if (error) throw error;
  return count || 0;
}

export async function deleteRemoteSession(sessionId) {
  const { data, error } = await cloud.database
    .from(TABLES.sessions)
    .delete()
    .eq("session_id", sessionId)
    .select("session_id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

/* ---------------- 课程版本 ---------------- */

export async function listActiveCourses() {
  const { data, error } = await cloud.database
    .from(TABLES.courses)
    .select("course_key,version,subject,title,generated_at,published_at,source,payload,payload_sha256,is_active")
    .eq("is_active", true)
    .order("version", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listCourseVersions(courseKey, limit = 20) {
  const { data, error } = await cloud.database
    .from(TABLES.courses)
    .select("course_key,version,subject,title,generated_at,published_at,source,is_active,payload_sha256")
    .eq("course_key", courseKey)
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function nextCourseVersion(courseKey) {
  const { data, error } = await cloud.database
    .from(TABLES.courses)
    .select("version")
    .eq("course_key", courseKey)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.version || 0) + 1;
}

export async function publishCourse({ courseKey, version, subject, title, generatedAt, source, payload, payloadSha256 }) {
  const { error } = await cloud.database
    .from(TABLES.courses)
    .upsert({
      course_key: courseKey,
      version,
      subject,
      title,
      generated_at: generatedAt || null,
      source: source || "parent",
      payload,
      payload_sha256: payloadSha256,
      is_active: false
    }, { onConflict: "owner_id,course_key,version" });
  if (error) throw error;
}

export async function activateCourse({ courseKey, version }) {
  const on = await cloud.database
    .from(TABLES.courses)
    .update({ is_active: true })
    .eq("course_key", courseKey)
    .eq("version", version)
    .select("version");
  if (on.error) throw on.error;
  if (!Array.isArray(on.data) || on.data.length === 0) {
    throw new Error("没有找到要发布的课程版本，可能已被删除。");
  }
  // Confirm the new course exists and is active before retiring the old one.
  // A failed first request must never leave the family with no active course.
  const off = await cloud.database
    .from(TABLES.courses).update({ is_active: false })
    .eq("course_key", courseKey).eq("is_active", true).neq("version", version)
    .select("version");
  if (off.error) throw off.error;
  return on.data.length;
}

/* ---------------- 目录快照 ---------------- */

export async function uploadCatalogSnapshot({ studentCode, summary, catalog, catalogSha256, source }) {
  const { error } = await cloud.database
    .from(TABLES.catalogs)
    .insert({
      student_code: studentCode,
      summary,
      catalog,
      catalog_sha256: catalogSha256,
      source: source || "parent-web"
    });
  if (error) throw error;
}

export async function latestCatalogSnapshot() {
  const { data, error } = await cloud.database
    .from(TABLES.catalogs)
    .select("generated_at,summary,catalog,catalog_sha256,source")
    .order("generated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}
