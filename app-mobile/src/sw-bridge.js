// Service Worker 通信：退出登录 / 切换账号时清理账号关联缓存。
// 云接口响应本身从不进入缓存，这里主要保证任何按账号划分的资源（如按账号缓存的课程来源）
// 在切换账号后不会串号。
export function notifyServiceWorker(type, payload = {}) {
  try {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    controller.postMessage({ type, ...payload });
  } catch { /* 没有 Service Worker 时忽略。 */ }
}

export function clearAccountCaches() {
  notifyServiceWorker("XIAOYA_SW_CLEAR_ACCOUNT");
}

export function clearAllCaches() {
  notifyServiceWorker("XIAOYA_SW_CLEAR_ALL");
}
