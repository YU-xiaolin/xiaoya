# 家庭学习本地文件协议 V1

V1 的职责分成三层：

- `raw/sessions/`：软件写入的不可变事实。AI 只读。
- `state/learning-state.json`：软件维护的正式进度。AI 只读，软件合并更新。
- `ai/`：ChatGPT Work 的输出区。软件先校验，再使用。

## 固定协议名

| 文件 | protocol |
|---|---|
| `raw/sessions/*.json` | `FAMILY_LEARNING_SESSION_V1` |
| `state/learning-state.json` | `FAMILY_LEARNING_STATE_V1` |
| `ai/state-update.json` | `FAMILY_LEARNING_STATE_UPDATE_V1` |
| `ai/next-lesson.json` | `FAMILY_LEARNING_LESSON_V1` |

所有时间使用 ISO 8601。所有 ID 在自己的作用域内唯一。为兼容已有记录，协议名继续使用 V1；当前 `subject` 支持 `hanzi`、`english_letter` 和 `math`。

## 处理顺序

```text
next-lesson.json → 软件执行 → raw session（不可变）
                                  ↓
                         ChatGPT Work 分析
                                  ↓
        state-update.json + next-lesson.json + parent-report.md
                                  ↓
                    软件复核更新、执行下一课
```

软件拒绝协议名错误、引用不存在、超出新内容上限、选择题不是四选一、跨级升级、无 raw 证据或过早标记稳定掌握的文件。被拒文件不会污染正式状态。

选择题的可见 `prompt` 不得直接包含 `correctAnswer`；汉字可用带声调拼音作为可见线索。需要让软件准确朗读答案线索时，使用可选的 `speechPrompt`，它只用于语音、不显示在题目中。数学可使用 `visualPrompt` 显示数字、数量、比较图或算式。

正常课程仍最多 20 题；测试课程可在同一个 session 中连续覆盖本学科全部正式目录，不再按 20 题分轮。

若已确认历史事件来自泄露答案的题目，AI 在 `state-update.json.ignoredEventIds` 中列出对应 `eventId`。软件只在正式状态中持久排除这些证据，不修改原始 session；被排除事件不参与状态升级、错误数或稳定掌握计算。

## 课程时间层与原始记录

- `next-lesson.json.metadata.previousNewHanziRefs`：上一次“今日课程”计划新学的汉字，供巩固练习使用，正常为 6 项。
- `next-lesson.json.metadata.nextPreviewHanziRefs`：下一次课程计划新学汉字中的前 4 项，供轻松预习使用；它不是今日新字。
- 新生成的 session 使用 `activityMode` 区分今日课程、预习、巩固和测试；今日课程另外保存 `plannedNewHanziRefs` 与 `plannedNextPreviewHanziRefs`，让下一次 Work 处理可以准确延续，不从题目名称猜测。
- 数学课程由软件根据正式状态和 `catalog/数学启蒙课程.json` 自动生成，并在 session 中保存 `plannedNewMathRefs`；AI 只分析作答并提出状态建议。

具体字段以同目录 `schemas/` 的 JSON Schema 为准；业务门禁比 Schema 更严格，由软件执行。
