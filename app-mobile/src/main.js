import "./styles.css";
import { APP_VERSION } from "./config.js";
import { armAudioUnlock, initVoice } from "./voice.js";
import { completeOAuthCallback, getSession as getCloudSession } from "./cloud.js";
import { getMeta, setMeta } from "./db.js";
import { ensureBundledPackage, loadActivePackage } from "./store.js";
import { clearAccountCaches } from "./sw-bridge.js";
import { createChildApp } from "./child.js";
import { createParentApp } from "./parent.js";

const root = document.querySelector("#app");

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

const PARENT_PIN_KEY = "parentPinHash";

async function hashPin(pin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xiaoya:${pin}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function parentPinSet() {
  return Boolean(await getMeta(PARENT_PIN_KEY, null));
}

export async function saveParentPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("家长密码需要 4～8 位数字。");
  await setMeta(PARENT_PIN_KEY, await hashPin(pin));
}

export async function clearParentPin() {
  await setMeta(PARENT_PIN_KEY, null);
}

// 家长模式的本地门禁：只用于防止孩子误操作；真正的数据权限仍由云端账号与 RLS 校验。
function askParentPin() {
  root.dataset.appMode = "pin";
  return new Promise(resolve => {
    let value = "";
    let error = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      root.removeEventListener("click", onClick, true);
      resolve(result);
    };
    const draw = () => {
      root.innerHTML = `
        <main class="shell">
          <header class="topbar">
            <button class="icon-button" data-pin="cancel" aria-label="返回">←</button>
            <div class="topbar-title"><h1>家长管理</h1><p>请输入家长密码</p></div>
          </header>
          <section class="pin-card">
            <div class="pin-dots">${Array.from({ length: Math.max(4, value.length) }, (_, index) => `<i class="${index < value.length ? "on" : ""}"></i>`).join("")}</div>
            ${error ? `<p class="field-error">${error}</p>` : ""}
            <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => `<button data-pin="${digit}">${digit}</button>`).join("")}
              <button data-pin="back">⌫</button><button data-pin="0">0</button><button data-pin="ok" class="ok">确定</button>
            </div>
          </section>
        </main>`;
    };
    const onClick = async event => {
      const key = event.target.closest("[data-pin]")?.dataset.pin;
      if (!key) return;
      // 捕获阶段拦截：阻止其它 root 处理器（如 child/parent 的 action 分发）同时响应。
      event.stopImmediatePropagation();
      event.preventDefault();
      if (key === "cancel") return finish(false);
      if (key === "back") { value = value.slice(0, -1); error = ""; return draw(); }
      if (key === "ok") {
        if (!value) { error = "请输入密码"; return draw(); }
        const stored = await getMeta(PARENT_PIN_KEY, null);
        if (await hashPin(value) === stored) return finish(true);
        value = "";
        error = "密码不正确";
        return draw();
      }
      if (/^\d$/.test(key) && value.length < 8) { value += key; error = ""; draw(); }
    };
    // 用 addEventListener（捕获）而不是 root.onclick，避免覆盖/被覆盖其它处理器。
    root.addEventListener("click", onClick, true);
    draw();
  });
}

let childApp = null;
let parentApp = null;
let activePackage = null;

const LAST_ACCOUNT_KEY = "lastAccountId";

function accountIdentity(session) {
  const user = session?.user || {};
  return String(user.id || user.phone || user.email || "").trim() || null;
}

// 账号隔离：登录账号变化时清理账号关联缓存，并丢弃上一个账号的云端记录/课程版本，
// 避免孩子或家长看到别的账号的数据。
async function checkAccountSwitch() {
  let identity = null;
  try {
    identity = accountIdentity((await getCloudSession()).session);
  } catch { /* 未登录或网络不可用时无从判断，保持现状。 */ }
  const previous = await getMeta(LAST_ACCOUNT_KEY, null);
  if (identity) {
    if (previous && previous !== identity) {
      clearAccountCaches();
      parentApp?.state && (parentApp.state.remoteRecords = [], parentApp.state.versions = []);
    }
    await setMeta(LAST_ACCOUNT_KEY, identity);
  } else if (previous) {
    clearAccountCaches();
    await setMeta(LAST_ACCOUNT_KEY, null);
  }
}

async function reloadPackage() {
  activePackage = await loadActivePackage();
  await childApp?.refreshData(activePackage);
}

// 打开家长模式的唯一入口：所有进入路径都必须经过这里。
// 只要设置了家长密码，每次进入都必须重新输入——不保留「已解锁」的跨次记忆，
// 避免孩子界面上的其它点击处理器绕过 PIN。
async function openParent() {
  if (!parentApp) return;
  parentApp.lock();
  if (await parentPinSet()) {
    const ok = await askParentPin();
    if (!ok) return childApp.renderHome();
  }
  await checkAccountSwitch();
  parentApp.unlock();
  parentApp.state.view = "home";
  parentApp.state.error = null;
  parentApp.render();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    const url = new URL("sw.js", document.baseURI);
    navigator.serviceWorker.register(url.href, { scope: new URL("./", document.baseURI).href })
      .then(async registration => {
        // 等 Service Worker 真正接管、且预缓存清单就绪后，才提示「可以离线学习」，
        // 避免首次访问还没缓存完就断网导致打不开。
        await navigator.serviceWorker.ready;
        const worker = registration.active || registration.waiting || registration.installing;
        if (!worker) return;
        const ready = await new Promise(resolve => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => resolve(false), 3000);
          channel.port1.onmessage = event => {
            clearTimeout(timer);
            resolve(Boolean(event.data?.ready));
          };
          worker.postMessage({ type: "XIAOYA_SW_READY_QUERY" }, [channel.port2]);
        });
        document.documentElement.dataset.offlineReady = ready ? "true" : "false";
        if (ready) toast("已经准备好，可以离线学习啦。");
      })
      .catch(error => console.warn("[xiaoya] Service Worker 注册失败，离线能力不可用：", error?.message));
  });
}

function watchConnection() {
  const update = () => {
    document.documentElement.dataset.online = navigator.onLine ? "true" : "false";
  };
  window.addEventListener("online", () => { update(); toast("网络已恢复，可以上传学习记录了。"); });
  window.addEventListener("offline", () => { update(); toast("当前没有网络，学习记录会先保存在手机上。"); });
  update();
}

async function main() {
  armAudioUnlock();
  registerServiceWorker();
  watchConnection();

  // OAuth 回调必须在任何守卫之前无条件处理，否则一次性 code 会丢失。
  try { await completeOAuthCallback(); } catch { /* 普通访问，不是回调。 */ }

  await initVoice();

  try {
    activePackage = await ensureBundledPackage();
  } catch (error) {
    root.innerHTML = `<main class="boot"><div class="boot-mark">芽</div><p>内置课程包不可用：${error.message}</p><p class="hint-text">请联网后重新打开，或让家长在课程管理中导入课程。</p></main>`;
    return;
  }

  childApp = createChildApp({
    root,
    toast,
    getPackage: () => activePackage,
    onNeedParent: openParent,
    onSessionSaved: () => { /* 记录已在 finishSession 内落盘。 */ }
  });
  childApp.restoreStage();
  await childApp.refreshData(activePackage);

  // 上次直接关掉页面时，已发生的作答保存在草稿里；启动后恢复为「已暂停」状态，
  // 由孩子决定继续还是结束，绝不默默丢弃。
  const resumable = await childApp.findResumableDraft();
  if (resumable) {
    childApp.restoreDraft(resumable);
    childApp.renderChildHome();
    toast("上次的学习还留在第 " + (resumable.queueIndex + 1) + " 题，可以继续。");
  } else {
    childApp.renderHome();
  }

  parentApp = createParentApp({
    root,
    toast,
    getPackage: () => activePackage,
    reload: reloadPackage,
    onExit: () => childApp.renderHome(),
    onSetParentPin: pin => saveParentPin(pin),
    onClearParentPin: () => clearParentPin(),
    onLocalCleared: () => childApp.resetLocalProgress()
  });

  window.xiaoya = { version: APP_VERSION, childApp, parentApp, openParent };
}

main();
