// 「读不到云端课程」的原因必须说清楚：登录失效 / 登错账号 / 云端确实没有，三种提示要分开。
// 同时校验家长管理标题栏的账号标识能区分登录方式（手机号 / 邮箱 / 微信 / WorkBuddy）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLabel, updateCourse } from "../src/sync.js";
import { cloud } from "../src/cloud.js";

function withOnline(value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: value }, configurable: true, writable: true });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete globalThis.navigator;
    });
}

// 让云端课程查询返回固定的行；同时把身份接口换成模拟值。
// 注意 cloud.auth.getUser() 的返回形状是 { data: user, error }（cloud.js 会再包一层）。
function stubCloud({ rows, session, getUser }) {
  const original = {
    from: cloud.database.from,
    getSession: cloud.auth.getSession,
    getUser: cloud.auth.getUser
  };
  cloud.database.from = () => {
    const query = {
      select() { return this; }, eq() { return this; }, neq() { return this; },
      order() { return this; }, limit() { return this; }, range() { return this; },
      then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); }
    };
    return query;
  };
  cloud.auth.getSession = async () => ({ data: session, error: null });
  cloud.auth.getUser = async () => getUser();
  return () => {
    cloud.database.from = original.from;
    cloud.auth.getSession = original.getSession;
    cloud.auth.getUser = original.getUser;
  };
}

test("账号标识区分登录方式，并遮盖敏感信息", () => {
  assert.equal(accountLabel({ user: { phone: "13800001234" } }), "手机号 138****1234");
  assert.equal(accountLabel({ user: { email: "parent@example.com" } }), "邮箱 p***@example.com");
  assert.equal(accountLabel({ user: { provider: "wechat", name: "小芽家长" } }), "微信账号（未绑定手机号）");
  assert.equal(accountLabel({ user: { provider: "workbuddy" } }), "WorkBuddy 账号（未绑定手机号）");
  assert.equal(accountLabel({ user: { name: "小芽家长" } }), "小芽家长（未绑定手机号）");
  assert.equal(accountLabel(null), "已登录（未绑定手机号）");
  assert.ok(!accountLabel({ user: { phone: "13800001234" } }).includes("13800001234"), "不应显示完整手机号");
});

test("云端读不到课程且当前是微信账号：提示指向账号不互通", async () => {
  const restore = stubCloud({ rows: [], session: { user: { provider: "wechat" } }, getUser: () => ({ data: { provider: "wechat" }, error: null }) });
  try {
    await withOnline(true, async () => {
      const result = await updateCourse();
      assert.equal(result.updated, false);
      assert.equal(result.reason, "wrong-account");
      assert.match(result.message, /微信账号/);
      assert.match(result.message, /手机号/);
      assert.doesNotMatch(result.message, /还没有发布/, "不应把账号问题说成家长没发布");
    });
  } finally { restore(); }
});

test("会话已失效：提示要求重新登录，而不是让家长去发布课程", async () => {
  const restore = stubCloud({ rows: [], session: { user: { phone: "13800001234" } }, getUser: () => ({ data: null, error: new Error("unauthenticated") }) });
  try {
    await withOnline(true, async () => {
      const result = await updateCourse();
      assert.equal(result.reason, "session-expired");
      assert.match(result.message, /登录状态已经失效/);
      assert.doesNotMatch(result.message, /还没有发布/);
    });
  } finally { restore(); }
});

test("账号正确但云端确实没有课程：才提示去发布新版本", async () => {
  const restore = stubCloud({ rows: [], session: { user: { phone: "13800001234" } }, getUser: () => ({ data: { phone: "13800001234" }, error: null }) });
  try {
    await withOnline(true, async () => {
      const result = await updateCourse();
      assert.equal(result.reason, "cloud-empty");
      assert.match(result.message, /发布为新版本/);
      assert.doesNotMatch(result.message, /微信/);
    });
  } finally { restore(); }
});
