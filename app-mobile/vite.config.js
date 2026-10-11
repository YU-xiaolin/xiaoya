import { defineConfig } from "vite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

// 云端托管通过反向代理域名访问，必须允许任意 Host，并监听 0.0.0.0。
const port = Number(process.env.PORT || 5199);

// 构建产物清单插件：
//   把 dist/sw.js 里的占位符替换成真实构建产物列表（含内容哈希），
//   让 Service Worker 在 install 阶段就把启动必需资源预缓存下来。
//   这样首次安装完成后即使立刻断网，应用也能打开。
function serviceWorkerManifest() {
  return {
    name: "xiaoya-sw-manifest",
    apply: "build",
    enforce: "post",
    async writeBundle(options) {
      const outDir = path.resolve(options.dir || "dist");
      const swPath = path.join(outDir, "sw.js");
      let source;
      try {
        source = await readFile(swPath, "utf8");
      } catch {
        return;
      }
      const assetsDir = path.join(outDir, "assets");
      let assets = [];
      try {
        assets = (await readdir(assetsDir)).map(name => `./assets/${name}`);
      } catch { /* 没有 assets 目录时只用基础外壳。 */ }
      const shell = [
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
      const list = [...new Set([...shell, ...assets])].sort();
      const replaced = source.replace(
        /const BUILD_SHELL_URLS = \/\* XIAOYA_BUILD_SHELL \*\/ \[\];/,
        `const BUILD_SHELL_URLS = ${JSON.stringify(list, null, 2)};`
      );
      if (replaced === source) {
        this.warn("未在 dist/sw.js 中找到 XIAOYA_BUILD_SHELL 占位符，预缓存清单未注入。");
        return;
      }
      await writeFile(swPath, replaced, "utf8");
      await writeFile(
        path.join(outDir, "sw-manifest.json"),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), urls: list }, null, 2)}\n`,
        "utf8"
      );
    }
  };
}

export default defineConfig({
  // 相对基址：既能挂在站点根路径，也能放在任意子目录。
  base: "./",
  plugins: [serviceWorkerManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false
  },
  server: {
    host: "0.0.0.0",
    port,
    strictPort: false,
    allowedHosts: true
  },
  preview: {
    host: "0.0.0.0",
    port,
    strictPort: false,
    allowedHosts: true
  }
});
