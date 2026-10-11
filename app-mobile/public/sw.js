/* 小芽家庭学习 · Service Worker
   目标：离线也能打开应用并继续学习已经下载过的课程。

   缓存边界（重要）：
   - 只缓存「应用资源白名单」：HTML、构建后的 JS/CSS、课程包、图标、语音文件。
   - 云接口（/.cloud/**）、认证、数据读写、任何带 Authorization 的请求一律不缓存、
     不拦截：直接走网络，离线时由应用层给出明确失败提示，绝不返回过期响应。
   - 缓存按账号隔离：登录账号变化或退出登录时清理账号关联缓存。

   策略：
   - 应用外壳：缓存优先 + 后台静默更新（仅限白名单资源）。
   - 语音文件：用到时缓存，之后离线可播。
   - 导航请求：网络优先，失败回退到缓存的 index.html。
*/
// 升级缓存版本会清掉旧版本的缓存：语音包从「按优先级裁剪的子集」改为「全量晓伊语音」后，
// 必须让已安装的设备重新取到新的语音清单，而不是继续用旧清单。
const VERSION = "xiaoya-mobile-v4";
const SHELL_CACHE = `${VERSION}-shell`;
const VOICE_CACHE = "xiaoya-voice-v1";

// 启动必需的静态外壳资源。
// 构建时（vite.config.js 的 xiaoya-sw-manifest 插件）会把下面的占位符替换成
// 真实构建产物清单（含内容哈希的 JS/CSS），保证首次安装后即可离线启动。
const BUILD_SHELL_URLS = /* XIAOYA_BUILD_SHELL */ [];

const BASE_SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./voice/manifest.json",
  "./course/course-package.json",
  "./course/course-package.meta.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png"
];

const SHELL_URLS = [...new Set([...BASE_SHELL_URLS, ...BUILD_SHELL_URLS])];

/* ---------------- 缓存边界判定 ---------------- */

// 云接口路径前缀。SDK 的所有数据库/认证请求都走这里。
const CLOUD_PATH_PREFIXES = ["/.cloud/", "/.cloud"];
// 认证与数据相关的路径特征（同域但不属于静态资源）。
const CLOUD_PATH_PATTERNS = [
  /^\/auth(\/|$)/i,
  /^\/rest(\/|$)/i,
  /^\/storage(\/|$)/i,
  /^\/functions(\/|$)/i,
  /^\/realtime(\/|$)/i,
  /^\/oauth/i
];

function isCloudRequest(url, request) {
  if (CLOUD_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return true;
  if (CLOUD_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))) return true;
  if (request.headers.has("authorization")) return true;
  // 带凭证的跨域/同域请求不缓存。
  if (request.credentials === "include" && request.method !== "GET") return true;
  return false;
}

// 只缓存这些扩展名 / 路径的同域 GET 资源，避免把任何接口响应写进缓存。
const ASSET_PATH_PATTERNS = [
  /\.(?:js|mjs|css|html|json|webmanifest|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|wav|m4a|ogg)$/i
];

function isCacheableAsset(url) {
  if (ASSET_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))) return true;
  // 目录/根路径视为导航外壳。
  return url.pathname.endsWith("/");
}

function isNavigationRequest(request) {
  return request.mode === "navigate"
    || (request.method === "GET" && (request.headers.get("accept") || "").includes("text/html"));
}

/* ---------------- 安装与激活 ---------------- */

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_URLS.map(async url => {
      try { await cache.add(new Request(url, { cache: "reload" })); } catch { /* 单个资源失败不阻塞安装。 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 删除所有旧版本缓存（升级缓存版本时会清掉此前误存的云接口响应）。
    await Promise.all(keys.filter(key => key.startsWith("xiaoya-mobile-") && !key.startsWith(VERSION)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

/* ---------------- 缓存策略 ---------------- */

async function cacheFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) {
    // 后台静默更新，下次打开即为最新；离线时忽略失败。
    event.waitUntil(revalidate(request, cache));
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

function revalidate(request, cache) {
  return fetch(request).then(async response => {
    if (response && response.ok && response.type === "basic") await cache.put(request, response.clone());
  }).catch(() => { /* 离线，保留缓存。 */ });
}

// Safari requests byte ranges for media. Store complete MP3s and return the
// requested slice, so a cached lesson remains playable after disconnecting.
async function audioResponse(request) {
  const cache = await caches.open(VOICE_CACHE);
  const fullRequest = new Request(request.url, { credentials: "same-origin" });
  let response = await cache.match(fullRequest);
  if (!response) {
    response = await fetch(fullRequest);
    if (!response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) return Response.error();
    await cache.put(fullRequest, response.clone());
  }
  const range = request.headers.get("range");
  if (!range) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
  const bytes = await response.arrayBuffer();
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes.byteLength - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  if (start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.byteLength}` } });
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: {
    "Content-Type": response.headers.get("content-type") || "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`
  } });
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 跨域：不拦截。云服务、CDN 都由应用层直接处理。
  if (url.origin !== self.location.origin) return;

  // 云接口/认证/数据请求：明确绕过 Service Worker，不缓存、不返回过期响应。
  if (isCloudRequest(url, request)) return;

  if (!isCacheableAsset(url)) return; // 未列白名单的同域 GET 也不介入。

  const isNavigation = isNavigationRequest(request);
  const isAudio = /\/voice\/.*\.(mp3|wav|m4a|ogg)$/i.test(url.pathname);

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put("./index.html", response.clone());
          return response;
        }
        throw new Error("应用入口暂时不可用");
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  if (isAudio) {
    event.respondWith(audioResponse(request));
    return;
  }

  event.respondWith(cacheFirst(request, SHELL_CACHE, event));
});

/* ---------------- 账号隔离与缓存清理 ---------------- */

async function clearAccountCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(key => key.startsWith(VERSION) && key.endsWith("-account"))
      .map(key => caches.delete(key))
  );
}

async function clearAllCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map(key => caches.delete(key)));
}

// 报告启动资源是否已经全部缓存：只有全部就绪才允许提示「可以离线学习」。
async function isShellReady() {
  const cache = await caches.open(SHELL_CACHE);
  for (const url of SHELL_URLS) {
    const hit = await cache.match(new Request(url, { cache: "reload" })) || await cache.match(url);
    if (!hit) return false;
  }
  return true;
}

self.addEventListener("message", event => {
  const type = event.data?.type;
  const port = event.ports?.[0];
  if (type === "XIAOYA_SW_READY_QUERY") {
    event.waitUntil((async () => {
      const ready = await isShellReady();
      port?.postMessage({ ready });
    })());
    return;
  }
  if (type === "XIAOYA_SW_CLEAR_ACCOUNT") {
    event.waitUntil(clearAccountCaches());
  } else if (type === "XIAOYA_SW_CLEAR_ALL") {
    event.waitUntil(clearAllCaches());
  }
});
