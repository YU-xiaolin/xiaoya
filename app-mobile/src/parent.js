// 家长管理界面：登录、两个同步按钮、记录查看与导出、课程导入与发布。
// 管理能力不依赖前端隐藏按钮——所有读写都由云端 RLS 按登录账号校验。
import * as cloudApi from "./cloud.js";
import {
  SyncError, accountLabel, currentSession, fetchLocalRecords, fetchRemoteRecords,
  buildRecordBundle, localSessionCount, publishCoursePackage, requireSignedIn,
  updateCourse, uploadLearningRecords, FAMILY_PACKAGE_KEY,
  inspectPackagePayload, replaceActivePackage, rollbackActivePackage
} from "./sync.js";
import { listCourseVersions } from "./cloud.js";
import { analyzeSessions, mergeCatalogProgress, reviewPriorities, dailyTrend } from "./analysis.js";
import { APP_VERSION, DEFAULT_STUDENT_CODE, PROTOCOLS } from "./config.js";
import { listLogs } from "./db.js";
import { deviceCode, packageInfo, setStudentCode, studentCode, sha256Hex } from "./store.js";
import { clearAccountCaches } from "./sw-bridge.js";
import { voiceStatus, onVoiceStatusChange, prepareOfflineVoices } from "./voice.js";
import { captureFocus, restoreFocus } from "./focus-keep.js";
import { validateSessionPayload } from "./session-validation.js";

// 登录门禁的输入框：重绘后据此把焦点与光标交还给同一个输入框。
const LOGIN_INPUT_ATTRS = [
  "data-login-phone", "data-login-code", "data-login-email",
  "data-login-password", "data-login-email-code", "data-login-new-password"
];

function loginInputSelector(node) {
  const attr = LOGIN_INPUT_ATTRS.find(name => node.hasAttribute(name));
  return attr ? `[${attr}]` : null;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function downloadJson(fileName, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function pickJsonFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, text: await file.text() });
      } catch (error) {
        resolve({ name: file.name, error });
      }
    };
    input.click();
  });
}

export function createParentApp({ root, toast, getPackage, reload, onExit, onSetParentPin, onClearParentPin, onLocalCleared }) {
  const state = {
    view: "home",
    // 门禁状态：只有 main.js 通过统一入口解锁后才会置为 true。
    // 所有家长动作在 handler 里再次校验，防止另一个 root 监听器绕过 PIN 直接触发。
    unlocked: false,
    session: null,
    busy: false,
    notice: null,
    error: null,
    uploadResult: null,
    courseResult: null,
    remoteRecords: [],
    localRecords: [],
    versions: [],
    voice: { source: "device", clipCount: 0 },
    voiceDownloadProgress: "",
    pendingOtp: null,
    pendingEmail: null,
    loginTab: "phone",
    phone: "",
    phoneError: "",
    phoneCode: "",
    email: "",
    password: "",
    emailCode: "",
    newPassword: "",
    resetMode: false,
    // 验证码重发倒计时（秒），避免连续点击。
    resendCooldown: 0
  };

  let resendTimer = null;

  // 倒计时只更新「获取验证码」按钮上的文字与可用状态，绝不整页重绘。
  // 整页重绘会销毁正在输入的验证码输入框：手机上软键盘会被系统收起，
  // 已输入的验证码也会消失，导致家长无法输入验证码。
  function updateResendControls() {
    const cooling = state.resendCooldown > 0;
    const label = cooling ? `${state.resendCooldown}s 后可重发` : "获取验证码";
    for (const node of root.querySelectorAll("[data-action='send-phone-code'], [data-action='send-email-code']")) {
      node.textContent = label;
      node.disabled = cooling || state.busy;
    }
  }

  function startResendCooldown(seconds = 60) {
    state.resendCooldown = seconds;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      state.resendCooldown -= 1;
      if (state.resendCooldown <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
        state.resendCooldown = 0;
      }
      updateResendControls();
    }, 1000);
    updateResendControls();
  }

  let rerenderQueued = false;
  let hasRendered = false;

  // 语音状态回调可能在 createParentApp 内同步触发，因此这两个变量必须先声明，
  // 且只有界面真正渲染过之后才安排重绘，避免启动时覆盖孩子的首页。
  function scheduleRerender() {
    if (!hasRendered || !state.unlocked || !isVisible() || rerenderQueued) return;
    rerenderQueued = true;
    queueMicrotask(() => { rerenderQueued = false; render(); });
  }

  onVoiceStatusChange(status => {
    state.voice = status;
    if (state.view === "settings" || state.view === "home") scheduleRerender();
  });

  async function refreshSession() {
    state.session = await currentSession();
    return state.session;
  }

  function noticeHtml() {
    if (state.error) return `<div class="notice error">${escapeHtml(state.error)}</div>`;
    if (state.notice) return `<div class="notice ok">${escapeHtml(state.notice)}</div>`;
    return "";
  }

  /* ---------------- 登录 ---------------- */

  function renderGate() {
    const tab = state.loginTab;
    const cooling = state.resendCooldown > 0;
    const sendLabel = cooling ? `${state.resendCooldown}s 后可重发` : "获取验证码";
    const pendingPhone = state.pendingOtp;
    const pendingEmail = state.pendingEmail;
    const focusSnapshot = captureFocus(root, loginInputSelector);
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="exit-parent" aria-label="返回">←</button>
          <div class="topbar-title"><h1>家长管理</h1><p>需要家庭账号才能上传记录与更新课程</p></div>
        </header>
        ${noticeHtml()}
        <section class="login-card">
          <div class="login-tabs">
            <button class="tab ${tab === "phone" ? "active" : ""}" data-login-tab="phone">手机号</button>
            <button class="tab ${tab === "email" ? "active" : ""}" data-login-tab="email">邮箱</button>
          </div>
          ${tab === "phone" ? `
            <label class="field"><span>手机号</span><input type="tel" inputmode="numeric" autocomplete="tel" data-login-phone placeholder="11 位手机号" value="${escapeHtml(state.phone)}"></label>
            ${state.phoneError ? `<p class="field-error">${escapeHtml(state.phoneError)}</p>` : ""}
            <label class="field"><span>短信验证码</span>
              <div class="code-row"><input type="text" inputmode="numeric" autocomplete="one-time-code" data-login-code placeholder="6 位验证码" value="${escapeHtml(state.phoneCode)}">
              <button class="button secondary" data-action="send-phone-code" ${state.busy || cooling ? "disabled" : ""}>${sendLabel}</button></div>
            </label>
            ${pendingPhone ? `<p class="hint-text">已为 ${escapeHtml(pendingPhone.phone)} 发送验证码；${pendingPhone.isExistingUser ? "该号码已有账号，登录后即可使用。" : "首次使用会创建新账号。"}</p>` : ""}
            <button class="button primary big" data-action="submit-phone" ${state.busy ? "disabled" : ""}>登录 / 注册</button>
            <p class="hint-text">第一次使用会为你创建家庭账号；不会展示某个号码是否已注册。</p>
          ` : `
            <label class="field"><span>邮箱</span><input type="email" autocomplete="email" data-login-email placeholder="you@example.com" value="${escapeHtml(state.email)}"></label>
            <label class="field"><span>密码</span><input type="password" autocomplete="current-password" data-login-password placeholder="邮箱登录密码" value="${escapeHtml(state.password)}"></label>
            <button class="button primary big" data-action="submit-password" ${state.busy ? "disabled" : ""}>用密码登录</button>
            <div class="divider"><span>或者用邮箱验证码</span></div>
            <label class="field"><span>邮箱验证码</span>
              <div class="code-row"><input type="text" inputmode="numeric" data-login-email-code placeholder="6 位验证码" value="${escapeHtml(state.emailCode)}">
              <button class="button secondary" data-action="send-email-code" ${state.busy || cooling ? "disabled" : ""}>${sendLabel}</button></div>
            </label>
            ${state.resetMode ? `<label class="field"><span>新密码（忘记密码时填写）</span><input type="password" data-login-new-password placeholder="新密码" value="${escapeHtml(state.newPassword)}"></label>` : ""}
            ${pendingEmail ? `<p class="hint-text">已为 ${escapeHtml(pendingEmail.email)} 发送验证码。${state.resetMode ? "请填写新密码后重设。" : ""}</p>` : ""}
            <button class="button primary big" data-action="submit-email-code" ${state.busy ? "disabled" : ""}>${state.resetMode ? "重设密码并登录" : "用验证码登录 / 注册"}</button>
            <button class="text-back" data-action="toggle-reset">${state.resetMode ? "返回普通登录" : "忘记密码？"}</button>
            <p class="hint-text">新邮箱首次使用需要设置密码；已注册账号只用验证码也可以登录。</p>
          `}
        </section>
        <section class="oauth-card">
          <p>也可以使用 WorkBuddy 账号登录（需要先打开过正式发布的网址）</p>
          <button class="button secondary" data-action="oauth-workbuddy" ${state.busy ? "disabled" : ""}>WorkBuddy 账号登录</button>
          <button class="button secondary" data-action="oauth-wechat" ${state.busy ? "disabled" : ""}>微信扫码登录</button>
          <p class="hint-text">注意：WorkBuddy 账号 / 微信扫码登录会创建一个<b>独立的家庭账号</b>，与手机号账号的学习记录、课程<b>互不相通</b>，也无法合并。家里的账号请统一使用<b>手机号 + 验证码</b>登录。</p>
        </section>
      </main>`;
    restoreFocus(root, focusSnapshot);
  }

  /* ---------------- 主页 ---------------- */

  async function renderHome() {
    const counts = await localSessionCount();
    const info = await packageInfo();
    const code = await studentCode();
    const session = state.session;
    const lastUpload = counts.uploaded
      ? (await lastUploadTime())
      : null;
    if (!canRender("home")) return;
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="exit-parent" aria-label="返回">←</button>
          <div class="topbar-title"><h1>家长管理</h1><p>${escapeHtml(accountLabel(session))} · 学生编号 ${escapeHtml(code)}</p></div>
        </header>
        ${noticeHtml()}
        <section class="sync-card">
          <div class="sync-head"><span>📤</span><div><strong>按钮一 · 上传学习记录</strong><p>把手机上还没上传的作答记录发送到云端。</p></div></div>
          <div class="sync-stats">
            <div><small>本地记录</small><strong>${counts.total}</strong></div>
            <div><small>待上传</small><strong class="${counts.pending ? "warn-text" : ""}">${counts.pending}</strong></div>
            <div><small>已上传</small><strong>${counts.uploaded}</strong></div>
          </div>
          <div class="sync-meta">最近上传：${escapeHtml(formatTime(lastUpload))}</div>
          <button class="button primary big" data-action="upload" ${state.busy ? "disabled" : ""}>${state.busy ? "正在处理…" : "上传学习记录"}</button>
          ${state.uploadResult ? `<div class="result-box">${renderUploadResult(state.uploadResult)}</div>` : ""}
        </section>
        <section class="sync-card">
          <div class="sync-head"><span>📥</span><div><strong>按钮二 · 更新学习课程</strong><p>检查云端是否有新课程，并保存到这台手机。</p></div></div>
          <div class="sync-stats">
            <div><small>本地课程版本</small><strong>${info.version || 0}</strong></div>
            <div><small>课程来源</small><strong class="small-strong">${escapeHtml(info.source || "内置")}</strong></div>
          </div>
          <div class="sync-meta">课程编号：${escapeHtml(info.lessonId || "—")}<br>保存时间：${escapeHtml(formatTime(info.receivedAt))}</div>
          <button class="button primary big" data-action="update-course" ${state.busy ? "disabled" : ""}>${state.busy ? "正在处理…" : "更新学习课程"}</button>
          ${state.courseResult ? `<div class="result-box">${renderCourseResult(state.courseResult)}</div>` : ""}
        </section>
        <section class="link-list">
          <button class="link-row" data-action="open-records"><span>📚</span><div><strong>查看与导出学习记录</strong><p>按日期下载标准 JSON，供 ChatGPT Work 分析</p></div><b>→</b></button>
          <button class="link-row" data-action="open-course"><span>🧩</span><div><strong>导入并发布新课程</strong><p>导入 ChatGPT Work 生成的课程 JSON</p></div><b>→</b></button>
          <button class="link-row" data-action="open-mastery"><span>📈</span><div><strong>掌握情况与错题</strong><p>查看每个知识点的真实作答证据</p></div><b>→</b></button>
          <button class="link-row" data-action="open-settings"><span>⚙️</span><div><strong>设置与备份</strong><p>学生编号、语音状态、原始数据备份</p></div><b>→</b></button>
        </section>
      </main>`;
  }

  async function lastUploadTime() {
    const logs = await listLogs(50);
    const entry = logs.find(log => log.type === "sync" && log.action === "upload");
    return entry?.at || null;
  }

  function renderUploadResult(result) {
    if (!result.uploaded) return `<strong>${escapeHtml(result.message || "没有需要上传的记录。")}</strong>`;
    return `<strong>${escapeHtml(result.message)}</strong><span>本次上传 ${result.uploaded} 份 · 仍待上传 ${result.pendingAfter} 份</span><span>完成时间：${escapeHtml(formatTime(result.uploadedAt))}</span>
      ${result.failures?.length ? `<span class="warn-text">${result.failures.length} 份失败：${escapeHtml(result.failures[0].message)}</span>` : ""}`;
  }

  function renderCourseResult(result) {
    if (!result.updated) return `<strong>${escapeHtml(result.message)}</strong>`;
    return `<strong>${escapeHtml(result.message)}</strong><span>版本：第 ${result.version} 版 · 发布时间：${escapeHtml(formatTime(result.publishedAt))}</span><span>课程编号：${escapeHtml(result.lessonId || "—")} · 待上传记录仍为 ${result.pendingSessions} 份（未被覆盖）</span>`;
  }

  /* ---------------- 记录 ---------------- */

  async function renderRecords() {
    const local = await fetchLocalRecords();
    const localBundle = buildRecordBundle(local, { source: "phone-local" });
    const analysis = analyzeSessions(local);
    const trend = dailyTrend(analysis);
    const records = state.remoteRecords.length ? state.remoteRecords : local;
    if (!canRender("records")) return;
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="parent-home" aria-label="返回">←</button>
          <div class="topbar-title"><h1>学习记录</h1><p>本地 ${local.length} 份 · 云端 ${state.remoteRecords.length} 份</p></div>
        </header>
        ${noticeHtml()}
        <section class="button-row">
          <button class="button secondary" data-action="load-remote" ${state.busy ? "disabled" : ""}>读取云端记录</button>
          <button class="button secondary" data-action="export-local">导出本地 JSON</button>
          <button class="button secondary" data-action="export-remote">导出云端 JSON</button>
        </section>
        <section class="button-row">
          <label class="date-field">起始日期 <input type="date" data-since-date></label>
          <button class="button secondary" data-action="export-since">导出该日期之后</button>
        </section>
        <section class="stat-grid">
          <div class="stat"><small>本节数</small><strong>${analysis.sessionCount}</strong></div>
          <div class="stat"><small>作答事件</small><strong>${analysis.totals.events}</strong></div>
          <div class="stat"><small>答对</small><strong>${analysis.totals.correct}</strong></div>
          <div class="stat"><small>答错</small><strong>${analysis.totals.incorrect}</strong></div>
        </section>
        <h3 class="section-title">最近记录</h3>
        <section class="record-list">${records.slice(-40).reverse().map(row => {
          const payload = row.payload || row;
          const events = Array.isArray(payload.events) ? payload.events.length : (row.event_count || 0);
          const endedAt = payload.endedAt || row.ended_at || payload.startedAt || row.started_at;
          return `<div class="record-row"><div><strong>${escapeHtml(formatTime(endedAt))}</strong><span>${escapeHtml(payload.activityMode || row.activity_mode || "学习")} · ${events} 条作答 · ${payload.completed ? "已完成" : "中途结束"}</span></div><small>${escapeHtml(payload.sessionId || row.session_id || "")}</small></div>`;
        }).join("") || `<p class="empty">还没有学习记录。孩子完成一次学习后会自动保存在手机上。</p>`}</section>
        <h3 class="section-title">每日趋势</h3>
        <section class="trend-list">${trend.length ? trend.map(day => `
          <div class="trend-row"><span>${escapeHtml(day.day.slice(5))}</span><div class="trend-bar"><i style="width:${day.accuracy ?? 0}%"></i></div><small>${day.sessions} 节 · 正确率 ${day.accuracy ?? "—"}%</small></div>`).join("") : `<p class="empty">暂无趋势数据。</p>`}</section>
        <p class="hint-text">导出文件协议：${PROTOCOLS.recordBundle}，可直接交给 ChatGPT Work 分析。</p>
      </main>`;
  }

  /* ---------------- 掌握情况 ---------------- */

  async function renderMastery() {
    const pkg = await getPackage();
    const local = await fetchLocalRecords();
    const analysis = analyzeSessions(local);
    const catalog = mergeCatalogProgress(pkg?.package?.catalog || {}, analysis);
    const priorities = reviewPriorities(catalog, analysis);
    const summary = pkg?.package?.summary || {};
    // 掌握进度由本机真实作答记录推导，不来自公开课程包。
    const observed = subject => catalog[subject].filter(item => item.observed).length;
    const stable = catalog.hanzi.filter(item => item.observed?.stableByRule).length;
    if (!canRender("mastery")) return;
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="parent-home" aria-label="返回">←</button>
          <div class="topbar-title"><h1>掌握情况</h1><p>基于本机真实作答证据，不推断未验证的状态</p></div>
        </header>
        ${noticeHtml()}
        <section class="stat-grid">
          <div class="stat"><small>本机有作答记录的汉字</small><strong>${observed("hanzi")}</strong></div>
          <div class="stat"><small>本机有作答记录的字母</small><strong>${observed("english_letter")}</strong></div>
          <div class="stat"><small>本机有作答记录的数学目标</small><strong>${observed("math")}</strong></div>
          <div class="stat"><small>符合稳定掌握规则</small><strong>${stable}</strong></div>
        </section>
        <h3 class="section-title">需要优先复习</h3>
        <section class="review-list">${priorities.length ? priorities.slice(0, 40).map(item => `
          <div class="review-row">
            <b>${escapeHtml(item.display)}</b>
            <div><span>${escapeHtml(item.subject === "hanzi" ? "汉字" : item.subject === "math" ? "数学" : "字母")}</span>
            <small>错误 ${item.incorrect} 次 · 最近 ${escapeHtml(formatTime(item.lastSeenAt))}</small></div>
          </div>`).join("") : `<p class="empty">还没有需要复习的内容。</p>`}</section>
        <p class="hint-text">稳定掌握需要至少 3 个不同场次的独立答对，并覆盖至少 2 种证据模式；提示后答对仍计为薄弱证据。</p>
        <p class="hint-text">课程规模：汉字 ${summary.hanziTotal || 0} · 字母 ${summary.letterTotal || 0} · 数学 ${summary.mathTotal || 0}。公开课程包只包含课程定义，家庭学习进度保存在这台手机上。</p>
      </main>`;
  }

  /* ---------------- 课程 ---------------- */

  async function renderCourse() {
    if (state.session && !state.versions.length) {
      try { state.versions = await listCourseVersions(FAMILY_PACKAGE_KEY, 20); } catch { state.versions = []; }
    }
    const info = await packageInfo();
    if (!canRender("course")) return;
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="parent-home" aria-label="返回">←</button>
          <div class="topbar-title"><h1>课程管理</h1><p>导入 ChatGPT Work 生成的课程并发布到云端</p></div>
        </header>
        ${noticeHtml()}
        <section class="sync-card">
          <div class="sync-head"><span>🧩</span><div><strong>导入课程 JSON</strong><p>支持完整课程包，或单独的 next-lesson.json 课程文件。</p></div></div>
          <button class="button secondary" data-action="import-course">选择课程文件</button>
          <button class="button secondary" data-action="import-package">选择完整课程包文件</button>
          <button class="button danger" data-action="rollback-course">回滚到上一版课程</button>
          <div class="sync-meta">当前本地课程：第 ${info.version || 0} 版 · ${escapeHtml(info.lessonId || "—")}</div>
          <p class="hint-text">导入前会做完整校验（协议、目录编号、课程引用、题量与选项约束），校验不通过的课程不会替换当前课程。</p>
        </section>
        <section class="sync-card">
          <div class="sync-head"><span>🚀</span><div><strong>发布到云端</strong><p>发布后手机点击“更新学习课程”即可获取。</p></div></div>
          <button class="button primary big" data-action="publish-current" ${state.busy ? "disabled" : ""}>把当前课程发布为新版本</button>
          <button class="button secondary" data-action="reload-versions" ${state.busy ? "disabled" : ""}>刷新版本历史</button>
          ${state.courseResult ? `<div class="result-box">${renderCourseResult(state.courseResult)}</div>` : ""}
        </section>
        <h3 class="section-title">版本历史</h3>
        <section class="record-list">${state.versions.length ? state.versions.map(row => `
          <div class="record-row"><div><strong>第 ${row.version} 版${row.is_active ? " · 当前生效" : ""}</strong><span>${escapeHtml(row.title || "课程包")} · ${escapeHtml(formatTime(row.published_at))}</span></div><small>${escapeHtml((row.payload_sha256 || "").slice(0, 10))}…</small></div>`).join("") : `<p class="empty">云端还没有课程版本。</p>`}</section>
      </main>`;
  }

  /* ---------------- 设置 ---------------- */

  async function renderSettings() {
    const code = await studentCode();
    const device = await deviceCode();
    const info = await packageInfo();
    const logs = await listLogs(20);
    if (!canRender("settings")) return;
    root.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <button class="icon-button" data-action="parent-home" aria-label="返回">←</button>
          <div class="topbar-title"><h1>设置与备份</h1><p>${escapeHtml(accountLabel(state.session))}</p></div>
        </header>
        ${noticeHtml()}
        <section class="sync-card">
          <div class="sync-head"><span>🧒</span><div><strong>学生编号</strong><p>匿名编号，用于区分同一个家庭里的不同孩子，不采集真实姓名。</p></div></div>
          <label class="field"><span>当前编号</span><input type="text" data-student-code value="${escapeHtml(code)}"></label>
          <button class="button secondary" data-action="save-student-code">保存编号</button>
          <div class="sync-meta">设备编号：${escapeHtml(device)}</div>
        </section>
        <section class="sync-card">
          <div class="sync-head"><span>🔒</span><div><strong>家长密码</strong><p>只用于防止孩子在手机上误进家长管理；真正的数据权限由云端账号校验。</p></div></div>
          <label class="field"><span>设置 4～8 位数字密码</span><input type="password" inputmode="numeric" data-parent-pin placeholder="留空表示不修改"></label>
          <div class="button-row">
            <button class="button secondary" data-action="save-parent-pin">设置 / 修改</button>
            <button class="button danger" data-action="clear-parent-pin">取消家长密码</button>
          </div>
        </section>
        <section class="sync-card">
          <div class="sync-head"><span>🔊</span><div><strong>学习语音</strong><p>${state.voice.source === "pack" ? `已载入晓伊自然语音清单（${state.voice.clipCount} 条）。当前课程语音会自动准备；首次下载全部语音约 120 MB，建议联网时完成。播放失败时，题目下方会显示重试按钮。` : "自然语音清单暂时不可用，播放时会尝试手机中文语音；可联网后重新打开。"}</p></div></div>
          <button class="button secondary" data-action="download-voices" ${state.busy ? "disabled" : ""}>下载全部离线语音</button>
          <p class="hint-text" data-voice-progress role="status">${escapeHtml(state.voiceDownloadProgress)}</p>
        </section>
        <section class="sync-card">
          <div class="sync-head"><span>💾</span><div><strong>原始数据备份</strong><p>导出手机上的全部原始记录，可在换手机后恢复。</p></div></div>
          <button class="button secondary" data-action="backup">导出备份 JSON</button>
          <button class="button secondary" data-action="restore">从备份文件恢复</button>
          <button class="button danger" data-action="clear-local">清空本机记录（需二次确认）</button>
        </section>
        <h3 class="section-title">最近操作</h3>
        <section class="record-list">${logs.length ? logs.map(log => `
          <div class="record-row"><div><strong>${escapeHtml(log.type)} · ${escapeHtml(log.action)}</strong><span>${escapeHtml(formatTime(log.at))}</span></div></div>`).join("") : `<p class="empty">暂无操作记录。</p>`}</section>
        <div class="version-line">应用版本 ${APP_VERSION} · 协议 ${PROTOCOLS.session}</div>
        <button class="button secondary" data-action="sign-out">退出登录</button>
      </main>`;
  }

  /* ---------------- 渲染入口 ---------------- */

  // 由 main.js 在所有门禁检查通过后调用；这是唯一的解锁入口。
  function unlock() {
    state.unlocked = true;
  }

  // 离开家长模式时立刻上锁，下一次进入必须重新通过 PIN（若已设置）。
  function lock() {
    state.unlocked = false;
    state.view = "home";
    state.error = null;
    state.notice = null;
    state.pendingOtp = null;
    state.pendingEmail = null;
    state.resendCooldown = 0;
  }

  // 家长界面是否正显示在屏幕上：用于判断「已解锁」是否仍然有效。
  // 一旦界面被孩子界面覆盖（例如孩子点了返回首页），解锁状态立即作废。
  function isVisible() {
    return root.dataset.appMode === "parent";
  }

  function canRender(view) {
    return state.unlocked && isVisible() && state.view === view;
  }

  async function render() {
    if (!state.unlocked) return;
    root.dataset.appMode = "parent";
    await refreshSession();
    if (!state.unlocked || !isVisible()) return;
    hasRendered = true;
    if (!state.session) return renderGate();
    switch (state.view) {
      case "records": return renderRecords();
      case "mastery": return renderMastery();
      case "course": return renderCourse();
      case "settings": return renderSettings();
      default: return renderHome();
    }
  }

  async function guard(work) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    state.notice = null;
    render();
    try {
      await work();
    } catch (error) {
      state.error = error instanceof SyncError ? error.message : cloudApi.describeError(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  /* ---------------- 事件 ---------------- */

  // 登录输入框的即时同步：任何一次重绘（例如切换登录方式、出现错误提示）
  // 都不会丢失已经输入的内容；手机上也不会因为重绘而清空验证码。
  root.addEventListener("input", event => {
    const node = event.target;
    if (!node || typeof node.hasAttribute !== "function") return;
    if (node.hasAttribute("data-login-phone")) state.phone = node.value;
    else if (node.hasAttribute("data-login-code")) state.phoneCode = node.value;
    else if (node.hasAttribute("data-login-email")) state.email = node.value;
    else if (node.hasAttribute("data-login-password")) state.password = node.value;
    else if (node.hasAttribute("data-login-email-code")) state.emailCode = node.value;
    else if (node.hasAttribute("data-login-new-password")) state.newPassword = node.value;
  });

  root.addEventListener("click", async event => {
    if (event.target.closest("button:disabled") || event.detail > 1) return;
    // PIN 输入界面由 main.js 接管；家长页不应响应 PIN 键盘上的点击。
    if (event.target.closest("[data-pin]")) return;
    // 门禁守卫：家长处理器只处理「已经解锁的家长界面」上的动作，
    // 避免孩子界面上的同名 action（例如 parent-home）绕过 PIN。
    if (!state.unlocked) return;
    const loginTab = event.target.closest("[data-login-tab]")?.dataset.loginTab;
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action && !loginTab) return;
    if (loginTab) { state.loginTab = loginTab; state.error = null; return render(); }

    switch (action) {
      case "exit-parent":
        lock();
        onExit?.();
        break;
      // 家长页内部的「返回」：只回到家长首页，不退出家长模式、不需要重新输入 PIN。
      case "parent-home": state.view = "home"; render(); break;
      case "open-records": state.view = "records"; render(); break;
      case "open-mastery": state.view = "mastery"; render(); break;
      case "open-course": state.view = "course"; render(); break;
      case "open-settings": state.view = "settings"; render(); break;

      case "send-phone-code": {
        const phone = document.querySelector("[data-login-phone]")?.value?.trim() || "";
        state.phone = phone;
        if (!/^1\d{10}$/.test(phone)) {
          state.phoneError = "请输入正确的 11 位手机号";
          return render();
        }
        state.phoneError = "";
        await guard(async () => {
          const challenge = await cloudApi.sendOtp({ phone });
          // 保留同一个挑战与 isExistingUser 标记，供 submit 时选择登录/注册分支。
          state.pendingOtp = { phone, ...challenge };
          state.notice = "验证码已发送，请查看短信。";
        });
        if (!state.error) startResendCooldown(60);
        break;
      }
      case "submit-phone": {
        const phone = document.querySelector("[data-login-phone]")?.value?.trim() || "";
        const token = document.querySelector("[data-login-code]")?.value?.trim() || "";
        state.phone = phone;
        const pending = state.pendingOtp;
        if (!pending || pending.phone !== phone) {
          state.error = "请先为当前手机号获取验证码。";
          return render();
        }
        if (!token) {
          state.error = "请输入收到的验证码。";
          return render();
        }
        await guard(async () => {
          await cloudApi.verifyOtp({
            phone: pending.phone,
            verificationId: pending.verificationId,
            token,
            isExistingUser: pending.isExistingUser
          });
          state.pendingOtp = null;
          state.phoneCode = "";
          state.resendCooldown = 0;
          state.notice = "登录成功。";
          state.view = "home";
        });
        break;
      }
      case "send-email-code": {
        const email = document.querySelector("[data-login-email]")?.value?.trim() || "";
        state.email = email;
        if (!email) { state.error = "请先填写邮箱。"; return render(); }
        await guard(async () => {
          if (state.resetMode) {
            // 忘记密码：在「获取验证码」时创建重置挑战，提交时复用同一个挑战。
            const challenge = await cloudApi.resetPasswordForEmail(email);
            state.pendingEmail = { email, reset: true, challenge, isExistingUser: true };
          } else {
            const challenge = await cloudApi.sendOtp({ email });
            state.pendingEmail = { email, reset: false, ...challenge };
          }
          state.notice = "验证码已发送到邮箱。";
        });
        if (!state.error) startResendCooldown(60);
        break;
      }
      case "submit-email-code": {
        const email = document.querySelector("[data-login-email]")?.value?.trim() || "";
        const token = document.querySelector("[data-login-email-code]")?.value?.trim() || "";
        const password = document.querySelector("[data-login-password]")?.value || "";
        const newPassword = document.querySelector("[data-login-new-password]")?.value || "";
        state.email = email;
        state.password = password;
        state.emailCode = token;
        const pending = state.pendingEmail;
        if (!pending || pending.email !== email) {
          state.error = "请先为当前邮箱获取验证码。";
          return render();
        }
        if (!token) {
          state.error = "请输入收到的验证码。";
          return render();
        }
        if (state.resetMode && !newPassword) {
          state.error = "请输入新密码后再重设。";
          return render();
        }
        await guard(async () => {
          if (state.resetMode && pending.reset) {
            await pending.challenge.updateUser({ nonce: token, password: newPassword });
          } else {
            await cloudApi.verifyOtp({
              email: pending.email,
              verificationId: pending.verificationId,
              token,
              password: pending.isExistingUser ? undefined : password,
              isExistingUser: pending.isExistingUser
            });
          }
          state.pendingEmail = null;
          state.resetMode = false;
          state.password = "";
          state.emailCode = "";
          state.newPassword = "";
          state.resendCooldown = 0;
          state.notice = "登录成功。";
          state.view = "home";
        });
        break;
      }
      case "submit-password": {
        const email = document.querySelector("[data-login-email]")?.value?.trim() || "";
        const password = document.querySelector("[data-login-password]")?.value || "";
        state.email = email;
        state.password = password;
        await guard(async () => {
          await cloudApi.signInWithPassword({ email, password });
          state.notice = "登录成功。";
          state.view = "home";
        });
        break;
      }
      case "toggle-reset":
        state.resetMode = !state.resetMode;
        // 切换登录方式时丢弃上一个模式的验证码挑战，避免用错挑战。
        state.pendingEmail = null;
        state.resendCooldown = 0;
        state.error = null;
        state.notice = null;
        render();
        break;
      case "oauth-workbuddy":
      case "oauth-wechat": {
        const provider = action === "oauth-wechat" ? "wechat" : "workbuddy";
        await guard(async () => {
          const url = await cloudApi.startOAuth(provider);
          if (!url) throw new Error("无法获取授权地址。");
          location.assign(url);
        });
        break;
      }

      case "upload":
        await guard(async () => {
          state.uploadResult = await uploadLearningRecords();
          state.notice = state.uploadResult.message;
        });
        break;
      case "update-course":
        await guard(async () => {
          state.courseResult = await updateCourse();
          state.notice = state.courseResult.message;
          if (state.courseResult.updated) await reload();
        });
        break;
      case "load-remote":
        await guard(async () => {
          state.remoteRecords = await fetchRemoteRecords();
          state.notice = `已从云端读取 ${state.remoteRecords.length} 份记录。`;
        });
        break;
      case "export-local": {
        const local = await fetchLocalRecords();
        downloadJson(`xiaoya-records-local-${Date.now()}.json`, buildRecordBundle(local, { source: "phone-local" }));
        state.notice = `已导出本地 ${local.length} 份记录。`;
        render();
        break;
      }
      case "export-remote": {
        await guard(async () => {
          if (!state.remoteRecords.length) {
            // 读取失败必须如实报错，不能伪装成「导出 0 份」。
            state.remoteRecords = await fetchRemoteRecords();
          }
          downloadJson(`xiaoya-records-cloud-${Date.now()}.json`, buildRecordBundle(state.remoteRecords, { source: "cloud" }));
          state.notice = `已导出云端 ${state.remoteRecords.length} 份记录。`;
        });
        break;
      }
      case "export-since": {
        const since = document.querySelector("[data-since-date]")?.value;
        if (!since) { state.error = "请先选择起始日期。"; render(); break; }
        const iso = new Date(`${since}T00:00:00`).toISOString();
        await guard(async () => {
          const records = await fetchRemoteRecords({ since: iso });
          downloadJson(`xiaoya-records-since-${since}.json`, buildRecordBundle(records, { source: "cloud", studentCodeValue: await studentCode() }));
          state.notice = `已导出 ${records.length} 份记录。`;
          state.remoteRecords = records;
        });
        break;
      }

      case "import-course":
      case "import-package": {
        const file = await pickJsonFile();
        if (!file) break;
        if (file.error) { state.error = "读取文件失败。"; render(); break; }
        await guard(async () => {
          let parsed;
          try {
            parsed = JSON.parse(file.text);
          } catch {
            throw new SyncError("文件不是有效的 JSON。", "invalid-file");
          }
          const pkg = await getPackage();
          if (action === "import-course") {
            const lesson = parsed?.lesson && parsed.protocol === PROTOCOLS.coursePackage ? parsed.lesson : parsed;
            const nextPackage = {
              ...pkg.package,
              generatedAt: new Date().toISOString(),
              source: "parent-import",
              lesson
            };
            // 与完整课程包共用同一套校验：先校验预览，再原子替换。
            const check = inspectPackagePayload(nextPackage);
            if (!check.ok) throw new SyncError(`课程文件未通过校验：${check.errors[0]}`, "invalid-payload");
            await replaceActivePackage({ payload: nextPackage, version: pkg.version || 0, source: "parent-import" });
            state.notice = `已导入课程“${lesson?.title || "未命名"}”，${lesson?.tasks?.length || 0} 道题。请点击“发布到云端”。`;
          } else {
            const check = inspectPackagePayload(parsed);
            if (!check.ok) throw new SyncError(`课程包未通过校验：${check.errors[0]}`, "invalid-payload");
            await replaceActivePackage({ payload: parsed, version: pkg.version || 0, source: "parent-import" });
            const c = check.preview.counts;
            state.notice = `已导入完整课程包（汉字 ${c.hanzi} · 字母 ${c.english_letter} · 数学 ${c.math} · 课程题 ${c.lessonTasks}）。请点击“发布到云端”。`;
          }
          await reload();
        });
        break;
      }
      case "rollback-course":
        await guard(async () => {
          const restored = await rollbackActivePackage();
          state.notice = `已回滚到上一版课程（第 ${restored.version ?? 0} 版）。`;
          await reload();
        });
        break;
      case "publish-current":
        await guard(async () => {
          const pkg = await getPackage();
          if (!pkg?.package) throw new Error("本地还没有可发布的课程包。");
          const result = await publishCoursePackage(pkg.package, { source: "parent-web" });
          state.courseResult = { updated: true, version: result.version, publishedAt: new Date().toISOString(), lessonId: pkg.package.lesson?.lessonId, pendingSessions: (await localSessionCount()).pending, message: `已发布第 ${result.version} 版课程。` };
          state.notice = state.courseResult.message;
          state.versions = await listCourseVersions(FAMILY_PACKAGE_KEY, 20);
        });
        break;
      case "reload-versions":
        await guard(async () => {
          state.versions = await listCourseVersions(FAMILY_PACKAGE_KEY, 20);
          state.notice = `云端共有 ${state.versions.length} 个版本。`;
        });
        break;

      case "save-student-code": {
        const value = document.querySelector("[data-student-code]")?.value || "";
        await setStudentCode(value);
        state.notice = "学生编号已保存。";
        render();
        break;
      }
      case "backup": {
        const local = await fetchLocalRecords();
        downloadJson(`xiaoya-backup-${new Date().toISOString().slice(0, 10)}.json`, {
          protocol: PROTOCOLS.recordBundle,
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          studentCode: await studentCode(),
          deviceCode: await deviceCode(),
          package: (await getPackage())?.package || null,
          packageVersion: (await getPackage())?.version ?? 0,
          packageSource: (await getPackage())?.source || null,
          sessions: local.map(row => row.payload || row),
          sessionMetadata: Object.fromEntries(local.map(row => [row.sessionId, { studentCode: row.studentCode, deviceCode: row.deviceCode, platform: row.platform }]))
        });
        state.notice = "备份已导出。";
        render();
        break;
      }
      case "restore": {
        const file = await pickJsonFile();
        if (!file || file.error) break;
        await guard(async () => {
          let parsed;
          try {
            parsed = JSON.parse(file.text);
          } catch {
            throw new SyncError("备份文件不是有效的 JSON。", "invalid-file");
          }
          const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
          if (parsed?.protocol !== PROTOCOLS.recordBundle || parsed.schemaVersion !== 1) throw new SyncError("备份文件协议或版本不正确。", "invalid-backup");
          if (!sessions.length && !parsed?.package) throw new SyncError("备份文件里没有可恢复的内容。", "empty-backup");
          for (const [index, payload] of sessions.entries()) {
            const issues = validateSessionPayload(payload);
            if (issues.length) throw new SyncError(`第 ${index + 1} 份记录未通过校验：${issues[0]}。本次未恢复任何记录。`, "invalid-session");
          }
          if (parsed.package && !inspectPackagePayload(parsed.package).ok) throw new SyncError("备份里的课程包未通过校验，本次未恢复。", "invalid-payload");
          const currentStudent = await studentCode();
          const currentDevice = await deviceCode();
          // 恢复记录保留原始归属的 studentCode：不能把别人/别的孩子的记录改写成本机编号。
          const backupStudent = typeof parsed?.studentCode === "string" && parsed.studentCode ? parsed.studentCode : currentStudent;
          let restored = 0;
          let skipped = 0;
          for (const payload of sessions) {
            if (!payload?.sessionId) { skipped += 1; continue; }
            const sha = await sha256Hex(payload);
            const metadata = parsed.sessionMetadata?.[payload.sessionId] || {};
            const { putSession } = await import("./db.js");
            const before = await localSessionCount();
            await putSession({
              sessionId: payload.sessionId,
              studentCode: metadata.studentCode || backupStudent,
              deviceCode: metadata.deviceCode || currentDevice,
              platform: "import",
              startedAt: payload.startedAt,
              endedAt: payload.endedAt,
              uploaded: false,
              uploadedAt: null,
              payload,
              payloadSha256: sha
            });
            const after = await localSessionCount();
            if (after.total > before.total) restored += 1;
            else skipped += 1;
          }
          // 课程与记录已全部预检；恢复课程时仍保留上一版以供回滚。
          let packageRestored = false;
          if (parsed?.package) {
            const check = inspectPackagePayload(parsed.package);
            if (check.ok) {
              await replaceActivePackage({ payload: parsed.package, version: parsed.packageVersion ?? 0, source: "restore" });
              packageRestored = true;
            }
          }
          await reload?.();
          state.notice = `已从备份恢复 ${restored} 份记录${skipped ? `（${skipped} 份已存在或无效，未覆盖）` : ""}${packageRestored ? "，并恢复了课程包。" : "。"}`;
        });
        break;
      }
      case "clear-local": {
        if (!confirm("将删除这台手机上的全部学习记录（云端不受影响）。确定继续吗？")) break;
        if (!confirm("再次确认：删除后无法从本机恢复，请先导出备份。仍然继续吗？")) break;
        await guard(async () => {
          await onLocalCleared?.();
          const { openDatabase } = await import("./db.js");
          const db = await openDatabase();
          await new Promise((resolve, reject) => {
            const transaction = db.transaction(["sessions", "drafts"], "readwrite");
            transaction.objectStore("sessions").clear();
            transaction.objectStore("drafts").clear();
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          await reload?.();
          state.notice = "本机记录已清空。";
        });
        break;
      }
      case "download-voices": {
        await guard(async () => {
          state.voiceDownloadProgress = "正在准备离线语音…";
          const result = await prepareOfflineVoices({ onProgress: progress => {
            state.voiceDownloadProgress = `已准备 ${progress.done} / ${progress.total} 条${progress.failed ? `，${progress.failed} 条待重试` : ""}`;
            const node = root.querySelector("[data-voice-progress]");
            if (node) node.textContent = state.voiceDownloadProgress;
          } });
          state.notice = result.failed
            ? `已保存 ${result.done} 条语音，${result.failed} 条未下载成功。再次点击会接着下载。`
            : `全部 ${result.done} 条语音已准备好，可以离线播放。`;
        });
        break;
      }
      case "save-parent-pin": {
        const pin = document.querySelector("[data-parent-pin]")?.value?.trim() || "";
        if (!pin) { state.error = "请输入 4～8 位数字密码。"; render(); break; }
        await guard(async () => {
          await onSetParentPin?.(pin);
          state.notice = "家长密码已保存，下次进入家长管理需要输入。";
        });
        break;
      }
      case "clear-parent-pin":
        await guard(async () => {
          await onClearParentPin?.();
          state.notice = "已取消家长密码，进入家长管理不再需要密码。";
        });
        break;
      case "sign-out":
        await guard(async () => {
          await cloudApi.signOut();
          await clearAccountCaches();
          state.session = null;
          state.remoteRecords = [];
          state.versions = [];
          state.uploadResult = state.courseResult = null;
          state.view = "home";
          state.notice = "已退出登录。";
        });
        break;
      default: break;
    }
  });

  return { render, state, refreshSession, unlock, lock };
}
