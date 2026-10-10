# 小芽家庭学习

Windows 桌面应用与手机 PWA 的唯一源码仓库：<https://github.com/YU-xiaolin/xiaoya>。

支持汉字、英语字母和六阶段数学启蒙。Windows 使用 Tauri，手机端使用 Vite、IndexedDB 和 Service Worker；两端共用九个教学模块。

## 使用与数据

- 电脑端运行构建后的“小芽家庭学习.exe”，无须保留源码。家庭数据继续位于本机 `C:\codex\AI家庭学习\data`。
- 手机端继续使用 <https://xiaoya-learning.app.workbuddy.host/>，保留原家长登录与云同步。
- GitHub 只存程序、通用教材与模拟测试数据，不存真实作答、学习状态、家长报告、家庭私有课程包、账号凭据或历史交接日志。
- 公开内置课程为通用示例。家庭课程由家长登录原云服务后下载，不以公开示例覆盖家庭进度。

## 构建

使用 Node.js 22；Windows 构建还需要 Rust stable、Visual Studio C++ 工具与 WebView2。

```sh
npm ci --prefix app-source
npm ci --prefix app-mobile
node tools/check-public.mjs
node tools/sync-core.mjs --check
node tools/fetch-voice-assets.mjs
npm test --prefix app-source
npm test --prefix app-mobile
npm run build --prefix app-mobile
```

Windows：`npm run build --prefix app-source`。测试使用模拟进度和通用目录，不读取本机家庭档案。

教学音频为公开发布资产，清单与逐文件 SHA-256 存在本仓库。构建时从原应用下载并核对；也可向音频下载工具传入 `--from-dir=本地已发布语音目录`。音频不是儿童录音。

## 发布与维护

GitHub Actions 从同一提交测试并构建 Windows EXE 和手机静态包，构建结果带仓库地址和提交号。源码更新后以对应提交的产物为准。

原 WorkBuddy 网址和云服务须保持不变。WorkBuddy 当前没有供 GitHub Actions 调用的自动部署接口：手机构建包仍须由 WorkBuddy 发布到同一应用。不能把“GitHub 构建成功”当成“原网址已更新”。不使用 GitHub Pages 替换原站点，以免改变云服务来源域名。

日常电脑和手机运行的是构建产物；GitHub 是源码真源。维护时可临时取得指定提交，用完清理源码，不在家庭运行目录长期保存第二份源码。

没有为本项目擅自添加开源许可证；第三方依赖遵循各自许可证。
