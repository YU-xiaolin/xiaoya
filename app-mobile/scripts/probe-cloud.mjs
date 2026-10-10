// 云端数据面只读探针：用于验证环境可用性与权限边界。
// 只做只读与“错误凭据登录”探测，不创建账号、不发送短信或邮件、不写入任何用户数据。
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const ENDPOINT = process.env.XIAOYA_ENDPOINT || "https://xiaoya-learning.app.workbuddy.host";
const PUBLISHABLE_KEY = process.env.XIAOYA_PUBLISHABLE_KEY
  || "wbpk_GmOXzpfOUNz2OjF2Hyvdj9_B4A2hcHXU4KX4cvUwf1QLoHRx9OsNC51";

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  publishableKey: PUBLISHABLE_KEY,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth"
});

function summarize(label, result) {
  if (result?.error) {
    const error = result.error;
    return {
      label,
      ok: false,
      code: error.code || null,
      status: error.status || null,
      kind: error.kind || null,
      message: String(error.message || error).slice(0, 200)
    };
  }
  const data = result?.data;
  return {
    label,
    ok: true,
    rows: Array.isArray(data) ? data.length : (data === null ? 0 : 1),
    sample: Array.isArray(data) ? null : data
  };
}

const tables = ["xiaoya_students", "xiaoya_devices", "xiaoya_sessions", "xiaoya_course_versions", "xiaoya_catalog_snapshots"];
const report = { endpoint: ENDPOINT, at: new Date().toISOString(), probes: [] };

// 1. 未登录时应读不到会话
report.probes.push(summarize("未登录 getSession", await cloud.auth.getSession()));

// 2. 未登录访问 5 张私有表：应被拒绝（RLS + 未授权角色）
for (const table of tables) {
  report.probes.push(summarize(`未登录读取 ${table}`, await cloud.database.from(table).select("*").limit(1)));
}

// 3. 认证数据面可达性：用不存在的账号登录，应得到凭据错误而不是网络/来源错误
report.probes.push(summarize("错误凭据登录探测", await cloud.auth.signInWithPassword({
  email: "probe-does-not-exist@example.invalid",
  password: "not-a-real-password"
})));

console.log(JSON.stringify(report, null, 2));
