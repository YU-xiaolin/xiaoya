// 账号隔离与账号标识测试。
//
// 关键背景（2026-10-12 实测）：云端 SDK 的会话对象里 user 只有
// {id, isAnonymous, raw}，不含手机号、邮箱与昵称；账号身份必须用 getUser()
// （/v1/user/me）查询。此前误以为会话里带手机号，导致界面与提示都无法正确
// 区分"手机号账号 / 微信账号"，本测试按真实形状覆盖。
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

// 真实会话形状：user 只有 {id, isAnonymous, raw}。
const REAL_SESSION_USER = { id: "2108097100506988544", isAnonymous: false, raw: { sub: "2108097100506988544" } };

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

test("账号标识优先使用 getUser 的身份，并遮盖敏感信息", () => {
  assert.equal(accountLabel({ user: REAL_SESSION_USER }, { phone: "+86 13675519415" }), "手机号 136****9415");
  assert.equal(accountLabel(null, { phone: "13800001234" }), "手机号 138****1234");
  assert.equal(accountLabel({ user: REAL_SESSION_USER }, { email: "parent@example.com" }), "邮箱 p***@example.com");
  assert.equal(accountLabel(null, { name: "小芽家长" }), "小芽家长（未绑定手机号）");
  assert.equal(accountLabel(null, { name: "13675519415" }), "已登录（未绑定手机号）", "纯数字昵称不当作账号标识");
  assert.equal(accountLabel({ user: { provider: "wechat" } }), "微信账号（未绑定手机号）");
  assert.equal(accountLabel({ user: REAL_SESSION_USER }), "已登录", "身份未加载时不冒充已绑定/未绑定");
  assert.equal(accountLabel(null, {}), "已登录（未绑定手机号）");
  assert.ok(!accountLabel(null, { phone: "+86 13675519415" }).includes("13675519415"), "不应显示完整手机号");
});

test("云端读不到课程且登的是微信账号：提示指向账号不互通", async () => {
  const restore = stubCloud({
    rows: [],
    session: { user: REAL_SESSION_USER },
    getUser: () => ({ data: { id: "x", provider: "wechat" }, error: null })
  });
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
  const restore = stubCloud({
    rows: [],
    session: { user: REAL_SESSION_USER },
    getUser: () => ({ data: null, error: new Error("unauthenticated") })
  });
  try {
    await withOnline(true, async () => {
      const result = await updateCourse();
      assert.equal(result.reason, "session-expired");
      assert.match(result.message, /登录状态已经失效/);
      assert.doesNotMatch(result.message, /还没有发布/);
    });
  } finally { restore(); }
});

test("账号正确但云端确实没有课程：提示去发布，并显示脱敏手机号", async () => {
  const restore = stubCloud({
    rows: [],
    session: { user: REAL_SESSION_USER },
    getUser: () => ({ data: { id: "x", phone: "+86 13675519415" }, error: null })
  });
  try {
    await withOnline(true, async () => {
      const result = await updateCourse();
      assert.equal(result.reason, "cloud-empty");
      assert.match(result.message, /手机号 136\*\*\*\*9415/);
      assert.match(result.message, /发布为新版本/);
      assert.doesNotMatch(result.message, /微信/);
    });
  } finally { restore(); }
});
