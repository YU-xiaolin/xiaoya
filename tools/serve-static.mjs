// 极简静态服务器，用于本地验证 PWA 产物。
// 用法：node tools/serve-static.mjs <目录> <端口>
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(process.argv[2] || "app-mobile/dist");
const port = Number(process.argv[3] || 5199);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ico": "image/x-icon"
};

function safeJoin(base, target) {
  const resolved = path.resolve(base, `.${target}`);
  return resolved.startsWith(base) ? resolved : null;
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    let filePath = safeJoin(rootDir, pathname);
    if (!filePath) {
      response.writeHead(403).end("forbidden");
      return;
    }
    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath).catch(() => null);
    }
    // 单页应用：找不到文件时回退到 index.html（与静态托管行为一致）。
    if (!info) {
      filePath = path.join(rootDir, "index.html");
      info = await stat(filePath).catch(() => null);
      if (!info) {
        response.writeHead(404).end("not found");
        return;
      }
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
      "service-worker-allowed": "/"
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end(String(error?.message || error));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`静态服务器已启动：http://127.0.0.1:${port} -> ${rootDir}`);
});
