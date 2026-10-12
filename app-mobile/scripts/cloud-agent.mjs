// 小芽家庭学习 · 电脑/AI 云端访问工具
//
// 两种登录方式：
//   A. 密码登录（推荐，长期自动）：`--login --email <邮箱> --password <密码>`
//      密码是长期凭据，会被保存到本地 600 权限文件里；之后会话一旦过期，脚本会
//      自己用密码重新登录，无需任何人再输入验证码。
//   B. 手机号 + 验证码（一次性）：`--login --phone <手机号>` → `--login --code <验证码>`
//      验证码是短期凭据，会话过期后**必须重新发码**——所以只在临时诊断时用。
//
// 为什么必须用密码：云端会话有有效期（实测 access token 2 小时；刷新句柄也会被服务端
// 拒绝 invalid_grant）。一旦被拒，SDK 会主动清空本地会话，`getSession()` 又会返回
// 空结果而不报错，所以表象和"从未登录"一样。"登录一次永久免登录"对验证码并不成立。
//
// 用法：
//   node app-mobile/scripts/cloud-agent.mjs --login --email you@example.com --password 你的密码
//   node app-mobile/scripts/cloud-agent.mjs --login --phone 13800001234          # 发送短信验证码
//   node app-mobile/scripts/cloud-agent.mjs --login --code 123456                # 完成验证码登录
//   node app-mobile/scripts/cloud-agent.mjs --status
//   node app-mobile/scripts/cloud-agent.mjs --pull-records [--since=YYYY-MM-DD] [--no-import]
//   node app-mobile/scripts/cloud-agent.mjs --push-course
//   node app-mobile/scripts/cloud-agent.mjs --logout
//
// 本地文件都放在 %USERPROFILE%\.xiaoya\ 下（600 权限），可用环境变量
// XIAOYA_SESSION_FILE 整体改路径：
//   cloud-session.json            会话（含令牌）
//   cloud-session.json.credentials.json  密码登录凭据（自动重登用；--logout 会删除）
//   cloud-session.json.identity.json     脱敏台账（仅账号与时间，无令牌）
// 正式数据：--pull-records 会把新记录以「只追加」方式归档到 data/raw/sessions
// （同名文件绝不覆盖，写入前做结构与摘要双重校验），--no-import 可跳过归档；
// 不修改 learning-state.json。
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
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
const ORIGIN = ENDPOINT;
const COURSE_KEY = "family-package";
const STUDENT_CODE = process.env.XIAOYA_STUDENT_CODE || "student-01";

const SESSION_FILE = process.env.XIAOYA_SESSION_FILE || path.join(os.homedir(), ".xiaoya", "cloud-session.json");
const PENDING_FILE = `${SESSION_FILE}.pending.json`;
// 会话台账（脱敏，不含令牌）：只为在会话被清空后仍能区分"从未登录"和"登录已失效"。
const IDENTITY_FILE = `${SESSION_FILE}.identity.json`;
// 密码登录凭据（明文，600 权限，仅本机）：会话过期后用它自动重登，从此不再需要验证码。
const CREDENTIALS_FILE = `${SESSION_FILE}.credentials.json`;

/* ---------------- 会话持久化 ---------------- */

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonFile(file, value, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
}

function createFileStorage(file) {
  const store = readJsonFile(file) || {};
  const persist = () => writeJsonFile(file, store);
  return {
    getItem: key => (typeof store[key] === "string" ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
      persist();
      // 顺带更新会话台账：SDK 在续期被拒时会直接清空会话且不报错，届时只有这份
      // 台账能把"登录过但已失效"与"从未登录"区分开。
      try {
        const session = JSON.parse(String(value));
        if (session && typeof session === "object" && typeof session.expiresAt === "number") {
          const previous = readJsonFile(IDENTITY_FILE) || {};
          writeJsonFile(IDENTITY_FILE, {
            phone: session.user?.phone || previous.phone || null,
            firstLoginAt: previous.firstLoginAt || new Date().toISOString(),
            lastSessionAt: new Date().toISOString(),
            expiresAt: session.expiresAt,
            sessionWrites: (previous.sessionWrites || 0) + 1
          });
        }
      } catch { /* 台账写入失败不影响登录本身。 */ }
    },
    removeItem: key => { delete store[key]; persist(); }
  };
}

// 服务端按 Origin 精确匹配；Node 里没有页面来源，必须显式补上同源 Origin，
// 否则表现为跨域/来源错误（且极难归因）。
const originFetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
  return fetch(input, { ...init, headers });
};

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  publishableKey: PUBLISHABLE_KEY,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  fetch: originFetch,
  storage: createFileStorage(SESSION_FILE)
});

/* ---------------- 身份 ---------------- */

function describeUser(user) {
  if (!user) return "未知";
  const provider = String(user.provider || "").toLowerCase();
  if (user.phone) return `手机号 ${String(user.phone).replace(/\D/g, "").replace(/^(\d{3})\d*(\d{4})$/, "$1****$2")}`;
  if (user.email) return `邮箱 ${String(user.email).replace(/^(.).*(@.*)$/, "$1***$2")}`;
  if (provider === "wechat") return "微信账号（未绑定手机号）";
  if (provider === "workbuddy") return "WorkBuddy 账号（未绑定手机号）";
  return user.name ? `${user.name}（未绑定手机号）` : "已登录（未绑定手机号）";
}

// getSession() 在"会话被服务端拒绝并已清空"与"从未登录"两种情况下都返回 null
// 且不带 error，只看返回值无法区分；因此同时读会话台账来做判断。
// 若本地存有密码凭据，则先用它自动重新登录——这是"再也不需要验证码"的关键一步。
async function recoverWithPassword() {
  const credentials = readJsonFile(CREDENTIALS_FILE);
  if (!credentials?.password || (!credentials.email && !credentials.phone)) return null;
  const payload = credentials.email
    ? { email: credentials.email, password: credentials.password }
    : { phone: credentials.phone, password: credentials.password };
  try {
    const signed = await cloud.auth.signInWithPassword(payload);
    if (signed?.error) {
      console.log(`（已保存的密码自动重登失败：${signed.error.message || signed.error}）`);
      return null;
    }
    console.log(`（已用保存的密码自动重新登录：${describeUser(signed?.data?.user || null)}）`);
    return signed?.data || null;
  } catch (error) {
    console.log(`（已保存的密码自动重登失败：${error?.message || error}）`);
    return null;
  }
}

async function currentIdentity() {
  const { data, error } = await cloud.auth.getSession();
  if (error) throw new Error(`读取会话失败：${error.message || error}`);
  const session = data || null;
  if (!session) {
    const restored = await recoverWithPassword();
    if (restored) return { session: restored, user: restored.user || null, recovered: true };
    const lastKnown = readJsonFile(IDENTITY_FILE);
    return { session: null, user: null, expired: Boolean(lastKnown), lastKnown };
  }
  const expiry = Number(session.expiresAt || 0);
  if (expiry && expiry <= Date.now()) {
    // 会话过期时先续期，续期失败再退回"用保存的密码重登"。
    const refreshed = await cloud.auth.refreshSession();
    if (refreshed?.error || !refreshed?.data) {
      const restored = await recoverWithPassword();
      if (restored) return { session: restored, user: restored.user || null, recovered: true };
      return { session: null, user: null, expired: true, lastKnown: readJsonFile(IDENTITY_FILE) };
    }
    return { session: refreshed.data, user: refreshed.data.user || null };
  }
  return { session, user: session.user || null };
}

function describeLastKnown(lastKnown) {
  if (!lastKnown) return "";
  const who = lastKnown.phone
    ? `手机号 ${String(lastKnown.phone).replace(/\D/g, "").replace(/^(\d{3})\d*(\d{4})$/, "$1****$2")}`
    : "未知账号";
  const login = lastKnown.firstLoginAt ? lastKnown.firstLoginAt.replace("T", " ").slice(0, 19) : "?";
  const expiry = lastKnown.expiresAt ? new Date(Number(lastKnown.expiresAt)).toISOString().replace("T", " ").slice(0, 19) : "?";
  return `上次登录：${who}（登录于 ${login} UTC，最后一次凭据到期 ${expiry} UTC）`;
}

async function requireSignedIn() {
  const { session, user, expired, lastKnown } = await currentIdentity();
  if (!session) {
    const hasCredentials = Boolean(readJsonFile(CREDENTIALS_FILE)?.password);
    if (hasCredentials) {
      throw new Error("已保存的密码无法登录（密码可能被改过，或该账号还没有密码）。请用当前密码重新执行：\n  node app-mobile/scripts/cloud-agent.mjs --login --email <邮箱> --password <密码>");
    }
    if (expired) {
      throw new Error(`登录会话已失效（${describeLastKnown(lastKnown)}）——凭据到期后服务端拒绝了续期，本地会话已被清空。请重新登录：\n  node app-mobile/scripts/cloud-agent.mjs --login --phone <手机号>`);
    }
    throw new Error(`还没有登录过。请先执行：\n  node app-mobile/scripts/cloud-agent.mjs --login --email <邮箱> --password <密码>`);
  }
  return { session, user };
}

/* ---------------- 命令 ---------------- */

async function login() {
  const args = process.argv.slice(2);
  const value = flag => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
  const phoneArg = value("--phone");
  const codeArg = value("--code");
  const emailArg = value("--email");
  const passwordArg = value("--password");

  // 密码登录：长期凭据。凭据落盘后，会话过期时脚本能自己重登，不再需要验证码。
  if (passwordArg && (emailArg || phoneArg)) {
    const credentials = emailArg
      ? { email: String(emailArg).trim(), password: String(passwordArg) }
      : { phone: String(phoneArg).trim(), password: String(passwordArg) };
    const signed = await cloud.auth.signInWithPassword(credentials);
    if (signed?.error) throw new Error(`密码登录失败：${signed.error.message || signed.error}`);
    writeJsonFile(CREDENTIALS_FILE, credentials);
    const user = signed?.data?.user || null;
    const expiry = Number(signed?.data?.expiresAt || 0);
    console.log(`登录成功：${describeUser(user)}`);
    console.log(`凭据已保存到 ${CREDENTIALS_FILE}（600 权限，仅本机）；会话过期时会自动重新登录。`);
    if (expiry) console.log(`当前凭据有效期至 ${new Date(expiry).toISOString()}（到期自动续期/重登）。`);
    return;
  }

  if (phoneArg) {
    const sent = await cloud.auth.sendOtp({ phone: String(phoneArg).trim() });
    if (sent?.error) throw new Error(`发送验证码失败：${sent.error.message || sent.error}`);
    const data = sent?.data || {};
    writeJsonFile(PENDING_FILE, {
      phone: String(phoneArg).trim(),
      verificationId: data.verificationId ?? null,
      isExistingUser: data.isExistingUser === true,
      at: new Date().toISOString()
    });
    console.log("验证码已发送。收到短信后执行：");
    console.log(`  node app-mobile/scripts/cloud-agent.mjs --login --code <6 位验证码>`);
    return;
  }

  if (codeArg) {
    const pending = readJsonFile(PENDING_FILE);
    if (!pending?.phone) throw new Error("没有待完成的登录。请先执行 --login --phone <手机号>。");
    const verified = await cloud.auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      token: String(codeArg).trim(),
      isExistingUser: pending.isExistingUser === true
    });
    if (verified?.error) throw new Error(`验证码校验失败：${verified.error.message || verified.error}`);
    rmSync(PENDING_FILE, { force: true });
    const user = verified?.data?.user || null;
    const expiry = Number(verified?.data?.session?.expiresAt || verified?.data?.expiresAt || 0);
    console.log(`登录成功：${describeUser(user)}`);
    if (expiry) {
      const minutes = Math.max(0, Math.round((expiry - Date.now()) / 60000));
      console.log(`本次凭据有效期至 ${new Date(expiry).toISOString()}（约 ${minutes} 分钟）。`);
    }
    console.log(`会话已保存到 ${SESSION_FILE}；在有效期内可直接执行 --pull-records / --push-course。`);
    console.log("凭据到期后需要重新执行 --login（请用 --status 随时查看当前状态）。");
    return;
  }

  throw new Error("用法：--login --phone <手机号>，或 --login --code <验证码>");
}

async function status() {
  const { session, user, expired, lastKnown } = await currentIdentity();
  if (!session) {
    if (expired) {
      console.log(`登录会话已失效（${describeLastKnown(lastKnown)}）。`);
      console.log("凭据到期后服务端拒绝续期，SDK 已清空本地会话，需要重新登录：");
      console.log("  node app-mobile/scripts/cloud-agent.mjs --login --phone <手机号>");
    } else {
      console.log("尚未登录。");
    }
    const stored = readJsonFile(CREDENTIALS_FILE);
    console.log(stored?.password
      ? `密码凭据：已保存（${stored.email ? "邮箱 " + String(stored.email).replace(/^(.).*(@.*)$/, "$1***$2") : "手机号 " + String(stored.phone || "").replace(/^(\d{3})\d*(\d{4})$/, "$1****$2")}），但用它重登失败——密码可能已变更，请重新执行带 --password 的 --login。`
      : "密码凭据：未保存（会话过期后需要重新登录；用 --login --email … --password … 保存一次即可长期自动）。");
    console.log(`会话文件：${SESSION_FILE}`);
    return;
  }
  console.log(`已登录：${describeUser(user)}`);
  // 会话对象里的 user 只有 {id, isAnonymous, raw}，不含手机号/邮箱；账号到底绑定了
  // 什么必须查 /v1/user/me。是否可改密码完全取决于这里邮箱有没有绑定。
  const me = await cloud.auth.getUser();
  if (me?.data) {
    const bound = value => (value ? "已绑定" : "未绑定");
    const shownEmail = me.data.email ? `（${String(me.data.email).replace(/^(.).*(@.*)$/, "$1***$2")}）` : "";
    console.log(`账号绑定：手机号 ${bound(me.data.phone)}、邮箱 ${bound(me.data.email)}${shownEmail}`);
    console.log(`账号标识：${describeUser(me.data)}`);
  } else if (me?.error) {
    console.log(`账号绑定：查询失败（${me.error.message || me.error}）`);
  }
  const expiry = Number(session.expiresAt || 0);
  console.log(`当前凭据有效期至：${expiry ? new Date(expiry).toISOString() : "未知（将自动续期）"}`);
  if (lastKnown?.firstLoginAt) console.log(`本次凭据首次登录于：${lastKnown.firstLoginAt}`);
  console.log(`密码凭据：${readJsonFile(CREDENTIALS_FILE)?.password ? "已保存（会话过期会自动重登，无需验证码）" : "未保存（会话过期后需重新登录）"}`);
  console.log(`会话文件：${SESSION_FILE}`);

  const rows = await cloud.database.from("xiaoya_sessions").select("session_id,uploaded_at").order("uploaded_at", { ascending: false }).limit(5);
  if (rows.error) { console.log(`云端记录不可读：${rows.error.message}`); return; }
  console.log(`云端学习记录：至少 ${(rows.data || []).length} 条（最近 5 条如下，实际条数见 --pull-records）`);
  for (const row of (rows.data || [])) console.log(`  ${row.uploaded_at || "?"}  ${row.session_id}`);
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function pullRecords() {
  await requireSignedIn();
  const sinceArgument = process.argv.find(argument => argument.startsWith("--since="));
  const since = sinceArgument ? new Date(`${sinceArgument.slice("--since=".length)}T00:00:00`).toISOString() : null;

  const rows = [];
  for (let round = 0; round < 200; round += 1) {
    const pageSize = 200;
    let query = cloud.database
      .from("xiaoya_sessions")
      .select("session_id,student_code,device_code,lesson_id,activity_mode,started_at,ended_at,completed,stop_reason,event_count,payload,payload_sha256,uploaded_at")
      .order("uploaded_at", { ascending: true }).order("session_id", { ascending: true })
      .range(rows.length, rows.length + pageSize - 1);
    if (since) query = query.gte("ended_at", since);
    const { data, error } = await query;
    if (error) throw new Error(`读取云端记录失败：${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

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
    lesson_id: row.lesson_id,
    ended_at: row.ended_at,
    uploaded_at: row.uploaded_at,
    event_count: row.event_count,
    completed: row.completed
  })), null, 2)}\n`, "utf8");

  const byDevice = {};
  for (const row of rows) byDevice[row.device_code || "(none)"] = (byDevice[row.device_code || "(none)"] || 0) + 1;
  console.log(`已下载云端 ${rows.length} 份学习记录。`);
  console.log(`记录包：${path.join(dir, "records.json")}`);
  console.log(`来源设备分布：${JSON.stringify(byDevice)}`);

  if (process.argv.includes("--no-import")) {
    console.log("（已按 --no-import 跳过原始记录归档）");
    return;
  }
  await importRecords(rows, dir);
}

/* ---------------- 原始记录归档（只追加到 data/raw/sessions） ---------------- */

// 手机端在上传前对完整会话计算过 SHA-256（JSON.stringify 后取摘要）。云端 JSONB
// 会重排对象键，因此这里按两端一致的构造顺序还原键序后复算摘要；复现成功说明
// 归档内容与手机上传时逐字节一致（仅格式化为 2 空格缩进）。
const SESSION_KEY_ORDER = ["protocol", "schemaVersion", "sessionId", "lessonId", "basedOnLessonGeneratedAt", "startedAt", "endedAt", "completed", "stopReason", "events", "lessonTitle", "activityMode", "lessonProtocol", "lessonTaskCount", "plannedNewHanziRefs", "plannedNewLetterRefs", "plannedNewMathRefs", "plannedNextPreviewHanziRefs", "executedTaskCount"];
const EVENT_KEY_ORDER = ["eventId", "recordedAt", "taskId", "originalTaskId", "subject", "targetRef", "targetDisplay", "questionType", "evidenceType", "attempt", "result", "independent", "hintUsed", "responseTimeMs", "childAnswer", "correctAnswer"];

function reorderKeys(object, order) {
  const out = {};
  for (const key of order) if (Object.prototype.hasOwnProperty.call(object, key)) out[key] = object[key];
  for (const key of Object.keys(object)) if (!(key in out)) out[key] = object[key];
  return out;
}

function rebuildPhoneOrder(payload) {
  const session = reorderKeys(payload, SESSION_KEY_ORDER);
  if (Array.isArray(session.events)) {
    session.events = session.events.map(event => (event && typeof event === "object" ? reorderKeys(event, EVENT_KEY_ORDER) : event));
  }
  return session;
}

function sortForCompare(value) {
  if (Array.isArray(value)) return value.map(sortForCompare);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortForCompare(value[key])]));
  return value;
}

function sessionIssues(payload, state) {
  const issues = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ["payload 不是有效对象"];
  if (payload.protocol !== "FAMILY_LEARNING_SESSION_V1") issues.push("protocol 必须为 FAMILY_LEARNING_SESSION_V1");
  if (payload.schemaVersion !== 1) issues.push("schemaVersion 必须为 1");
  if (typeof payload.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.sessionId)) issues.push("sessionId 缺失或包含不安全字符");
  if (!payload.endedAt) issues.push("缺少 endedAt");
  if (!Array.isArray(payload.events)) {
    issues.push("events 必须是数组");
    return issues;
  }
  for (const [index, event] of payload.events.entries()) {
    if (!event || typeof event !== "object") { issues.push(`第 ${index + 1} 条事件不是对象`); continue; }
    if (!["hanzi", "english_letter", "math"].includes(event.subject)) issues.push(`第 ${index + 1} 条事件 subject 不受支持`);
    else if (!state.items?.[event.subject]?.[event.targetRef]) issues.push(`第 ${index + 1} 条事件引用了不存在的学习项：${event.targetRef}`);
    if (event.questionType !== "recognition" && event.questionType !== "choice") issues.push(`第 ${index + 1} 条事件题型不受支持`);
    if (!["correct", "incorrect", "hint_shown", "demonstrated"].includes(event.result)) issues.push(`第 ${index + 1} 条事件结果不受支持`);
  }
  return issues;
}

async function importRecords(rows, dir) {
  const rawDir = path.join(dataDir, "raw", "sessions");
  const statePath = path.join(dataDir, "state", "learning-state.json");
  if (!existsSync(statePath)) throw new Error(`找不到正式状态文件：${statePath}`);
  mkdirSync(rawDir, { recursive: true });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const report = { rawDir, imported: 0, alreadyPresent: 0, conflicts: 0, invalid: 0, sessions: [] };
  for (const row of rows) {
    const payload = row.payload;
    const sessionId = payload?.sessionId || row.session_id || "(unknown)";
    const issues = sessionIssues(payload, state);
    if (issues.length) {
      report.invalid += 1;
      report.sessions.push({ sessionId, status: "invalid", issues });
      continue;
    }
    const digest = createHash("sha256").update(JSON.stringify(rebuildPhoneOrder(payload))).digest("hex").toUpperCase();
    const digestStatus = row.payload_sha256
      ? (digest === String(row.payload_sha256).toUpperCase() ? "verified" : "not-reproduced")
      : "no-cloud-digest";
    const file = path.join(rawDir, `${sessionId}.json`);
    if (existsSync(file)) {
      const same = JSON.stringify(sortForCompare(JSON.parse(readFileSync(file, "utf8")))) === JSON.stringify(sortForCompare(payload));
      if (same) { report.alreadyPresent += 1; report.sessions.push({ sessionId, status: "already-present", digestStatus }); }
      else { report.conflicts += 1; report.sessions.push({ sessionId, status: "conflict-kept-original", digestStatus }); }
      continue;
    }
    // 只追加：同名文件不存在才写入；绝不覆盖既有原始记录。
    writeFileSync(file, JSON.stringify(rebuildPhoneOrder(payload), null, 2), "utf8");
    report.imported += 1;
    report.sessions.push({ sessionId, status: "imported", digestStatus, digest, cloudDigest: row.payload_sha256 || null });
  }
  await writeFile(path.join(dir, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`原始记录归档：新增 ${report.imported} 份、已存在 ${report.alreadyPresent} 份、冲突 ${report.conflicts} 份、无效 ${report.invalid} 份。`);
  console.log(`归档位置：${rawDir}（只追加，已存在的文件绝不覆盖）`);
  for (const entry of report.sessions) {
    const label = entry.status === "imported"
      ? (entry.digestStatus === "verified" ? "已归档，并复现手机上传摘要一致" : `已归档（摘要${entry.digestStatus === "not-reproduced" ? "未能按已知键序复现" : "不可用"}）`)
      : entry.status === "already-present" ? "已存在，跳过"
      : entry.status === "conflict-kept-original" ? "同名但内容不同：保留原文件并报告"
      : "未通过结构校验，未归档";
    console.log(`  - ${entry.sessionId}：${label}`);
    if (entry.issues) for (const issue of entry.issues) console.log(`      ${issue}`);
  }
  if (report.imported || report.alreadyPresent) {
    console.log("下一步：在小芽家庭学习里点击「检查 AI 新内容」，软件会把原始记录与 AI 文件一起校验并应用。");
  }
}

async function pushCourse() {
  const state = JSON.parse(readFileSync(path.join(dataDir, "state", "learning-state.json"), "utf8"));
  const lesson = JSON.parse(readFileSync(path.join(dataDir, "ai", "next-lesson.json"), "utf8"));
  const { package: pkg, sha256 } = buildFamilyCoursePackage({ state, lesson, source: "windows-pc", studentCode: STUDENT_CODE });

  await requireSignedIn();

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

  // 先启用新版本，再停用旧版本：中途失败也不会留下"没有生效课程"的状态。
  const on = await cloud.database.from("xiaoya_course_versions")
    .update({ is_active: true }).eq("course_key", COURSE_KEY).eq("version", version).select("version");
  if (on.error) throw new Error(`启用新版本失败：${on.error.message}`);
  if (!on.data?.length) throw new Error("没有找到刚写入的版本，发布未生效。");

  const off = await cloud.database.from("xiaoya_course_versions")
    .update({ is_active: false }).eq("course_key", COURSE_KEY).eq("is_active", true).neq("version", version).select("version");
  if (off.error) throw new Error(`停用旧版本失败：${off.error.message}`);

  const snapshot = await cloud.database.from("xiaoya_catalog_snapshots").insert({
    student_code: STUDENT_CODE,
    summary: pkg.summary,
    catalog: pkg.catalog,
    catalog_sha256: createHash("sha256").update(JSON.stringify(pkg.catalog)).digest("hex").toUpperCase(),
    source: "windows-pc"
  });
  if (snapshot.error) console.warn(`目录快照未写入（不影响课程发布）：${snapshot.error.message}`);

  const dir = path.join(outRoot, `cloud-push-${timestamp()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "course-package.meta.json"), `${JSON.stringify({
    version,
    sha256,
    generatedAt: pkg.generatedAt,
    lessonId: lesson?.lessonId,
    lessonTasks: lesson?.tasks?.length || 0,
    counts: { hanzi: pkg.catalog.hanzi.length, english_letter: pkg.catalog.english_letter.length, math: pkg.catalog.math.length }
  }, null, 2)}\n`, "utf8");

  console.log(`已发布课程第 ${version} 版（${lesson?.tasks?.length || 0} 道题）。手机端点击「更新学习课程」即可获取。`);
  console.log(`本地留档：${dir}`);
}

async function logout() {
  try { await cloud.auth.signOut(); } catch { /* 已经失效时忽略。 */ }
  rmSync(SESSION_FILE, { force: true });
  rmSync(PENDING_FILE, { force: true });
  rmSync(IDENTITY_FILE, { force: true });
  rmSync(CREDENTIALS_FILE, { force: true });
  console.log("已退出登录，并清除本地会话、台账与密码凭据。");
}

/* ---------------- 入口 ---------------- */

async function main() {
  const args = process.argv.slice(2);
  const has = flag => args.includes(flag);
  const wantsLogin = has("--login");
  const wantsStatus = has("--status");
  const wantsPull = has("--pull-records");
  const wantsPush = has("--push-course");
  const wantsLogout = has("--logout");

  if (!wantsLogin && !wantsStatus && !wantsPull && !wantsPush && !wantsLogout) {
    console.log("用法：");
    console.log("  --login --email <邮箱> --password <密码>   密码登录（推荐：保存后长期免验证码）");
    console.log("  --login --phone <手机号> --password <密码> 手机号密码登录（同样会保存凭据）");
    console.log("  --login --phone <手机号>     发送短信验证码（临时诊断用）");
    console.log("  --login --code <验证码>      完成验证码登录并保存会话");
    console.log("  --status                     查看当前登录状态与云端记录概况");
    console.log("  --pull-records [--since=YYYY-MM-DD] [--no-import]");
    console.log("                               下载云端学习记录，并把新记录归档到 data/raw/sessions（只追加）");
    console.log("  --push-course                把正式状态与最新课程发布为云端新版本");
    console.log("  --logout                     退出登录并清除本地会话、台账与密码凭据");
    console.log(`会话文件：${SESSION_FILE}${existsSync(SESSION_FILE) ? "（已存在）" : "（尚未创建）"}`);
    return;
  }

  if (wantsLogin) return login();
  if (wantsLogout) return logout();
  if (wantsStatus) return status();
  if (wantsPull) return pullRecords();
  if (wantsPush) return pushCourse();
}

try {
  await main();
} catch (error) {
  console.error(`\n未完成：${error?.message || error}`);
  process.exitCode = 1;
}
