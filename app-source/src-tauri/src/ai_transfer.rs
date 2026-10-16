//! Offline AI exchange. The export is data, never authority to write progress.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const RESULT_PROTOCOL: &str = "FAMILY_LEARNING_AI_RESULT_V1";
const EXPORT_PROTOCOL: &str = "FAMILY_LEARNING_AI_EXPORT_V1";
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const TEACHING_TEMPLATES: &str = include_str!("../resources/ai-transfer-templates.json");
fn teaching_templates() -> &'static Value {
    static TEMPLATES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    TEMPLATES.get_or_init(|| {
        serde_json::from_str(TEACHING_TEMPLATES).expect("bundled teaching templates must be valid")
    })
}
fn template(subject: &str, target_ref: &str, kind: &str) -> Result<&'static Value, String> {
    teaching_templates()["templates"]
        .get(format!("{subject}:{target_ref}:{kind}"))
        .ok_or_else(|| "缺少正式教学模板，请更新软件".into())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiResult {
    protocol: String,
    schema_version: u8,
    export_id: String,
    base_revision: String,
    based_on_session_ids: Vec<String>,
    state_update: StateProposal,
    lesson_plan: LessonPlan,
    parent_report: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateProposal {
    ignored_event_ids: Vec<String>,
    changes: Vec<Change>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    subject: String,
    target_ref: String,
    proposed_status: String,
    next_review_at: Option<String>,
    reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LessonPlan {
    title: String,
    teacher_note: String,
    estimated_minutes: u32,
    reduced_new_hanzi_reason: String,
    previous_new_hanzi_refs: Vec<String>,
    next_preview_hanzi_refs: Vec<String>,
    tasks: Vec<PlanTask>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanTask {
    subject: String,
    target_ref: String,
    question_type: String,
    is_new: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceRequirement {
    text: String,
    voice: String,
    rate: String,
    pitch: String,
    volume: String,
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn canonical(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|e| format!("无法序列化文件：{e}"))
}
fn result_hash(bundle: &Value) -> Result<String, String> {
    Ok(digest(&canonical(bundle)?))
}
fn parse_result(bundle: &Value) -> Result<AiResult, String> {
    if canonical(bundle)?.len() > MAX_RESULT_BYTES {
        return Err("AI 返回文件超过 4 MB".into());
    }
    check_schema(bundle, &result_schema(), "AI返回")?;
    let result: AiResult =
        serde_json::from_value(bundle.clone()).map_err(|e| format!("AI 返回格式不正确：{e}"))?;
    if result.protocol != RESULT_PROTOCOL
        || result.schema_version != 1
        || !safe_id(&result.export_id)
    {
        return Err("这不是支持的 AI 返回文件；请使用导出文件中的模板".into());
    }
    if result.parent_report.trim().is_empty() || result.parent_report.len() > 100_000 {
        return Err("家长报告必须是非空文字且不超过 100 KB".into());
    }
    unique_strings(&result.based_on_session_ids, "basedOnSessionIds")?;
    unique_strings(&result.state_update.ignored_event_ids, "ignoredEventIds")?;
    for change in &result.state_update.changes {
        if change.reason.trim().is_empty()
            || rank(&change.subject, &change.proposed_status).is_none()
        {
            return Err("状态建议学科、状态或原因不正确".into());
        }
        if let Some(date) = &change.next_review_at {
            valid_date(date)?;
        }
    }
    let plan = &result.lesson_plan;
    if plan.title.trim().is_empty()
        || !(1..=30).contains(&plan.estimated_minutes)
        || !(1..=20).contains(&plan.tasks.len())
    {
        return Err("下一课需要标题、1 至 30 分钟及 1 至 20 个任务".into());
    }
    unique_strings(&plan.previous_new_hanzi_refs, "previousNewHanziRefs")?;
    unique_strings(&plan.next_preview_hanzi_refs, "nextPreviewHanziRefs")?;
    if plan.previous_new_hanzi_refs.len() > 6 || plan.next_preview_hanzi_refs.len() > 4 {
        return Err("上次新字最多 6 个、下次预习最多 4 个".into());
    }
    for task in &plan.tasks {
        if !matches!(task.subject.as_str(), "hanzi" | "english_letter")
            || !matches!(task.question_type.as_str(), "recognition" | "choice")
            || task.subject == "english_letter" && task.question_type != "choice"
        {
            return Err("下一课只接收汉字认读/选择、字母选择；数学由软件按阶段出题".into());
        }
    }
    Ok(result)
}
fn unique_strings(values: &[String], label: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    if values.iter().any(|s| s.is_empty() || !seen.insert(s)) {
        return Err(format!("{label} 含空值或重复项"));
    }
    Ok(())
}
fn valid_date(value: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| format!("日期时间必须符合 ISO 8601：{value}"))
}

// Covers every assertion used by the three bundled V1 schemas; rejects unknown fields.
fn check_schema(value: &Value, schema: &Value, label: &str) -> Result<(), String> {
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(format!("{label} 常量不正确"));
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err(format!("{label} 枚举值不正确"));
        }
    }
    if let Some(kind) = schema.get("type") {
        let valid = |kind: &str| match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => false,
        };
        if !kind.as_str().map(valid).unwrap_or_else(|| {
            kind.as_array()
                .is_some_and(|v| v.iter().filter_map(Value::as_str).any(valid))
        }) {
            return Err(format!("{label} 类型不正确"));
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{label} 缺少 {key}"));
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (key, child) in object {
            if let Some(spec) = properties.and_then(|p| p.get(key)) {
                check_schema(child, spec, &format!("{label}.{key}"))?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("{label} 包含额外字段 {key}"));
            }
        }
    }
    if let Some(array) = value.as_array() {
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|n| array.len() < n as usize)
            || schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|n| array.len() > n as usize)
        {
            return Err(format!("{label} 数量超出限制"));
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (index, child) in array.iter().enumerate() {
                if array[..index].contains(child) {
                    return Err(format!("{label} 包含重复项"));
                }
            }
        }
        if let Some(spec) = schema.get("items") {
            for (index, child) in array.iter().enumerate() {
                check_schema(child, spec, &format!("{label}[{index}]"))?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|n| text.chars().count() < n as usize)
        {
            return Err(format!("{label} 不能为空"));
        }
        if schema.get("pattern").is_some() && !safe_id(text) {
            return Err(format!("{label} 含不安全字符"));
        }
        if schema.get("format").and_then(Value::as_str) == Some("date-time") {
            valid_date(text)?;
        }
    }
    if let Some(number) = value.as_i64() {
        if schema
            .get("minimum")
            .and_then(Value::as_i64)
            .is_some_and(|n| number < n)
            || schema
                .get("maximum")
                .and_then(Value::as_i64)
                .is_some_and(|n| number > n)
        {
            return Err(format!("{label} 数值超出限制"));
        }
    }
    if let Some(rules) = schema.get("allOf").and_then(Value::as_array) {
        for rule in rules {
            if let Some(condition) = rule.get("if") {
                let branch = if check_schema(value, condition, label).is_ok() {
                    "then"
                } else {
                    "else"
                };
                if let Some(spec) = rule.get(branch) {
                    check_schema(value, spec, label)?;
                }
            } else {
                check_schema(value, rule, label)?;
            }
        }
    }
    Ok(())
}

struct Snapshot {
    state: Value,
    sessions: Vec<Value>,
    lesson: Value,
    pending: Vec<String>,
    revision: String,
}
fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let state = read_json(&root.join("state/learning-state.json"))?;
    if state["protocol"] != STATE_PROTOCOL || state["schemaVersion"] != 1 {
        return Err("正式学习状态格式不正确".into());
    }
    let sessions = list_sessions(root)?;
    let session_schema: Value = serde_json::from_str(SESSION_SCHEMA).map_err(|e| e.to_string())?;
    let mut session_ids = HashSet::new();
    let mut event_ids = HashSet::new();
    for session in &sessions {
        check_schema(session, &session_schema, "原始记录")?;
        let id = session["sessionId"].as_str().ok_or("原始记录缺少 ID")?;
        if !session_ids.insert(id) {
            return Err("原始记录含重复 sessionId，已停止导出/导入".into());
        }
        for event in session["events"].as_array().ok_or("原始记录缺少事件")? {
            let subject = event["subject"].as_str().unwrap_or("");
            let target_ref = event["targetRef"].as_str().unwrap_or("");
            if !event_ids.insert(event["eventId"].as_str().unwrap_or("")) {
                return Err("原始记录包含重复 eventId".into());
            }
            if item(&state, subject, target_ref).map(|i| &i["value"])
                != Some(&event["targetDisplay"])
            {
                return Err("原始记录学习项与正式词库不一致".into());
            }
        }
    }
    let applied: HashSet<String> = array_strings(state.get("appliedSessionIds"))
        .into_iter()
        .collect();
    let pending = sessions
        .iter()
        .filter_map(|s| s["sessionId"].as_str())
        .filter(|id| !applied.contains(*id))
        .map(str::to_string)
        .collect();
    let lesson = if root.join("ai/next-lesson.json").exists() {
        read_json(&root.join("ai/next-lesson.json"))?
    } else {
        Value::Null
    };
    let mut source_hashes = Map::new();
    for relative in [
        "rules/WORKFLOW.md",
        "rules/PROTOCOL_V1.md",
        "rules/MATH_V2_PLAN.md",
        "schemas/lesson.schema.json",
        "schemas/session.schema.json",
        "schemas/state-update.schema.json",
        "ai/state-update.json",
        "ai/parent-report.md",
    ] {
        if root.join(relative).exists() {
            source_hashes.insert(
                relative.into(),
                json!(digest(
                    &fs::read(root.join(relative)).map_err(|e| e.to_string())?
                )),
            );
        } else {
            source_hashes.insert(relative.into(), Value::Null);
        }
    }
    let revision = digest(&canonical(
        &json!({"state":state,"sessions":sessions,"lesson":lesson,"rules":source_hashes}),
    )?);
    Ok(Snapshot {
        state,
        sessions,
        lesson,
        pending,
        revision,
    })
}
fn independent(event: &Value) -> bool {
    event["result"] == "correct"
        && event["independent"] == true
        && event["hintUsed"] == false
        && event["attempt"] == 1
}
fn effective_metrics(
    sessions: &[Value],
    ignored: &HashSet<String>,
    subject: &str,
    target_ref: &str,
) -> Value {
    let mut contacts = BTreeSet::new();
    let mut correct = BTreeSet::new();
    let mut types = BTreeSet::new();
    let mut incorrect_count = 0;
    let mut last_seen = String::new();
    for session in sessions {
        for event in session["events"].as_array().into_iter().flatten() {
            if event["subject"] != subject
                || event["targetRef"] != target_ref
                || ignored.contains(event["eventId"].as_str().unwrap_or(""))
            {
                continue;
            }
            contacts.insert(session["sessionId"].as_str().unwrap_or("").to_string());
            if let Some(date) = event["recordedAt"].as_str() {
                if date > last_seen.as_str() {
                    last_seen = date.into();
                }
            }
            if event["result"] == "incorrect" {
                incorrect_count += 1;
            }
            if independent(event) {
                correct.insert(session["sessionId"].as_str().unwrap_or("").to_string());
                types.insert(event["questionType"].as_str().unwrap_or("").to_string());
            }
        }
    }
    json!({"contactSessionIds":contacts,"independentCorrectSessionIds":correct,"questionTypes":types,"incorrectCount":incorrect_count,"lastSeenAt":if last_seen.is_empty(){Value::Null}else{json!(last_seen)}})
}
fn history(snap: &Snapshot) -> Value {
    let ignored = array_strings(snap.state.get("ignoredEventIds"))
        .into_iter()
        .collect();
    let mut result = Vec::new();
    for subject in ["hanzi", "english_letter", "math"] {
        if let Some(items) = snap.state["items"][subject].as_object() {
            for (target_ref, entry) in items {
                let metrics = effective_metrics(&snap.sessions, &ignored, subject, target_ref);
                if metrics["contactSessionIds"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                {
                    result.push(json!({"subject":subject,"targetRef":target_ref,"display":entry["value"],"status":entry["status"],"metrics":metrics}));
                }
            }
        }
    }
    json!(result)
}
fn previous_refs(snap: &Snapshot) -> Vec<String> {
    snap.sessions
        .iter()
        .rev()
        .find(|s| {
            s["activityMode"] == "lesson" && !array_strings(s.get("plannedNewHanziRefs")).is_empty()
        })
        .map(|s| array_strings(s.get("plannedNewHanziRefs")))
        .unwrap_or_else(|| {
            let previous = array_strings(snap.lesson.pointer("/metadata/previousNewHanziRefs"));
            if !previous.is_empty() {
                return previous;
            }
            let mut result = Vec::new();
            for t in snap.lesson["tasks"].as_array().into_iter().flatten() {
                if t["subject"] == "hanzi" && t["isNew"] == true {
                    if let Some(r) = t.pointer("/target/ref").and_then(Value::as_str) {
                        if !result.contains(&r.to_string()) {
                            result.push(r.into());
                        }
                    }
                }
            }
            result
        })
}
fn future_refs(snap: &Snapshot, state: &Value) -> Vec<String> {
    let previous = previous_refs(snap);
    let mut refs = snap
        .sessions
        .iter()
        .rev()
        .find(|s| {
            s["activityMode"] == "lesson"
                && !array_strings(s.get("plannedNextPreviewHanziRefs")).is_empty()
        })
        .map(|s| array_strings(s.get("plannedNextPreviewHanziRefs")))
        .unwrap_or_else(|| array_strings(snap.lesson.pointer("/metadata/nextPreviewHanziRefs")));
    // Preview contact may be 初见; its first formal lesson must still follow the preview plan.
    refs.retain(|r| {
        !previous.contains(r)
            && item(state, "hanzi", r)
                .is_some_and(|i| matches!(i["status"].as_str(), Some("未学" | "初见")))
    });
    if let Some(items) = state.pointer("/items/hanzi").and_then(Value::as_object) {
        for (r, i) in items {
            if i["status"] == "未学" && !previous.contains(r) && !refs.contains(r) {
                refs.push(r.clone());
            }
        }
    }
    refs
}

fn result_schema() -> Value {
    let change = json!({"type":"object","additionalProperties":false,"required":["subject","targetRef","proposedStatus","nextReviewAt","reason"],"properties":{"subject":{"enum":["hanzi","english_letter","math"]},"targetRef":{"type":"string"},"proposedStatus":{"type":"string"},"nextReviewAt":{"type":["string","null"],"format":"date-time"},"reason":{"type":"string","minLength":1}}});
    let refs = json!({"type":"array","items":{"type":"string"},"uniqueItems":true});
    json!({"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"required":["protocol","schemaVersion","exportId","baseRevision","basedOnSessionIds","stateUpdate","lessonPlan","parentReport"],"properties":{
        "protocol":{"const":RESULT_PROTOCOL},"schemaVersion":{"const":1},"exportId":{"type":"string"},"baseRevision":{"type":"string"},"basedOnSessionIds":refs,
        "stateUpdate":{"type":"object","additionalProperties":false,"required":["ignoredEventIds","changes"],"properties":{"ignoredEventIds":refs,"changes":{"type":"array","items":change}}},
        "lessonPlan":{"type":"object","additionalProperties":false,"required":["title","teacherNote","estimatedMinutes","reducedNewHanziReason","previousNewHanziRefs","nextPreviewHanziRefs","tasks"],"properties":{
            "title":{"type":"string","minLength":1},"teacherNote":{"type":"string"},"estimatedMinutes":{"type":"integer","minimum":1,"maximum":30},"reducedNewHanziReason":{"type":"string"},"previousNewHanziRefs":refs,"nextPreviewHanziRefs":refs,
            "tasks":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["subject","targetRef","questionType","isNew"],"properties":{"subject":{"enum":["hanzi","english_letter"]},"targetRef":{"type":"string"},"questionType":{"enum":["recognition","choice"]},"isNew":{"type":"boolean"}}}}
        }},"parentReport":{"type":"string","minLength":1}
    }})
}
const MODEL_INSTRUCTIONS: &str = "你是课后分析助手。此文件由电脑端导出。只分析 pendingSessions 中未处理的真实记录，historyEvidence 是全部有效历史摘要，已经包含 pendingSessions 的证据，不得把两者的次数重复相加；formalState 是正式状态。不要把提示后正确当独立正确，不得跳级；稳定掌握必须至少3个不同场次独立答对并有2种真正questionType。只返回一个UTF-8 JSON文件，严格按resultSchema/resultTemplate填写，exportId/baseRevision/basedOnSessionIds原样复制，不得额外字段。只生成状态建议、课程目标编号/题型/是否新学和中文家长报告，不编写完整题面或语音，不运行命令、不访问外部服务、不修改本地文件。软件会自动组题、验证语音并原子导入。正常6新汉字，少于6须最新raw明确连续薄弱/疲劳/提前结束，且在reducedNewHanziReason、teacherNote和parentReport同样说明。previousNewHanziRefs与continuity.previousNewHanziRefs完全一致；本课新字按continuity.preferredNewHanziRefs的顺序取前6项；nextPreviewHanziRefs是排除本课新字后接续4项。最多20核心题/6新字母，数学不写入lessonPlan，由软件自动选课。提示泄题事件可列ignoredEventIds。不得声称建议已正式生效。analysisOnly为true时仅复盘，禁止输出可导入更新。导出数据含家庭学习记录，请仅交给家长选择的模型。";

fn export_to(root: &Path, selected: Option<&Path>) -> Result<Value, String> {
    let Some(path) = selected else {
        return Ok(json!({"cancelled":true}));
    };
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("json"))
    {
        return Err("导出文件必须使用 .json 扩展名".into());
    }
    let protected = fs::canonicalize(root).map_err(|e| format!("无法核对正式资料目录：{e}"))?;
    let resolved = if path.exists() {
        fs::canonicalize(path).map_err(|e| e.to_string())?
    } else {
        fs::canonicalize(path.parent().ok_or("导出位置缺少目录")?)
            .map_err(|e| format!("导出目录不存在：{e}"))?
            .join(path.file_name().ok_or("导出文件名为空")?)
    };
    if resolved.starts_with(&protected)
        || path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.contains(':'))
    {
        return Err("请把导出文件放在桌面或普通文件夹，不能覆盖软件正式资料目录".into());
    }
    let snap = snapshot(root)?;
    let generated = now();
    let export_id = format!(
        "export-{}-{}",
        Utc::now().format("%Y%m%d%H%M%S%f"),
        TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let mut rules = Map::new();
    for (relative, fallback) in [("rules/WORKFLOW.md",WORKFLOW),("rules/PROTOCOL_V1.md",PROTOCOL_DOC),("rules/MATH_V2_PLAN.md","数学六阶段：0—5数字与数量、6—10数字与数量、比较与顺序、2—5的分与合、5以内加减、10以内加减；六阶段全部开放，课程由软件生成，不写入AI下一课。")] {
        let content = if root.join(relative).exists() { fs::read_to_string(root.join(relative)).map_err(|e| e.to_string())? } else { fallback.into() };
        rules.insert(relative.into(), json!(content));
    }
    let future = future_refs(&snap, &snap.state);
    let template = json!({"protocol":RESULT_PROTOCOL,"schemaVersion":1,"exportId":export_id,"baseRevision":snap.revision,"basedOnSessionIds":snap.pending,
        "stateUpdate":{"ignoredEventIds":[],"changes":[]},"lessonPlan":{"title":"请填写下一课标题","teacherNote":"请按真实证据填写建议","estimatedMinutes":10,"reducedNewHanziReason":"","previousNewHanziRefs":previous_refs(&snap),"nextPreviewHanziRefs":future.iter().skip(6).take(4).collect::<Vec<_>>(),"tasks":future.iter().take(6).map(|r|json!({"subject":"hanzi","targetRef":r,"questionType":"recognition","isNew":true})).collect::<Vec<_>>()},"parentReport":"请填写简短中文报告，区分独立正确、提示后正确、薄弱与课程安排"});
    let payload = json!({"protocol":EXPORT_PROTOCOL,"schemaVersion":1,"exportId":export_id,"baseRevision":snap.revision,"exportedAt":generated,"analysisOnly":snap.pending.is_empty(),"instructions":MODEL_INSTRUCTIONS,
        "formalState":snap.state,"pendingSessions":snap.sessions.iter().filter(|s|snap.pending.iter().any(|id|s["sessionId"]==*id)).collect::<Vec<_>>(),"historyEvidence":history(&snap),"currentLesson":snap.lesson,
        "continuity":{"previousNewHanziRefs":previous_refs(&snap),"preferredNewHanziRefs":future},"rules":rules,
        "softwareSchemas":{"lesson":serde_json::from_str::<Value>(LESSON_SCHEMA).map_err(|e|e.to_string())?,"session":serde_json::from_str::<Value>(SESSION_SCHEMA).map_err(|e|e.to_string())?,"stateUpdate":serde_json::from_str::<Value>(UPDATE_SCHEMA).map_err(|e|e.to_string())?},
        "resultSchema":result_schema(),"resultTemplate":template});
    let trusted = root.join("ai-transfer/exports");
    fs::create_dir_all(&trusted).map_err(|e| e.to_string())?;
    // Record the trusted baseline before publishing the portable file. No raw/state/AI writes.
    let record_path = trusted.join(format!("{export_id}.json"));
    write_immutable_json(
        &record_path,
        &json!({"exportId":export_id,"baseRevision":snap.revision,"pendingSessionIds":snap.pending,"generatedAt":generated,"analysisOnly":snap.pending.is_empty()}),
    )?;
    if let Err(error) = write_json(path, &payload) {
        let _ = fs::remove_file(&record_path);
        return Err(error);
    }
    Ok(
        json!({"cancelled":false,"path":path.display().to_string(),"exportId":export_id,"pendingSessionCount":snap.pending.len(),"analysisOnly":snap.pending.is_empty()}),
    )
}

#[cfg(windows)]
fn save_dialog() -> Result<Option<PathBuf>, String> {
    use std::os::windows::process::CommandExt;
    // UTF-16 encoded PowerShell input, no interpolated user paths and no visible helper window.
    let script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Filter='JSON 文件 (*.json)|*.json'; $d.DefaultExt='json'; $d.AddExtension=$true; $d.FileName='小芽学习记录-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json'; $d.InitialDirectory=[Environment]::GetFolderPath('Desktop'); if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.FileName)}; $d.Dispose()";
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            script,
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("无法打开导出位置对话框：{e}"))?;
    if !output.status.success() {
        return Err("导出位置对话框打开失败，请重试".into());
    }
    let selected = String::from_utf8(output.stdout).map_err(|_| "无法读取选择的位置")?;
    if selected.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected.trim())))
    }
}
#[cfg(not(windows))]
fn save_dialog() -> Result<Option<PathBuf>, String> {
    Err("导出位置选择仅支持 Windows 电脑端".into())
}

#[tauri::command]
pub(super) fn export_ai_bundle(app: tauri::AppHandle) -> Result<Value, String> {
    let selected = save_dialog()?;
    if selected.is_none() {
        return Ok(json!({"cancelled":true}));
    }
    let _guard = DATA_ACCESS
        .lock()
        .map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    recover(&root)?;
    export_to(&root, selected.as_deref())
}

fn receipt_path(root: &Path, export_id: &str) -> PathBuf {
    root.join(format!("ai-transfer/receipts/{export_id}.json"))
}
fn duplicate(root: &Path, result: &AiResult, hash: &str) -> Result<bool, String> {
    let path = receipt_path(root, &result.export_id);
    if !path.exists() {
        return Ok(false);
    }
    let receipt = read_json(&path)?;
    if receipt["resultHash"] != hash {
        return Err("这个导出编号已经导入其他内容，不能用同一编号重复改变进度".into());
    }
    Ok(true)
}
fn checked_baseline(root: &Path, result: &AiResult) -> Result<Snapshot, String> {
    let path = root.join(format!("ai-transfer/exports/{}.json", result.export_id));
    if !path.exists() {
        return Err("找不到这份文件对应的本机导出凭证，请重新导出最新记录".into());
    }
    let record = read_json(&path)?;
    if record["analysisOnly"] == true {
        return Err("这份导出没有待处理记录，只能复盘，不能导入新课程".into());
    }
    let snap = snapshot(root)?;
    if snap.pending.is_empty()
        || result.base_revision != snap.revision
        || record["baseRevision"] != result.base_revision
    {
        return Err("导出后学习记录或课程/进度已经改变，请重新导出最新记录再分析".into());
    }
    let expected: BTreeSet<_> = snap.pending.iter().cloned().collect();
    let provided: BTreeSet<_> = result.based_on_session_ids.iter().cloned().collect();
    if expected != provided
        || array_strings(record.get("pendingSessionIds"))
            .into_iter()
            .collect::<BTreeSet<_>>()
            != expected
    {
        return Err("返回文件未完整覆盖这次导出的所有待处理记录".into());
    }
    Ok(snap)
}
fn update_value(result: &AiResult, generated: &str) -> Value {
    json!({"protocol":UPDATE_PROTOCOL,"schemaVersion":1,"updateId":format!("update-{}",result.export_id),"generatedAt":generated,"basedOnSessionIds":result.based_on_session_ids,"ignoredEventIds":result.state_update.ignored_event_ids,"changes":result.state_update.changes})
}
fn validate_evidence(snap: &Snapshot, result: &AiResult) -> Result<(), String> {
    let pending: HashSet<_> = result.based_on_session_ids.iter().cloned().collect();
    let mut ignored: HashSet<_> = array_strings(snap.state.get("ignoredEventIds"))
        .into_iter()
        .collect();
    ignored.extend(result.state_update.ignored_event_ids.iter().cloned());
    let mut changed = HashSet::new();
    for change in &result.state_update.changes {
        if !changed.insert((&change.subject, &change.target_ref)) {
            return Err("状态建议不能重复引用同一项目".into());
        }
        let current = item(&snap.state, &change.subject, &change.target_ref)
            .ok_or("状态建议引用不存在的项目")?;
        let current_rank = rank(&change.subject, current["status"].as_str().unwrap_or(""))
            .ok_or("正式状态不正确")?;
        let proposed_rank =
            rank(&change.subject, &change.proposed_status).ok_or("建议状态不正确")?;
        let evidence: Vec<_> = snap
            .sessions
            .iter()
            .filter(|s| pending.contains(s["sessionId"].as_str().unwrap_or("")))
            .flat_map(|s| s["events"].as_array().into_iter().flatten())
            .filter(|e| {
                e["subject"] == change.subject
                    && e["targetRef"] == change.target_ref
                    && !ignored.contains(e["eventId"].as_str().unwrap_or(""))
            })
            .collect();
        if evidence.is_empty() {
            return Err(format!("{} 没有本次有效作答依据", change.target_ref));
        }
        if proposed_rank > current_rank + 1 {
            return Err(format!("{} 不能跨级升级", change.target_ref));
        }
        if proposed_rank > current_rank
            && proposed_rank > 1
            && !evidence.iter().any(|e| independent(e))
        {
            return Err(format!(
                "{} 升级缺少独立正确依据；提示后通过不能升级",
                change.target_ref
            ));
        }
        if change.proposed_status == "稳定掌握" {
            let metrics = effective_metrics(
                &snap.sessions,
                &ignored,
                &change.subject,
                &change.target_ref,
            );
            if metrics["independentCorrectSessionIds"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0)
                < 3
                || metrics["questionTypes"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0)
                    < 2
            {
                return Err(format!(
                    "{} 稳定掌握需要至少 3 场独立正确和 2 种真正题型",
                    change.target_ref
                ));
            }
        }
    }
    Ok(())
}
fn stage_candidate(
    root: &Path,
    snap: &Snapshot,
    result: &AiResult,
    generated: &str,
) -> Result<Value, String> {
    validate_evidence(snap, result)?;
    let stage = root.join(format!(
        "ai-transfer/staging/{}-{}",
        result.export_id,
        TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(stage.join("ai/archive")).map_err(|e| e.to_string())?;
    fs::create_dir_all(stage.join("state")).map_err(|e| e.to_string())?;
    let outcome = (|| {
        let update = update_value(result, generated);
        check_schema(
            &update,
            &serde_json::from_str::<Value>(UPDATE_SCHEMA).map_err(|e| e.to_string())?,
            "状态建议",
        )?;
        write_json(&stage.join("ai/state-update.json"), &update)?;
        let mut candidate = snap.state.clone();
        let (status, errors) = apply_state_update(&stage, &mut candidate, &snap.sessions)?;
        if status != "applied" {
            return Err(errors.join("；"));
        }
        let ignored: HashSet<_> = array_strings(candidate.get("ignoredEventIds"))
            .into_iter()
            .collect();
        for change in &result.state_update.changes {
            let metrics = effective_metrics(
                &snap.sessions,
                &ignored,
                &change.subject,
                &change.target_ref,
            );
            if let Some(target) = item_mut(&mut candidate, &change.subject, &change.target_ref) {
                target["metrics"] = metrics.clone();
                target["lastSeenAt"] = metrics["lastSeenAt"].clone();
            }
        }
        candidate["updatedAt"] = json!(generated);
        Ok(candidate)
    })();
    // Private staging is generated by this function, never a user-selected path.
    let _ = fs::remove_dir_all(&stage);
    outcome
}
fn validate_plan(snap: &Snapshot, candidate: &Value, result: &AiResult) -> Result<(), String> {
    let plan = &result.lesson_plan;
    if plan.previous_new_hanzi_refs != previous_refs(snap) {
        return Err("上次新学汉字编号与真实今日课程计划不一致".into());
    }
    let mut new_hanzi = Vec::new();
    let mut new_letters = Vec::new();
    for task in &plan.tasks {
        let target =
            item(candidate, &task.subject, &task.target_ref).ok_or("课程引用不存在的学习项")?;
        if task.is_new {
            let preview = snap
                .sessions
                .iter()
                .rev()
                .find(|s| {
                    s["activityMode"] == "lesson"
                        && !array_strings(s.get("plannedNextPreviewHanziRefs")).is_empty()
                })
                .map(|s| array_strings(s.get("plannedNextPreviewHanziRefs")))
                .unwrap_or_else(|| {
                    array_strings(snap.lesson.pointer("/metadata/nextPreviewHanziRefs"))
                });
            if target["status"] != "未学"
                && !(task.subject == "hanzi"
                    && target["status"] == "初见"
                    && preview.contains(&task.target_ref)
                    && !previous_refs(snap).contains(&task.target_ref))
            {
                return Err(format!("{} 已正式学习，不能再次当新内容", task.target_ref));
            }
            let refs = if task.subject == "hanzi" {
                &mut new_hanzi
            } else {
                &mut new_letters
            };
            if !refs.contains(&task.target_ref) {
                refs.push(task.target_ref.clone());
            }
        } else if target["status"] == "未学"
            && !snap.sessions.iter().any(|s| {
                s["events"].as_array().is_some_and(|a| {
                    a.iter()
                        .any(|e| e["subject"] == task.subject && e["targetRef"] == task.target_ref)
                })
            })
        {
            return Err("尚未接触的学习项不能伪装成复习".into());
        }
    }
    if new_hanzi.len() > 6 || new_letters.len() > 6 {
        return Err("单课最多 6 个新汉字和 6 个新字母".into());
    }
    let preferred = future_refs(snap, candidate);
    if new_hanzi
        != preferred
            .iter()
            .take(new_hanzi.len())
            .cloned()
            .collect::<Vec<_>>()
    {
        return Err("新字必须承接上次预习并按正式课程顺序补齐，不能重复上次新字".into());
    }
    let hanzi_day = plan.tasks.iter().any(|t| t.subject == "hanzi");
    if hanzi_day && new_hanzi.len() < 6 && preferred.len() >= 6 {
        let reason = plan.reduced_new_hanzi_reason.trim();
        let latest = snap
            .sessions
            .iter()
            .rev()
            .find(|s| {
                result
                    .based_on_session_ids
                    .iter()
                    .any(|id| s["sessionId"] == *id)
            })
            .ok_or("缺少最新记录")?;
        let weak = latest["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| {
                matches!(
                    e["result"].as_str(),
                    Some("incorrect" | "hint_shown" | "demonstrated")
                )
            })
            .filter_map(|e| e["targetRef"].as_str())
            .collect::<HashSet<_>>()
            .len();
        let early = latest["completed"] == false
            && latest["stopReason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty());
        if reason.is_empty()
            || !plan.teacher_note.contains(reason)
            || !result.parent_report.contains(reason)
            || !(early || weak >= 2)
        {
            return Err(
                "减少正常 6 新字须最新记录有连续薄弱/提前结束，并在原因、教师建议和报告中一致说明"
                    .into(),
            );
        }
    } else if !plan.reduced_new_hanzi_reason.is_empty() && new_hanzi.len() == 6 {
        return Err("正常 6 新字时 reducedNewHanziReason 应为空字符串".into());
    }
    let expected_preview: Vec<_> = preferred
        .into_iter()
        .filter(|r| !new_hanzi.contains(r))
        .take(4)
        .collect();
    if plan.next_preview_hanzi_refs != expected_preview {
        return Err("下次预习必须是后续新字的前 4 个，不能预习今日新字".into());
    }
    Ok(())
}

fn prepare_at(root: &Path, bundle: &Value) -> Result<Value, String> {
    let result = parse_result(bundle)?;
    let hash = result_hash(bundle)?;
    if duplicate(root, &result, &hash)? {
        return Ok(
            json!({"alreadyImported":true,"message":"这份 AI 新内容已经导入，无需重复操作"}),
        );
    }
    let snap = checked_baseline(root, &result)?;
    let record_path = root.join(format!("ai-transfer/exports/{}.json", result.export_id));
    let mut record = read_json(&record_path)?;
    let generated = record["preparedAt"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(now);
    let candidate = stage_candidate(root, &snap, &result, &generated)?;
    validate_plan(&snap, &candidate, &result)?;
    record["preparedAt"] = json!(generated);
    write_json(&record_path, &record)?;
    Ok(
        json!({"alreadyImported":false,"bundle":bundle,"catalog":test_catalog(&candidate),"generatedAt":generated,"updateId":format!("update-{}",result.export_id),"lessonId":format!("lesson-{}",result.export_id)}),
    )
}
#[tauri::command]
pub(super) fn prepare_ai_import(app: tauri::AppHandle, bundle: Value) -> Result<Value, String> {
    let _guard = DATA_ACCESS
        .lock()
        .map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    recover(&root)?;
    prepare_at(&root, &bundle)
}

fn validate_compiled(
    snap: &Snapshot,
    candidate: &Value,
    result: &AiResult,
    lesson: &Value,
    generated: &str,
) -> Result<(), String> {
    check_schema(
        lesson,
        &serde_json::from_str::<Value>(LESSON_SCHEMA).map_err(|e| e.to_string())?,
        "完整课程",
    )?;
    let latest = snap.sessions.last().and_then(|s| s["sessionId"].as_str());
    let errors = validate_lesson(lesson, candidate, latest);
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    let plan = &result.lesson_plan;
    if lesson["lessonId"] != format!("lesson-{}", result.export_id)
        || lesson["generatedAt"] != generated
        || lesson["basedOnSessionIds"] != json!(result.based_on_session_ids)
        || lesson["title"] != plan.title
        || lesson["teacherNote"] != plan.teacher_note
        || lesson["isBootstrap"] != false
    {
        return Err("软件生成的完整课程与返回计划不一致".into());
    }
    let new_count = |subject: &str| {
        plan.tasks
            .iter()
            .filter(|t| t.subject == subject && t.is_new)
            .map(|t| &t.target_ref)
            .collect::<HashSet<_>>()
            .len()
    };
    let expected_metadata = json!({"estimatedMinutes":plan.estimated_minutes,"newHanziCount":new_count("hanzi"),"newLetterCount":new_count("english_letter"),"previousNewHanziRefs":plan.previous_new_hanzi_refs,"nextPreviewHanziRefs":plan.next_preview_hanzi_refs});
    if lesson["metadata"] != expected_metadata {
        return Err("课程 metadata 与计划不一致".into());
    }
    let tasks = lesson["tasks"].as_array().ok_or("完整课程缺少任务")?;
    if tasks.len() != plan.tasks.len() {
        return Err("课程任务数量与计划不一致".into());
    }
    for (index, (task, expected)) in tasks.iter().zip(&plan.tasks).enumerate() {
        if task["taskId"] != format!("transfer-{}-{}", result.export_id, index + 1)
            || task["subject"] != expected.subject
            || task["questionType"] != expected.question_type
            || task["isNew"] != expected.is_new
            || task["target"]["ref"] != expected.target_ref
        {
            return Err("课程任务顺序、目标、题型或编号与计划不一致".into());
        }
        let standard = template(
            &expected.subject,
            &expected.target_ref,
            &expected.question_type,
        )?;
        let fields = standard["fields"]
            .as_object()
            .ok_or("内置教学模板缺少题面")?;
        let actual = task.as_object().ok_or("课程任务必须是对象")?;
        for (key, value) in fields {
            if actual.get(key) != Some(value) {
                return Err(format!(
                    "第 {} 题 {key} 与软件标准教学模板不一致",
                    index + 1
                ));
            }
        }
        if actual.keys().any(|k| {
            !matches!(k.as_str(), "taskId" | "isNew" | "options") && !fields.contains_key(k)
        }) {
            return Err("完整题面包含标准教学模板以外的内容".into());
        }
        if expected.question_type == "choice" {
            let expected_answer = if expected.subject == "hanzi" {
                item(candidate, "hanzi", &expected.target_ref).map(|i| &i["value"])
            } else {
                item(candidate, "english_letter", &expected.target_ref).map(|i| &i["uppercase"])
            }
            .ok_or("选择题引用不存在")?;
            if &task["correctAnswer"] != expected_answer {
                return Err("选择题正确答案与正式词库不一致".into());
            }
            for option in task["options"].as_array().ok_or("选择题缺少选项")? {
                if !candidate["items"][&expected.subject]
                    .as_object()
                    .is_some_and(|items| {
                        items.values().any(|i| {
                            if expected.subject == "hanzi" {
                                &i["value"] == option
                            } else {
                                &i["uppercase"] == option
                            }
                        })
                    })
                {
                    return Err("选择题选项必须来自正式词库".into());
                }
                if expected.subject == "hanzi" && option != expected_answer {
                    let target = expected_answer.as_str().unwrap_or("");
                    let prompt = standard["fields"]["prompt"].as_str().unwrap_or("");
                    let pronunciation = prompt
                        .split('“')
                        .nth(1)
                        .and_then(|s| s.split('”').next())
                        .unwrap_or("");
                    if option.as_str().is_some_and(|s| {
                        teaching_templates()["pronunciations"][s]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|p| p == pronunciation))
                    }) {
                        return Err(format!("选择题包含与 {target} 同音的干扰字"));
                    }
                }
            }
        }
    }
    Ok(())
}
fn required_voices(lesson: &Value, candidate: &Value) -> Result<Value, String> {
    let mut voices = Map::new();
    let mut add = |clip: &Value| {
        if let Some(text) = clip["text"].as_str() {
            if !text.is_empty() && !voices.contains_key(text) {
                voices.insert(text.into(), clip.clone());
            }
        }
    };
    add(
        &json!({"text":"真棒，答对了！","voice":"zh-CN-XiaoyiNeural","rate":"+18%","pitch":"+8Hz","volume":"+0%"}),
    );
    add(
        &json!({"text":"太好了，这次答对了！","voice":"zh-CN-XiaoyiNeural","rate":"+16%","pitch":"+7Hz","volume":"+0%"}),
    );
    let tasks = lesson["tasks"].as_array().ok_or("课程任务必须是数组")?;
    for task in tasks {
        for clip in template(
            task["subject"].as_str().unwrap_or(""),
            task["target"]["ref"].as_str().unwrap_or(""),
            task["questionType"].as_str().unwrap_or(""),
        )?["clips"]
            .as_array()
            .ok_or("教学模板缺少语音")?
        {
            add(clip);
        }
    }
    for subject in ["hanzi", "english_letter"] {
        let new_refs: HashSet<_> = tasks
            .iter()
            .filter(|t| t["subject"] == subject && t["isNew"] == true)
            .filter_map(|t| t["target"]["ref"].as_str())
            .collect();
        let explicit = if subject == "hanzi" {
            array_strings(lesson.pointer("/metadata/nextPreviewHanziRefs"))
        } else {
            Vec::new()
        };
        let preview = if !explicit.is_empty() {
            explicit
        } else {
            candidate["items"][subject]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(r, i)| i["status"] == "未学" && !new_refs.contains(r.as_str()))
                .map(|(r, _)| r.clone())
                .collect()
        };
        for target_ref in preview
            .iter()
            .filter(|r| !new_refs.contains(r.as_str()))
            .take(4)
        {
            for clip in template(subject, target_ref, "preview")?["clips"]
                .as_array()
                .ok_or("预习模板缺少语音")?
            {
                add(clip);
            }
        }
        let mut previous = if subject == "hanzi" {
            array_strings(lesson.pointer("/metadata/previousNewHanziRefs"))
        } else {
            Vec::new()
        };
        if previous.is_empty() {
            for task in tasks.iter().filter(|t| t["subject"] == subject) {
                if let Some(r) = task["target"]["ref"].as_str() {
                    if !new_refs.contains(r) && !previous.contains(&r.to_string()) {
                        previous.push(r.into());
                    }
                }
            }
        }
        for target_ref in previous {
            for clip in template(subject, &target_ref, "practice")?["clips"]
                .as_array()
                .ok_or("巩固模板缺少语音")?
            {
                add(clip);
            }
        }
    }
    Ok(json!(voices))
}
fn validate_voice(
    root: &Path,
    lesson: &Value,
    candidate: &Value,
    requirements: &Value,
) -> Result<(), String> {
    let voices: Vec<VoiceRequirement> = serde_json::from_value(requirements.clone())
        .map_err(|e| format!("语音需求格式不正确：{e}"))?;
    if voices.is_empty() || voices.len() > 10000 {
        return Err("语音需求数量不正确".into());
    }
    let required = required_voices(lesson, candidate)?;
    let supplied = voices
        .iter()
        .map(|v| {
            Ok((
                v.text.clone(),
                serde_json::to_value(v).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<Map<_, _>, String>>()?;
    if Value::Object(supplied) != required {
        return Err("语音需求未完整对应标准课程、全部提示变体、预习与巩固，原课程已保留".into());
    }
    let mut seen = HashSet::new();
    let manifest = read_json(&root.join("audio/voice-pack/manifest.json"))
        .map_err(|_| "缺少晓伊自然语音包，请先更新语音；原课程已保留")?;
    for voice in &voices {
        if voice.text.trim() != voice.text
            || voice.text.is_empty()
            || !seen.insert(voice.text.clone())
            || voice.voice != "zh-CN-XiaoyiNeural"
            || voice.volume != "+0%"
            || !matches!(
                (voice.rate.as_str(), voice.pitch.as_str()),
                ("+18%", "+8Hz")
                    | ("+16%", "+7Hz")
                    | ("+14%", "+6Hz")
                    | ("+12%", "+5Hz")
                    | ("+10%", "+4Hz")
            )
        {
            return Err("语音需求必须是去重后的标准晓伊语音配置".into());
        }
        let clip = &manifest["clips"][&voice.text];
        if clip["voice"] != voice.voice
            || clip["rate"] != voice.rate
            || clip["pitch"] != voice.pitch
            || clip["volume"] != voice.volume
        {
            return Err(format!("语音缺失或配置不符：{}；原课程已保留", voice.text));
        }
        let file = clip["fileName"].as_str().ok_or("语音条目缺少文件")?;
        if !file.ends_with(".mp3")
            || file.len() > 100
            || !file
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            || file.contains("..")
        {
            return Err("语音文件名不安全".into());
        }
        let bytes = fs::read(root.join("audio/voice-pack").join(file))
            .map_err(|_| format!("语音文件缺失：{}；原课程已保留", voice.text))?;
        if bytes.len() < 32
            || !(bytes.starts_with(b"ID3")
                || bytes
                    .windows(2)
                    .take(4096)
                    .any(|b| b[0] == 0xff && b[1] & 0xe0 == 0xe0))
        {
            return Err(format!(
                "语音文件无有效 MP3 数据：{}；原课程已保留",
                voice.text
            ));
        }
    }
    for text in ["真棒，答对了！", "太好了，这次答对了！"] {
        if !seen.contains(text) {
            return Err("语音需求遗漏固定表扬".into());
        }
    }
    for task in lesson["tasks"].as_array().into_iter().flatten() {
        let question = task["speechPrompt"]
            .as_str()
            .or_else(|| task["prompt"].as_str())
            .unwrap_or("")
            .trim();
        if !seen.contains(question) {
            return Err("语音需求未覆盖当前课程朗读文字".into());
        }
    }
    // Preview and practice targets must each have a spoken question/explanation related to them.
    for field in ["previousNewHanziRefs", "nextPreviewHanziRefs"] {
        for target_ref in array_strings(lesson.pointer(&format!("/metadata/{field}"))) {
            let state = read_json(&root.join("state/learning-state.json"))?;
            let character = item(&state, "hanzi", &target_ref)
                .and_then(|i| i["value"].as_str())
                .ok_or("预习/巩固编号不正确")?;
            if !seen.iter().any(|text| text.contains(character)) {
                return Err("语音需求未覆盖预习或巩固项目".into());
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct TransactionFile {
    relative: String,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
struct Transaction {
    status: String,
    files: Vec<TransactionFile>,
}
fn transaction_path_allowed(relative: &str) -> bool {
    matches!(
        relative,
        "state/learning-state.json"
            | "ai/state-update.json"
            | "ai/next-lesson.json"
            | "ai/parent-report.md"
    ) || relative
        .strip_prefix("ai/archive/")
        .is_some_and(|s| s.ends_with(".json") && safe_id(s.trim_end_matches(".json")))
        || relative
            .strip_prefix("ai-transfer/receipts/")
            .is_some_and(|s| s.ends_with(".json") && safe_id(s.trim_end_matches(".json")))
}
fn replace_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("事务路径缺少目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| format!("提交失败：{e}"))
}
fn restore(root: &Path, transaction: &Transaction) -> Result<(), String> {
    for file in transaction.files.iter().rev() {
        if !transaction_path_allowed(&file.relative) {
            return Err("事务日志路径异常，已停止以保护记录".into());
        }
        let path = root.join(&file.relative);
        if let Some(bytes) = &file.before {
            replace_bytes(&path, bytes)?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub(super) fn recover(root: &Path) -> Result<(), String> {
    let directory = root.join("ai-transfer/transactions");
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mut transaction: Transaction =
            serde_json::from_value(read_json(&path)?).map_err(|e| format!("事务日志损坏：{e}"))?;
        if transaction.status == "prepared" {
            restore(root, &transaction)?;
            transaction.status = "rolled_back".into();
            write_json(
                &path,
                &serde_json::to_value(transaction).map_err(|e| e.to_string())?,
            )?;
        } else if !matches!(transaction.status.as_str(), "committed" | "rolled_back") {
            return Err("事务日志状态不正确".into());
        }
    }
    Ok(())
}
fn commit(
    root: &Path,
    export_id: &str,
    files: Vec<(String, Vec<u8>)>,
    fail_after: Option<usize>,
) -> Result<(), String> {
    let directory = root.join("ai-transfer/transactions");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!(
        "{export_id}-{}.json",
        TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut transaction = Transaction {
        status: "prepared".into(),
        files: Vec::new(),
    };
    for (relative, after) in files {
        if !transaction_path_allowed(&relative) {
            return Err("不允许的事务文件".into());
        }
        let target = root.join(&relative);
        let before = if target.exists() {
            Some(fs::read(&target).map_err(|e| e.to_string())?)
        } else {
            None
        };
        transaction.files.push(TransactionFile {
            relative,
            before,
            after,
        });
    }
    write_json(
        &path,
        &serde_json::to_value(&transaction).map_err(|e| e.to_string())?,
    )?;
    let outcome = (|| {
        for (index, file) in transaction.files.iter().enumerate() {
            if fail_after == Some(index) {
                return Err("模拟提交失败".into());
            }
            replace_bytes(&root.join(&file.relative), &file.after)?;
        }
        transaction.status = "committed".into();
        write_json(
            &path,
            &serde_json::to_value(&transaction).map_err(|e| e.to_string())?,
        )?;
        Ok(())
    })();
    if outcome.is_err() {
        transaction.status = "prepared".into();
        restore(root, &transaction)?;
        transaction.status = "rolled_back".into();
        write_json(
            &path,
            &serde_json::to_value(&transaction).map_err(|e| e.to_string())?,
        )?;
    }
    outcome
}
fn import_at(
    root: &Path,
    bundle: &Value,
    lesson: &Value,
    requirements: &Value,
) -> Result<Value, String> {
    let result = parse_result(bundle)?;
    let hash = result_hash(bundle)?;
    if duplicate(root, &result, &hash)? {
        return Ok(
            json!({"alreadyImported":true,"message":"这份 AI 新内容已经导入，无需重复操作"}),
        );
    }
    let snap = checked_baseline(root, &result)?;
    let record = read_json(&root.join(format!("ai-transfer/exports/{}.json", result.export_id)))?;
    let generated = record["preparedAt"]
        .as_str()
        .ok_or("请先让软件校验并生成待导入课程")?;
    let candidate = stage_candidate(root, &snap, &result, generated)?;
    validate_plan(&snap, &candidate, &result)?;
    validate_compiled(&snap, &candidate, &result, lesson, generated)?;
    validate_voice(root, lesson, &candidate, requirements)?;
    let update = update_value(&result, generated);
    let archive = format!("ai/archive/update-{}.json", result.export_id);
    if root.join(&archive).exists() && read_json(&root.join(&archive))? != update {
        return Err("更新归档同名内容不同，原内容已保留".into());
    }
    let receipt = json!({"exportId":result.export_id,"resultHash":hash,"importedAt":now(),"baseRevision":result.base_revision,"lessonId":lesson["lessonId"],"updateId":update["updateId"]});
    commit(
        root,
        &result.export_id,
        vec![
            ("ai/state-update.json".into(), canonical(&update)?),
            ("ai/next-lesson.json".into(), canonical(lesson)?),
            (
                "ai/parent-report.md".into(),
                result.parent_report.as_bytes().to_vec(),
            ),
            (archive, canonical(&update)?),
            (
                format!("ai-transfer/receipts/{}.json", result.export_id),
                canonical(&receipt)?,
            ),
            ("state/learning-state.json".into(), canonical(&candidate)?),
        ],
        None,
    )?;
    Ok(
        json!({"alreadyImported":false,"message":"AI 新课程与学习建议已校验并导入","lessonId":lesson["lessonId"],"updateId":update["updateId"]}),
    )
}
#[tauri::command]
pub(super) fn import_ai_result(
    app: tauri::AppHandle,
    bundle: Value,
    lesson: Value,
    voice_requirements: Value,
) -> Result<Value, String> {
    let _guard = DATA_ACCESS
        .lock()
        .map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    recover(&root)?;
    import_at(&root, &bundle, &lesson, &voice_requirements)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        output: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            let _ = fs::remove_file(&self.output);
        }
    }
    fn fixture(label: &str) -> Fixture {
        let id = format!(
            "ai-transfer-{label}-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(&id);
        let output = std::env::temp_dir().join(format!("{id}.json"));
        fs::create_dir_all(&root).unwrap();
        ensure_data(&root).unwrap();
        Fixture { root, output }
    }
    fn session(id: &str, question_type: &str, independent_correct: bool) -> Value {
        json!({"protocol":SESSION_PROTOCOL,"schemaVersion":1,"sessionId":id,"lessonId":"synthetic-lesson","startedAt":"2026-01-01T01:00:00Z","endedAt":"2026-01-01T01:10:00Z","completed":true,"stopReason":"completed","activityMode":"lesson","plannedNewHanziRefs":["ZH-0001","ZH-0002","ZH-0003","ZH-0004","ZH-0005","ZH-0006"],"plannedNextPreviewHanziRefs":["ZH-0007","ZH-0008","ZH-0009","ZH-0010"],"events":[{
            "eventId":format!("event-{id}"),"recordedAt":"2026-01-01T01:05:00Z","taskId":"synthetic-task","subject":"hanzi","targetRef":"ZH-0001","targetDisplay":"人","questionType":question_type,"attempt":if independent_correct{1}else{2},"result":"correct","independent":independent_correct,"hintUsed":!independent_correct,"responseTimeMs":2000
        }]})
    }
    fn add_session(f: &Fixture, id: &str, kind: &str, correct: bool) {
        write_json(
            &f.root.join(format!("raw/sessions/{id}.json")),
            &session(id, kind, correct),
        )
        .unwrap();
    }
    fn bundle(f: &Fixture) -> Value {
        export_to(&f.root, Some(&f.output)).unwrap();
        let exported = read_json(&f.output).unwrap();
        let mut result = exported["resultTemplate"].clone();
        result["parentReport"] =
            json!("模拟记录独立正确，下一课承接预习6新字；状态建议经软件校验后生效。");
        result["lessonPlan"]["title"] = json!("模拟下一课");
        result["lessonPlan"]["teacherNote"] = json!("先复习，再学六个新字。");
        result["stateUpdate"]["changes"] = json!([{"subject":"hanzi","targetRef":"ZH-0001","proposedStatus":"初见","nextReviewAt":null,"reason":"本次实际接触"}]);
        result
    }
    fn compiled(result: &Value, prepared: &Value) -> Value {
        let plan = &result["lessonPlan"];
        let tasks = plan["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, task)| {
                let mut full = template(
                    task["subject"].as_str().unwrap(),
                    task["targetRef"].as_str().unwrap(),
                    task["questionType"].as_str().unwrap(),
                )
                .unwrap()["fields"]
                    .clone();
                full["taskId"] = json!(format!(
                    "transfer-{}-{}",
                    result["exportId"].as_str().unwrap(),
                    index + 1
                ));
                full["isNew"] = task["isNew"].clone();
                full
            })
            .collect::<Vec<_>>();
        json!({"protocol":LESSON_PROTOCOL,"schemaVersion":1,"lessonId":prepared["lessonId"],"generatedAt":prepared["generatedAt"],"basedOnSessionIds":result["basedOnSessionIds"],"isBootstrap":false,"title":plan["title"],"teacherNote":plan["teacherNote"],"metadata":{"estimatedMinutes":plan["estimatedMinutes"],"newHanziCount":6,"newLetterCount":0,"previousNewHanziRefs":plan["previousNewHanziRefs"],"nextPreviewHanziRefs":plan["nextPreviewHanziRefs"]},"tasks":tasks})
    }
    fn install_voices(f: &Fixture, lesson: &Value, result: &Value) -> Value {
        let snap = snapshot(&f.root).unwrap();
        let parsed = parse_result(result).unwrap();
        let prepared = prepare_at(&f.root, result).unwrap();
        let candidate = stage_candidate(
            &f.root,
            &snap,
            &parsed,
            prepared["generatedAt"].as_str().unwrap(),
        )
        .unwrap();
        let expected = required_voices(lesson, &candidate).unwrap();
        let values = expected
            .as_object()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut clips = Map::new();
        for (index, requirement) in values.iter().enumerate() {
            let file = format!("synthetic-{index}.mp3");
            let mut bytes = vec![0; 40];
            bytes[..3].copy_from_slice(b"ID3");
            fs::write(f.root.join("audio/voice-pack").join(&file), bytes).unwrap();
            let mut entry = requirement.clone();
            entry["fileName"] = json!(file);
            clips.insert(requirement["text"].as_str().unwrap().into(), entry);
        }
        write_json(
            &f.root.join("audio/voice-pack/manifest.json"),
            &json!({"schemaVersion":1,"clips":clips}),
        )
        .unwrap();
        json!(values)
    }
    #[test]
    fn valid_roundtrip_is_atomic_and_idempotent() {
        let f = fixture("roundtrip");
        add_session(&f, "synthetic-001", "recognition", true);
        let raw = fs::read(f.root.join("raw/sessions/synthetic-001.json")).unwrap();
        let result = bundle(&f);
        let prepared = prepare_at(&f.root, &result).unwrap();
        let lesson = compiled(&result, &prepared);
        let voices = install_voices(&f, &lesson, &result);
        assert_eq!(
            import_at(&f.root, &result, &lesson, &voices).unwrap()["alreadyImported"],
            false
        );
        assert_eq!(
            read_json(&f.root.join("ai/next-lesson.json")).unwrap(),
            lesson
        );
        assert_eq!(
            read_json(&f.root.join("state/learning-state.json")).unwrap()["appliedSessionIds"],
            json!(["synthetic-001"])
        );
        assert_eq!(
            fs::read(f.root.join("raw/sessions/synthetic-001.json")).unwrap(),
            raw
        );
        assert_eq!(
            prepare_at(&f.root, &result).unwrap()["alreadyImported"],
            true
        );
        assert_eq!(
            import_at(&f.root, &result, &lesson, &json!([])).unwrap()["alreadyImported"],
            true
        );
        let mut changed = result.clone();
        changed["parentReport"] = json!("changed");
        assert!(prepare_at(&f.root, &changed)
            .unwrap_err()
            .contains("其他内容"));
    }
    #[test]
    fn actual_javascript_compiler_and_voice_collector_pass_full_rust_import() {
        let f = fixture("javascript-bridge");
        add_session(&f, "synthetic-001", "recognition", true);
        let mut result = bundle(&f);
        for (index, task) in result["lessonPlan"]["tasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            if index % 2 == 1 {
                task["questionType"] = json!("choice");
            }
        }
        result["lessonPlan"]["tasks"].as_array_mut().unwrap().insert(0,json!({"subject":"hanzi","targetRef":"ZH-0001","questionType":"choice","isNew":false}));
        result["lessonPlan"]["tasks"].as_array_mut().unwrap().push(json!({"subject":"english_letter","targetRef":"AL-01","questionType":"choice","isNew":true}));
        let prepared = prepare_at(&f.root, &result).unwrap();
        let input = f.root.join("synthetic-bridge-input.json");
        let output = f.root.join("synthetic-bridge-output.json");
        write_json(&input, &json!({"bundle":result,"context":prepared})).unwrap();
        let app = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let script="import {readFile,writeFile} from 'node:fs/promises'; import {pathToFileURL} from 'node:url'; const [modulePath,input,output]=process.argv.slice(1); const {compileAiLesson,collectAiVoiceRequirements}=await import(pathToFileURL(modulePath)); const fixture=JSON.parse(await readFile(input,'utf8')); const lesson=compileAiLesson(fixture.bundle,fixture.context); await writeFile(output,JSON.stringify({lesson,voiceRequirements:collectAiVoiceRequirements(lesson,fixture.context.catalog)}));";
        let process = std::process::Command::new("node")
            .args(["--input-type=module", "--eval", script])
            .arg(app.join("src/ai-transfer.js"))
            .arg(&input)
            .arg(&output)
            .current_dir(&app)
            .output()
            .expect("Node.js is required for the real desktop compiler integration check");
        assert!(
            process.status.success(),
            "JavaScript compiler failed: {}",
            String::from_utf8_lossy(&process.stderr)
        );
        let compiled = read_json(&output).unwrap();
        let lesson = &compiled["lesson"];
        let requirements = &compiled["voiceRequirements"];
        install_voices(&f, lesson, &result);
        assert_eq!(
            import_at(&f.root, &result, lesson, requirements).unwrap()["alreadyImported"],
            false
        );
        assert_eq!(
            read_json(&f.root.join("ai/next-lesson.json")).unwrap(),
            *lesson
        );
    }
    #[test]
    fn cancellation_and_analysis_only_do_not_change_ai() {
        let f = fixture("cancel");
        let before = fs::read(f.root.join("ai/next-lesson.json")).unwrap();
        assert_eq!(export_to(&f.root, None).unwrap()["cancelled"], true);
        assert!(!f.root.join("ai-transfer/exports").exists());
        assert_eq!(
            export_to(&f.root, Some(&f.output)).unwrap()["analysisOnly"],
            true
        );
        let mut result = read_json(&f.output).unwrap()["resultTemplate"].clone();
        result["parentReport"] = json!("复盘");
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("只能复盘"));
        assert_eq!(
            fs::read(f.root.join("ai/next-lesson.json")).unwrap(),
            before
        );
    }
    #[test]
    fn export_rejects_protected_paths_and_non_json() {
        let f = fixture("paths");
        let path = f.root.join("state/learning-state.json");
        let original = fs::read(&path).unwrap();
        assert!(export_to(&f.root, Some(&path))
            .unwrap_err()
            .contains("正式资料"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(export_to(&f.root, Some(&f.output.with_extension("exe"))).is_err());
    }
    #[test]
    fn strict_format_and_missing_export_proof_are_rejected() {
        let f = fixture("strict");
        add_session(&f, "synthetic-001", "recognition", true);
        let result = bundle(&f);
        let mut extra = result.clone();
        extra["lessonPlan"]["tasks"][0]["prompt"] = json!("自由题面");
        assert!(prepare_at(&f.root, &extra).is_err());
        let mut missing = result.clone();
        missing["exportId"] = json!("export-does-not-exist");
        assert!(prepare_at(&f.root, &missing).unwrap_err().contains("凭证"));
        let mut date = result.clone();
        date["stateUpdate"]["changes"][0]["nextReviewAt"] = json!("tomorrow");
        assert!(prepare_at(&f.root, &date).is_err());
        let mut omitted = result.clone();
        omitted["stateUpdate"]["changes"][0]
            .as_object_mut()
            .unwrap()
            .remove("nextReviewAt");
        assert!(prepare_at(&f.root, &omitted).is_err());
    }
    #[test]
    fn new_raw_and_changed_ai_or_state_invalidate_baseline() {
        for change in ["raw", "ai", "state"] {
            let f = fixture(change);
            add_session(&f, "synthetic-001", "recognition", true);
            let result = bundle(&f);
            match change {
                "raw" => add_session(&f, "synthetic-002", "choice", true),
                "ai" => fs::write(f.root.join("ai/parent-report.md"), "new report").unwrap(),
                _ => {
                    let mut state = read_json(&f.root.join("state/learning-state.json")).unwrap();
                    state["updatedAt"] = json!("2026-01-02T01:00:00Z");
                    write_json(&f.root.join("state/learning-state.json"), &state).unwrap();
                }
            }
            assert!(prepare_at(&f.root, &result)
                .unwrap_err()
                .contains("已经改变"));
        }
    }
    #[test]
    fn pending_set_cannot_omit_records() {
        let f = fixture("pending");
        add_session(&f, "synthetic-001", "recognition", true);
        add_session(&f, "synthetic-002", "choice", true);
        let mut result = bundle(&f);
        result["basedOnSessionIds"] = json!(["synthetic-001"]);
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("完整覆盖"));
    }
    #[test]
    fn independent_and_genuine_question_types_are_required() {
        let f = fixture("independent");
        add_session(&f, "synthetic-001", "recognition", false);
        let mut state = read_json(&f.root.join("state/learning-state.json")).unwrap();
        state["items"]["hanzi"]["ZH-0001"]["status"] = json!("初见");
        write_json(&f.root.join("state/learning-state.json"), &state).unwrap();
        let mut result = bundle(&f);
        result["stateUpdate"]["changes"][0]["proposedStatus"] = json!("学习中");
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("独立正确"));
        result["stateUpdate"]["changes"][0]["proposedStatus"] = json!("会认");
        assert!(prepare_at(&f.root, &result).unwrap_err().contains("跨级"));
        let f = fixture("fake-types");
        for index in 1..=3 {
            let id = format!("synthetic-{index:03}");
            let mut s = session(&id, "recognition", true);
            s["events"][0]["evidenceType"] = json!(format!("different-evidence-{index}"));
            write_json(&f.root.join(format!("raw/sessions/{id}.json")), &s).unwrap();
        }
        let mut state = read_json(&f.root.join("state/learning-state.json")).unwrap();
        state["items"]["hanzi"]["ZH-0001"]["status"] = json!("会认");
        write_json(&f.root.join("state/learning-state.json"), &state).unwrap();
        let mut result = bundle(&f);
        result["stateUpdate"]["changes"][0]["proposedStatus"] = json!("稳定掌握");
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("真正题型"));
    }
    #[test]
    fn stable_mastery_accepts_three_independent_sessions_with_two_question_types() {
        let f = fixture("stable-valid");
        add_session(&f, "synthetic-001", "recognition", true);
        add_session(&f, "synthetic-002", "choice", true);
        add_session(&f, "synthetic-003", "recognition", true);
        let mut state = read_json(&f.root.join("state/learning-state.json")).unwrap();
        state["items"]["hanzi"]["ZH-0001"]["status"] = json!("会认");
        write_json(&f.root.join("state/learning-state.json"), &state).unwrap();
        let mut result = bundle(&f);
        result["stateUpdate"]["changes"][0]["proposedStatus"] = json!("稳定掌握");
        assert!(prepare_at(&f.root, &result).is_ok());
        result["stateUpdate"]["ignoredEventIds"] = json!(["event-synthetic-002"]);
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("真正题型"));
    }
    #[test]
    fn standard_template_and_complete_voice_coverage_cannot_be_bypassed() {
        let f = fixture("voices");
        add_session(&f, "synthetic-001", "recognition", true);
        let result = bundle(&f);
        let prepared = prepare_at(&f.root, &result).unwrap();
        let lesson = compiled(&result, &prepared);
        let voices = install_voices(&f, &lesson, &result);
        let mut tampered = lesson.clone();
        tampered["tasks"][0]["hint"] = json!("任意编写");
        assert!(import_at(&f.root, &result, &tampered, &voices)
            .unwrap_err()
            .contains("模板"));
        assert!(import_at(&f.root, &result, &lesson, &json!([])).is_err());
        let mut omitted = voices.clone();
        omitted.as_array_mut().unwrap().pop();
        assert!(import_at(&f.root, &result, &lesson, &omitted)
            .unwrap_err()
            .contains("未完整"));
        let voice = &voices[0];
        let manifest = read_json(&f.root.join("audio/voice-pack/manifest.json")).unwrap();
        let path = f.root.join("audio/voice-pack").join(
            manifest["clips"][voice["text"].as_str().unwrap()]["fileName"]
                .as_str()
                .unwrap(),
        );
        fs::write(path, []).unwrap();
        assert!(import_at(&f.root, &result, &lesson, &voices)
            .unwrap_err()
            .contains("MP3"));
        assert!(snapshot(&f.root)
            .unwrap()
            .pending
            .contains(&"synthetic-001".into()));
    }
    #[test]
    fn later_math_does_not_erase_hanzi_continuity_and_preview_contact_is_new() {
        let f = fixture("continuity");
        add_session(&f, "synthetic-001", "recognition", true);
        let mut math = session("synthetic-002", "choice", true);
        math["plannedNewHanziRefs"] = json!([]);
        math["plannedNextPreviewHanziRefs"] = json!([]);
        math["events"] = json!([]);
        write_json(&f.root.join("raw/sessions/synthetic-002.json"), &math).unwrap();
        let mut result = bundle(&f);
        assert_eq!(
            result["lessonPlan"]["previousNewHanziRefs"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        let mut preview = session("synthetic-003", "recognition", true);
        preview["activityMode"] = json!("preview");
        preview["events"][0]["targetRef"] = json!("ZH-0007");
        preview["events"][0]["targetDisplay"] =
            initial_state()["items"]["hanzi"]["ZH-0007"]["value"].clone();
        write_json(&f.root.join("raw/sessions/synthetic-003.json"), &preview).unwrap();
        result = bundle(&f);
        result["stateUpdate"]["changes"].as_array_mut().unwrap().push(json!({"subject":"hanzi","targetRef":"ZH-0007","proposedStatus":"初见","nextReviewAt":null,"reason":"轻松预习接触"}));
        assert!(prepare_at(&f.root, &result).is_ok());
    }
    #[test]
    fn one_wrong_answer_plus_hint_is_not_continuous_weakness() {
        let f = fixture("weakness");
        let mut s = session("synthetic-001", "recognition", false);
        s["events"][0]["result"] = json!("incorrect");
        let mut hint = s["events"][0].clone();
        hint["eventId"] = json!("synthetic-hint");
        hint["result"] = json!("hint_shown");
        s["events"].as_array_mut().unwrap().push(hint);
        write_json(&f.root.join("raw/sessions/synthetic-001.json"), &s).unwrap();
        let mut result = bundle(&f);
        result["lessonPlan"]["tasks"] = json!([{"subject":"hanzi","targetRef":"ZH-0001","questionType":"recognition","isNew":false}]);
        result["lessonPlan"]["nextPreviewHanziRefs"] =
            json!(["ZH-0007", "ZH-0008", "ZH-0009", "ZH-0010"]);
        let reason = "一次错误后提示";
        result["lessonPlan"]["reducedNewHanziReason"] = json!(reason);
        result["lessonPlan"]["teacherNote"] = json!(reason);
        result["parentReport"] = json!(reason);
        assert!(prepare_at(&f.root, &result)
            .unwrap_err()
            .contains("减少正常"));
    }
    #[test]
    fn failed_commit_rolls_back_and_startup_recovers_prepared_journal() {
        let f = fixture("rollback");
        let state = fs::read(f.root.join("state/learning-state.json")).unwrap();
        let lesson = fs::read(f.root.join("ai/next-lesson.json")).unwrap();
        let files = vec![
            ("ai/next-lesson.json".into(), b"replacement".to_vec()),
            ("state/learning-state.json".into(), b"new state".to_vec()),
        ];
        assert!(commit(&f.root, "synthetic-rollback", files, Some(1)).is_err());
        assert_eq!(
            fs::read(f.root.join("ai/next-lesson.json")).unwrap(),
            lesson
        );
        assert_eq!(
            fs::read(f.root.join("state/learning-state.json")).unwrap(),
            state
        );
        let transaction = Transaction {
            status: "prepared".into(),
            files: vec![
                TransactionFile {
                    relative: "ai/next-lesson.json".into(),
                    before: Some(lesson.clone()),
                    after: b"partial".to_vec(),
                },
                TransactionFile {
                    relative: "ai/parent-report.md".into(),
                    before: None,
                    after: b"partial report".to_vec(),
                },
            ],
        };
        fs::write(f.root.join("ai/next-lesson.json"), b"partial").unwrap();
        fs::write(f.root.join("ai/parent-report.md"), b"partial report").unwrap();
        write_json(
            &f.root
                .join("ai-transfer/transactions/synthetic-interrupted.json"),
            &serde_json::to_value(transaction).unwrap(),
        )
        .unwrap();
        recover(&f.root).unwrap();
        assert_eq!(
            fs::read(f.root.join("ai/next-lesson.json")).unwrap(),
            lesson
        );
        assert!(!f.root.join("ai/parent-report.md").exists());
        assert_eq!(
            fs::read(f.root.join("state/learning-state.json")).unwrap(),
            state
        );
    }
}
