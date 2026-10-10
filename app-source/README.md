# 小芽家庭学习（V1 兼容协议 · 数学 V2）

这是“小孩学习”项目的 Windows 本地闭环版本。界面使用 Web 前端，本地文件与业务守门使用 Tauri 2 / Rust。为兼容历史记录，文件协议名继续使用 V1；当前正式支持汉字、英语字母与六阶段数学启蒙。

> **唯一开发基线：** 自 2026-08-20 起，后续功能、协议和数据迁移均以本目录的 Tauri V1 为基础。`sources` 中早期独立 HTML 教学页、浏览器本地存储方案及其启动脚本不再作为实现或进度依据。

已经构建好的版本可直接双击 `C:\codex\AI家庭学习\小芽家庭学习.exe`。第一次启动会自动建立运行数据，不需要手工建文件夹。

## 已打通的闭环

1. 软件首次启动，在 `C:\codex\AI家庭学习\data` 建立运行数据。
2. 软件读取 `ai/next-lesson.json`，校验后一次显示一题。
3. 第一次答错只提示，第二次才示范；错误项至少隔 3 个任务自动复测。
4. 结束后写入不可覆盖的 `raw/sessions/*.json`，不直接改正式掌握状态。
5. ChatGPT Work 按数据目录中的 `rules/WORKFLOW.md` 生成三个 AI 文件。
6. 软件检查引用、状态跳级和稳定掌握证据，通过后才合并 `state-update.json`。
7. 软件显示 `parent-report.md` 并执行新的 `next-lesson.json`。
8. 数学六阶段全部可选；0.2.5 首次默认选中 10 以内加减，此后记住所选阶段。每次运算课先做数量与分合热身，再练看图和算式；数学原始作答进入同一闭环，选课不更改掌握状态。
9. 测试可按日期、全部内容或错误次数比例抽题，所选题目在同一次测试中连续完成，不再每 20 题分轮；汉字测试可调整选择题与孩子自己读的比例。
10. 英语字母自然语音按一个字母音朗读，不会因为同时展示大写和小写而连续重复；数学看数字改为孩子口头说出，避免照着选项匹配字形。
11. 三个科目的题目、提示、示范和巩固语音统一直接对孩子表达；课程门禁会拒绝“请孩子……”或“家长……”一类旁观式课堂语句。
12. 0.2.4 通过共享提示入口接管旧课程与所有自动出题模式：1000 汉字独立情境/补词提示、26 字母形状提示、常见混淆对比，以及按实际题面生成的数学提示；提示后的答对仍为非独立作答。

## 针对性提示与语音维护

`src/hanzi-hints.js` 保存逐字内容，`src/targeted-hints.js` 根据学科、题型和实际误选选择线索。0.2.5 通过 `src/natural-hints.js` 把补词格式转换成完整的情境或词语提问，屏幕与语音都不再出现补词方框；`src/voice-text.js` 也会整理旧提示中的括号。当前汉字提示不直接显示目标字形；第二次答错后再明确示范。

修改提示后运行 `npm test`、`npm run voice-pack`、`npm run voice-pack:audit`，再构建 EXE。语音包提前覆盖全词库提示及所有已定义的混淆分支，不能只覆盖本次随机选项。生成任务分四个批次，复用已有文件，并在所有批次成功且审计通过后替换清单；中断后可重跑继续。

## 运行数据目录

唯一位置：

```text
C:\codex\AI家庭学习\data\
├─ raw\sessions\              # 软件只追加，AI 只读
├─ state\learning-state.json  # 软件维护的正式状态
├─ ai\
│  ├─ next-lesson.json         # ChatGPT Work 生成
│  ├─ state-update.json        # ChatGPT Work 生成，软件复核
│  ├─ parent-report.md         # ChatGPT Work 生成
│  └─ archive\                # 已采用状态建议的留档
├─ catalog\                    # 1000 汉字、26 字母与 35 项数学启蒙目标
├─ rules\                      # Work 流程与协议说明
└─ schemas\                    # JSON Schema
```

如需隔离测试，可在启动前设置环境变量 `FAMILY_LEARNING_DATA_DIR`；正式使用始终以 `C:\codex\AI家庭学习\data` 为准。软件首页会显示并可直接打开实际目录。

## 开发运行

需要 Node.js、Rust MSVC 工具链、Microsoft C++ Build Tools（“使用 C++ 的桌面开发”）和 WebView2。

```powershell
npm install
npm run test
npm run dev:app
```

构建不带安装器的 Windows 可执行文件：

```powershell
npm run build
```

输出位于 `src-tauri\target\release\family-learning.exe`。当前配置故意不制作 MSI，先把 V1 闭环验证稳定。

## Work 的唯一日常口令

完成一课后，在 ChatGPT 桌面版 Work 中打开 `C:\codex\AI家庭学习` 文件夹，然后说：

> 处理最新学习记录。

Work 的完整行为已写入运行目录的 `rules/WORKFLOW.md`。它不得修改 `raw/` 或正式 `state/learning-state.json`。

