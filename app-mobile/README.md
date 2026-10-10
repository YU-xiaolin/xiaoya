# 小芽家庭学习 · 手机版（PWA）

Windows 桌面版「小芽家庭学习.exe」的手机端同伴出现。手机可以独立学习，
电脑不需要开机；记录先存在手机本地，点一下再同步到云端。

- 正式地址：<https://xiaoya-learning.app.workbuddy.host/>
- 云服务应用 ID：`wbapp_GmOXzpfOUNz2OjF2Hyvdj9`
- 当前版本：0.3.1（手机端）

## 设计原则

1. **教学逻辑只有一份**。汉字/英语/数学的出题、提示、示范、语音文案全部来自
   `app-source/src/*.js`（Windows 端同一份源码），由 `tools/sync-core.mjs` 复制到
   `app-mobile/src/core/` 并写入哈希清单。改动只发生在 `app-source/src`，两端行为天然一致。
2. **不动 Windows**。手机版不使用 Tauri，不修改 `app-source` 的任何文件，也不碰 EXE。
3. **正式学习数据只读**。构建脚本只读取 `data/state`、`data/ai`、`data/catalog`，
   不写、不覆盖；`data/raw/sessions` 只由小芽软件追加。
4. **记录先本地、后云端**。IndexedDB 保存原始作答，只有点击「上传学习记录」才写入云端，
   服务端按 `session_id` 去重，重复点击不会产生重复数据。

## 目录

```
app-mobile/
  index.html                 入口页
  vite.config.js             构建配置（base 相对路径，允许任意 Host）
  src/
    main.js                  启动、家长密码门禁、Service Worker 注册
    child.js                 儿童学习界面（复用 core 的教学逻辑）
    parent.js                家长管理界面（登录、两个同步按钮、记录、课程、备份）
    voice.js                 语音：自然语音子集优先，缺失时回退设备中文语音
    store.js                 本地课程包、设备/学生编号、会话构造
    db.js                    IndexedDB（sessions / packages / meta / logs）
    cloud.js                 WorkBuddy 云服务访问层（Auth + Database）
    sync.js                  上传学习记录 / 更新学习课程 / 课程发布
    analysis.js              学习分析（独立答对、稳定掌握规则、趋势、复习优先级）
    config.js                公开配置（endpoint / publishableKey / 协议名）
    styles.css               移动端样式（竖屏优先，触控目标 ≥ 48px）
    core/                    从 app-source/src 同步的教学核心（请勿手工编辑）
  public/
    manifest.webmanifest     PWA 声明
    sw.js                    Service Worker（应用外壳 + 语音缓存）
    icons/                   图标（SVG + PNG，含 maskable）
    course/                  随应用发布的课程包（由 tools/build-course-package.mjs 生成）
    voice/                   晓伊自然语音（全量，由 tools/build-voice-subset.mjs 生成）
  schemas/                   学习记录与课程的 JSON Schema 与示例
  scripts/
    verify-ui.mjs            本地真实浏览器验证
    verify-live.mjs          线上真实浏览器验证
    probe-cloud.mjs          云端只读探针（权限边界 + 认证通道）
    cloud-sync.mjs           PC 端云同步助手（推课程 / 拉记录）
  tests/                     node --test 单元测试
  docs/                      安装教程、ChatGPT Work 说明、云端与安全说明
```

## 常用命令

```powershell
cd C:\codex\AI家庭学习

# 1. 同步共用教学核心（改动 app-source/src 后必须执行）
node tools/sync-core.mjs
node tools/sync-core.mjs --check      # 只检查是否漂移

# 2. 生成课程包（从正式数据快照）
node tools/build-course-package.mjs

# 3. 生成语音（默认全量收录；需要限制体积时再传 --max-mb=N）
node tools/build-voice-subset.mjs

# 4. 生成图标
python tools/make-icons.py

# 5. 构建与验证
cd app-mobile
node node_modules/vite/bin/vite.js build
node --test tests/*.test.mjs
node ../tools/serve-static.mjs dist 5199          # 另开一个终端
node scripts/verify-ui.mjs http://127.0.0.1:5199/
node scripts/verify-live.mjs https://xiaoya-learning.app.workbuddy.host/
node scripts/probe-cloud.mjs
```

## 语音策略（重要）

**全量晓伊自然语音（0.3.1 起）**：应用会朗读的每一句都必须有晓伊语音，不允许回退成
手机系统机器音。

- 文本枚举统一放在 `tools/voice-text-catalog.mjs`，构建（`tools/build-voice-subset.mjs`）、
  覆盖率校验（`app-mobile/scripts/`、`app-mobile/tests/voice-coverage.test.mjs`）和
  Windows 端语音包生成共用同一份逻辑，避免「构建时收录的句子」与「运行时真正会朗读的句子」漂移。
- 枚举范围包含**全部字库**的测试题面、提示、示范与数学变体，而不是只覆盖「当时已学」的内容：
  手机端的小测试范围由本机学习记录推导，打包时无法预知哪些字将来会进入测试。
- 音频按需下载（Service Worker 命中后才缓存），所以目录体积大不等于每台手机都下载全部。
- 需要控制体积时可显式传 `--max-mb=N`，此时按优先级从低到高舍弃，并在报告里列出被舍弃的句子。

## 已知边界

- iOS 的音频需要用户手势触发，应用会在首次触摸时预热播放器。
- PWA 的「添加到主屏幕」在微信内置浏览器中不可用，需要用 Safari / Chrome。
- 随应用发布的课程包是**通用课程定义**；本机学习进度（status / lastSeenAt）由本机真实作答记录
  推导（`src/analysis.js` 的 `mergeCatalogProgress`），因此小测试依据的是这台手机的真实记录。
- 线上目前以开发服务方式托管（首次加载较慢）；发布内容与本地构建产物一致。
