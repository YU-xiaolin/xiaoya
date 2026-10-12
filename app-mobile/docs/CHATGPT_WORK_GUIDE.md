# ChatGPT Work 数据分析与课程更新操作说明

这份说明面向「家长管理网页」，ChatGPT Work、Codex 或人工家长都可以按同样步骤操作。
两种方式都可用，互不依赖：

- **方式 A（推荐，无需账号密码）**：在家长管理网页上直接导入 / 导出 JSON。
- **方式 B（命令行）**：在电脑上运行 `app-mobile/scripts/cloud-sync.mjs`。

---

## 零、准备

| 项目 | 值 |
| --- | --- |
| 手机 / 电脑访问地址 | `https://xiaoya-learning.app.workbuddy.host/` |
| 家长管理入口 | 打开网址 → 点「家长入口」→ 输入家长密码（若已设置）→ 登录家庭账号 |
| 学习记录协议 | `XIAOYA_RECORD_BUNDLE_V1`（内含 `FAMILY_LEARNING_SESSION_V1`） |
| 课程协议 | `FAMILY_LEARNING_LESSON_V1`（课程包为 `XIAOYA_COURSE_PACKAGE_V1`） |
| Schema 位置 | `app-mobile/schemas/` |

登录方式任选：手机号验证码、邮箱+密码、邮箱验证码、WorkBuddy 账号、微信扫码。
首次使用会创建家庭账号；同一账号下所有数据互相可见，其他账号一律看不到。

> **家庭请统一固定使用「手机号 + 短信验证码」一个账号。**
> WorkBuddy 账号登录与微信扫码登录各自是**独立的账号**，与手机号账号的学习记录、课程互不相通，
> 也无法在应用内合并（云端只提供账号，不提供绑定/合并接口）。
> 界面上，家长管理标题栏会显示当前是"手机号 138\*\*\*\*1234""邮箱 a\*\*\*@b.com"还是"微信账号（未绑定手机号）"，可据此确认登的是哪个账号。

---

## 一、读取学习记录（方式 A）

1. 家长管理页 →「查看与导出学习记录」。
2. 点「读取云端记录」，页面上会显示份数、节数、作答事件数、答对 / 答错数。
3. 选择一种导出：
   - 「导出本地 JSON」：只导出这台设备上的记录。
   - 「导出云端 JSON」：导出账号下所有设备（手机 + 电脑）上传的记录。
   - 填「起始日期」后点「导出该日期之后」：只导出新增部分。

导出文件是一个记录包：

```json
{
  "protocol": "XIAOYA_RECORD_BUNDLE_V1",
  "schemaVersion": 1,
  "exportedAt": "2026-10-08T09:30:00.000Z",
  "studentCode": "student-01",
  "source": "cloud",
  "sessionCount": 12,
  "sessions": [ /* FAMILY_LEARNING_SESSION_V1 原始记录 */ ]
}
```

记录包中的每条 `sessions[]` 都是完整的原始记录，字段与
`data/schemas/session.schema.json` 完全一致，可与 Windows 端互相导入导出。

## 一·二、读取学习记录（方式 B）

```powershell
cd C:\codex\AI家庭学习
$env:XIAOYA_EMAIL = "你的邮箱"
$env:XIAOYA_PASSWORD = "你的密码"
node app-mobile/scripts/cloud-sync.mjs --pull-records
node app-mobile/scripts/cloud-sync.mjs --pull-records --since=2026-10-01
```

结果写到 `output/cloud-pull-YYYYMMDD-HHMMSS/records.json` 和 `records.index.json`。
**不会写入 `data/raw/sessions`**（该目录只由小芽软件追加，属于不可变事实源）。

## 一·三、读取学习记录（方式 C：手机号 + 验证码，推荐给家庭账号）

方式 B 只支持「邮箱 + 密码」。家庭账号是「手机号 + 短信验证码」，请改用 `cloud-agent.mjs`：
它登录一次后会把会话持久化到本地文件，之后电脑/AI 可以随时免登录拉记录、发课程。

```powershell
cd C:\codex\AI家庭学习
node app-mobile/scripts/cloud-agent.mjs --login --phone 13800001234   # 发送验证码
node app-mobile/scripts/cloud-agent.mjs --login --code 123456         # 完成登录并保存会话
node app-mobile/scripts/cloud-agent.mjs --status                     # 查看登录状态与云端记录概况
node app-mobile/scripts/cloud-agent.mjs --pull-records               # 下载云端记录（可加 --since=YYYY-MM-DD）
node app-mobile/scripts/cloud-agent.mjs --push-course                # 发布家庭私有课程包为新版本
node app-mobile/scripts/cloud-agent.mjs --logout                     # 退出并清除本地会话
```

- 会话文件默认 `%USERPROFILE%\.xiaoya\cloud-session.json`（600 权限），可用 `XIAOYA_SESSION_FILE` 覆盖；SDK 会在需要时自动续期。
- 只有第一次（或会话失效后）需要验证码，之后 `--pull-records` / `--push-course` 不再需要任何交互。
- 同样**只读**正式数据：不写 `data/raw/sessions`，也不改 `learning-state.json`。
- 手机端「上传学习记录」之后，电脑/AI 执行一次 `--pull-records` 就能拿到全部记录（含来源设备分布）。

---

## 二、让 ChatGPT Work 分析记录

把导出的 `records.json` 整个交给 ChatGPT Work（桌面版把 `C:\codex\AI家庭学习` 作为本地目录打开），
然后说：

> 这是小芽的学习记录包（协议 XIAOYA_RECORD_BUNDLE_V1）。请按下面的判读规则分析，并生成一份新的 `next-lesson.json`。

### 判读规则（必须遵守，与软件门禁一致）

- 只按原始事件判读，**不要**把「展示过」写成「已经会」。
- `result` 取值含义：
  - `correct` + `independent: true` → 独立答对（唯一能支撑状态升级的证据）。
  - `correct` + `independent: false` → 提示后答对，**仍是薄弱证据**。
  - `incorrect` → 答错。
  - `hint_shown` → 只是显示了提示，不是作答结果。
  - `demonstrated` → 已示范答案，同样不是掌握证据。
- 状态最多**单级升级**：汉字 `未学 → 初见 → 学习中/薄弱 → 会认 → 稳定掌握`。
- 「稳定掌握」必须满足：**≥3 个不同 `sessionId` 中独立答对，且覆盖 ≥2 种 `evidenceType`**。
- 数学状态：`未学 → 初见 → 学习中/薄弱 → 理解 → 稳定掌握`，不写入 `next-lesson.json`，由软件按所选阶段自动生成。
- 单课约束：常规课程最多 **20 个核心任务**；新汉字每课最多 **6 个**；新字母最多 6 个。
- 选择题必须**恰好 4 个互不重复的非空选项**，且可见 `prompt` **不得出现正确答案**。
- 面向孩子的文字（`prompt`/`speechPrompt`/`context`/`hint`/`demonstration`/`reinforcement`）必须**直接对孩子说**，
  不能出现「请孩子」「孩子自己」「家长」等旁观口吻。
- 第一次答错只给不泄露答案的提示，第二次才示范，至少隔 3 个任务复测（软件会自动插入复测题，课程 JSON 里不用自己复制）。

### 建议的分析产出

1. **掌握情况表**：按 `targetRef` 统计独立答对次数、场次数、错误次数、证据模式数，标注是否达到稳定掌握。
2. **错题与复习优先级**：错误次数多的、久未接触的排在前面。
3. **学习趋势**：按天统计节数、作答数、正确率。
4. **下一课建议**：先安排到期薄弱/不会 → 少量旧内容 → 新内容。

---

## 三、生成并发布新课程

### 方式 A（网页导入）

1. 让 ChatGPT Work 输出一个 `next-lesson.json`（协议 `FAMILY_LEARNING_LESSON_V1`），
   或者一个完整课程包（协议 `XIAOYA_COURSE_PACKAGE_V1`）。
2. 家长管理页 →「课程管理」→
   - 「选择课程文件」：导入单独的 `next-lesson.json`，它会替换课程包里的课程部分；
   - 「选择完整课程包文件」：整体替换（目录 + 摘要 + 课程）。
3. 点「把当前课程发布为新版本」。页面会显示新版本号与发布时间。
4. 「版本历史」可以看到每一版的版本号、标题、发布时间与内容校验值。

### 方式 B（命令行，从正式数据直接打包）

```powershell
cd C:\codex\AI家庭学习
node app-mobile/scripts/cloud-sync.mjs --push-course
```

它会读取正式 `data/state/learning-state.json` 与 `data/ai/next-lesson.json`，
生成课程包并发布为云端新版本（**只读正式数据，不修改任何文件**）。

家庭状态同步使用 `buildFamilyCoursePackage` 生成 `visibility: "family-private"` 的完整课程包，
保留软件已确认的 `status`、`needsAssessment` 和家长确认时间；只能在同一个已登录家庭账号下导入、发布。
家长新教内容先由 Windows 小芽校验 `data/ai/parent-baseline.json` 并写入正式状态，再生成家庭包，
不要将尚未应用的 AI 建议当成正式状态。只有课程文件的导入不会更新整份字表与待测试信息。

`tools/build-course-package.mjs` 的默认命令仍生成公开通用目录，不含家庭进度，不能替代家庭状态同步。
家庭私有包不得放进 `app-mobile/public/` 或 `dist/`，不得作为静态网页发布。
手机号验证码账号使用网页的「选择完整课程包文件」与「把当前课程发布为新版本」，无需在脚本中保存手机号或验证码。

---

## 四、手机端更新课程

手机打开小芽 → 家长入口 → 「按钮二 · 更新学习课程」→ 显示版本号与发布时间即成功。

- 只替换课程，**不会覆盖尚未上传的学习记录**（按钮上会显示剩余待上传条数）。
- 校验不通过或下载失败时，会继续使用原有课程，并给出原因。

---

## 五、完整的闭环

```
手机学习 → 本地 IndexedDB 保存
      ↓ 「上传学习记录」
WorkBuddy 云数据库（按家庭账号隔离）
      ↓ 家长管理页导出 JSON ／ cloud-agent --pull-records
ChatGPT Work 读取与分析
      ↓ 生成 next-lesson.json / 课程包
家长管理页导入 ／ cloud-agent --push-course
      ↓ 「更新学习课程」
手机获取新课程，继续学习
```

电脑端同样可以参与：`cloud-agent --push-course` 把电脑上的最新课程推上云端，
`cloud-agent --pull-records` 把手机记录拉回电脑交给 ChatGPT Work。

---

## 六、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 点上传提示「请先登录」 | 登录会话已过期，重新登录家长账号即可。 |
| 点上传提示「当前没有网络」 | 记录仍安全保存在手机上，联网后再点一次。 |
| 提示「没有需要上传的新记录」 | 所有记录都已同步；重复点击不会产生重复数据。 |
| 更新课程提示「云端还没有发布课程包」 | 先看家长管理标题栏显示的是哪个账号。若显示"微信账号（未绑定手机号）"之类，说明登的是独立账号，请改用手机号 + 验证码登录发布课程的那个家庭账号；若确认账号正确，再在家长管理页导入并发布一次课程。 |
| 更新课程提示「登录状态已经失效」 | 退出登录后用手机号 + 短信验证码重新登录即可；记录仍安全保存在手机上。 |
| 手机上传了记录，电脑却读不到 | 云端按账号隔离，需要主动拉取：执行 `node app-mobile/scripts/cloud-agent.mjs --pull-records`（首次先 `--login --phone`）；或走方式 A 在网页导出。 |
| 更新课程提示「未通过校验」 | 课程 JSON 不符合 Schema，请按错误提示修正后重新导入。 |
| 孩子答题没有声音 | 点击题目下方「播放声音」或「再听一次题目」；联网重开可取得最新录音清单。家长可在「设置与备份 → 下载全部离线语音」提前准备；若下载中断，再次点击会继续。自定义课程中未录制的句子会尝试手机中文语音。 |

---

## 七、合规提醒

- 云端**不保存**儿童姓名、照片、录音；只使用匿名学生编号与设备编号。
- 不需要、也不应把 OpenAI API Key 配置进来；ChatGPT 订阅不等于 API。
- 删除记录前网页会二次确认，建议先「导出备份 JSON」。
