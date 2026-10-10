# 云端数据与安全说明

## 一、用了什么

| 项目 | 内容 |
| --- | --- |
| 平台 | WorkBuddy 云服务（托管后端，等同于 Supabase 定位） |
| 应用 ID | `wbapp_GmOXzpfOUNz2OjF2Hyvdj9` |
| 发布域名 | `https://xiaoya-learning.app.workbuddy.host` |
| 使用模块 | 云数据库（Database）、身份认证（Auth） |
| 未使用模块 | 文件存储（Storage）、免密钥大模型（LLM）——本次不需要 |
| 自购服务器 | **无** |
| 收费的 OpenAI API | **无**，也不需要配置任何 API Key |

前端只内置了四项**公开**配置（`endpoint`、`publishableKey`、`oauthRelayBaseUrl`、`applicationId`）。
这些值本身不携带权限：服务端会校验来源域名，并按登录身份做行级权限校验。
环境的真实 ID 与任何 provider 密钥都在服务端，从不下发到网页。

## 二、数据表

所有表都开启 RLS（行级安全），策略为「只能读写自己账号的行」。

| 表 | 用途 |
| --- | --- |
| `xiaoya_students` | 家庭内的匿名学生编号（`student_code`），不含真实姓名 |
| `xiaoya_devices` | 设备编号与平台，用于区分手机 / 电脑 |
| `xiaoya_sessions` | 原始学习记录（`session_id` 唯一 + `payload` 完整 JSON），**只追加、不覆盖** |
| `xiaoya_course_versions` | 课程版本（`course_key` + `version` 唯一，`is_active` 标记当前生效版本） |
| `xiaoya_catalog_snapshots` | 课程目录与进度摘要快照，便于核对 |

关键字段：

- `owner_id TEXT NOT NULL DEFAULT auth.uid()` —— 归属由服务端填写，前端**从不**发送该字段。
- `unique (owner_id, session_id)` / `unique (owner_id, course_key, version)` —— 防重复写入。
- `payload_sha256` —— 内容校验值，导入时用于发现被篡改或截断的数据。

## 三、权限边界（已实测）

| 场景 | 结果 |
| --- | --- |
| 未登录访问 5 张表 | 读取返回 0 行，不返回任何数据 |
| 未登录 `getSession()` | 返回 `null` |
| 错误凭据登录 | 返回 `invalid_username_or_password`（HTTP 400），说明认证通道与域名校验正常 |
| 未登录但知道网址 | 只能看到登录界面，读不到任何家庭数据 |

> `SELECT` / `INSERT` / `UPDATE` / `DELETE` 只授予 `authenticated`（已登录用户），
> 未登录的 `anon` 角色没有任何授权。

## 四、隐私

- **不采集**儿童姓名、照片、录音；只有匿名学生编号与设备编号。
- 语音是**预生成的教学语音**，不使用麦克风，也不上传录音。
- 「孩子自己读」这类题由**家长判定对错**，不做语音识别，识别失败不会被判成答错。
- 网页端不打印任何 token、手机号、邮箱到日志。

## 五、费用与额度

- 本次只开通了云服务环境本身，`billingStatus = normal`，`provisionStatus = assigned`。
- 没有开通任何付费增值服务，没有绑定任何第三方付费 API。
- 数据量很小（一次学习记录约几 KB），家庭使用远低于常规免费额度。
- 如需查看额度使用情况，可在 WorkBuddy 的云服务管理面板查看。

## 六、维护提示

- 课程目录的**权威来源**仍是 Windows 端的 `data/state/learning-state.json`，
  云端只是同步副本；手机端不会自行修改正式状态。
- 手机上的学习记录是原始事实，上传到云端后按 `session_id` 去重，不会重复。
- 需要删除数据时，请先在「设置与备份」导出备份，再执行删除（网页会二次确认）。
