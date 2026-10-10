use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DATA_ACCESS: Mutex<()> = Mutex::new(());

const LESSON_PROTOCOL: &str = "FAMILY_LEARNING_LESSON_V1";
const SESSION_PROTOCOL: &str = "FAMILY_LEARNING_SESSION_V1";
const STATE_PROTOCOL: &str = "FAMILY_LEARNING_STATE_V1";
const UPDATE_PROTOCOL: &str = "FAMILY_LEARNING_STATE_UPDATE_V1";
const PARENT_BASELINE_PROTOCOL: &str = "FAMILY_LEARNING_PARENT_BASELINE_V1";

const INITIAL_LESSON: &str = include_str!("../bootstrap/initial-next-lesson.json");
const WORKFLOW: &str = include_str!("../bootstrap/WORKFLOW.md");
const PROTOCOL_DOC: &str = include_str!("../../docs/PROTOCOL_V1.md");
const LESSON_SCHEMA: &str = include_str!("../../schemas/lesson.schema.json");
const SESSION_SCHEMA: &str = include_str!("../../schemas/session.schema.json");
const UPDATE_SCHEMA: &str = include_str!("../../schemas/state-update.schema.json");
const HANZI_CSV: &str = include_str!("../resources/幼儿汉字1000字表.csv");
const LETTER_CSV: &str = include_str!("../resources/英语字母26个.csv");
const MATH_CATALOG_JSON: &str = include_str!("../resources/数学启蒙课程.json");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationResult {
    valid: bool,
    errors: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStatus {
    state_update_status: String,
    state_update_errors: Vec<String>,
    parent_baseline_status: String,
    parent_baseline_errors: Vec<String>,
    parent_report: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dashboard {
    data_dir: String,
    lesson: Option<Value>,
    lesson_validation: ValidationResult,
    latest_session_id: Option<String>,
    state_summary: Value,
    test_catalog: Value,
    ai: AiStatus,
}

#[derive(Serialize)]
struct SaveResult {
    path: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("FAMILY_LEARNING_DATA_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let _ = app;
    Ok(PathBuf::from(r"C:\codex\AI家庭学习\data"))
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if !path.exists() {
        fs::write(path, content.as_bytes())
            .map_err(|error| format!("写入 {} 失败：{error}", path.display()))?;
    }
    Ok(())
}

fn stage_json(path: &Path, value: &Value) -> Result<PathBuf, String> {
    let content =
        serde_json::to_string_pretty(value).map_err(|error| format!("JSON 序列化失败：{error}"))?;
    loop {
        let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = path.with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建临时文件失败：{error}")),
        };
        let written = file.write_all(content.as_bytes()).and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&temporary);
            return Err(format!("写入临时文件失败：{error}"));
        }
        return Ok(temporary);
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = stage_json(path, value)?;
    // Rename replaces an existing file on Windows too. Never delete the original first.
    let result = fs::rename(&temporary, path)
        .map_err(|error| format!("提交 {} 失败，原文件已保留：{error}", path.display()));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_immutable_json(path: &Path, value: &Value) -> Result<(), String> {
    if path.exists() {
        return if read_json(path)? == *value {
            Ok(())
        } else {
            Err(format!("同名记录内容不同，已保留原文件：{}", path.display()))
        };
    }
    let temporary = stage_json(path, value)?;
    // Publish a complete file without replacing any existing raw record or archive.
    let published = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    match published {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            if read_json(path)? == *value {
                Ok(())
            } else {
                Err(format!("同名记录内容不同，已保留原文件：{}", path.display()))
            }
        }
        Err(error) => Err(format!("保存 {} 失败：{error}", path.display())),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("{} 不是有效 JSON：{error}", path.display()))
}

fn parse_hanzi_catalog() -> Map<String, Value> {
    let mut items = Map::new();
    for line in HANZI_CSV.lines().skip(1) {
        let columns: Vec<&str> = line.trim_end_matches('\r').split(',').collect();
        if columns.len() < 4 {
            continue;
        }
        items.insert(columns[0].to_string(), json!({
            "value": columns[3], "stage": columns[1], "theme": columns[2],
            "status": "未学", "nextReviewAt": null, "lastSeenAt": null,
            "metrics": { "contactSessionIds": [], "independentCorrectSessionIds": [], "questionTypes": [], "incorrectCount": 0 }
        }));
    }
    items
}

fn untouched_unlearned_item(item: &Value) -> bool {
    item.get("status").and_then(Value::as_str) == Some("未学")
        && item
            .get("parentConfirmedAt")
            .map(Value::is_null)
            .unwrap_or(true)
        && item
            .pointer("/metrics/contactSessionIds")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true)
        && item
            .pointer("/metrics/independentCorrectSessionIds")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true)
        && item
            .pointer("/metrics/questionTypes")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true)
        && item
            .pointer("/metrics/incorrectCount")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            == 0
}

fn reconcile_hanzi_catalog(items: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    for (target_ref, catalog_item) in parse_hanzi_catalog() {
        match items.get_mut(&target_ref) {
            None => {
                items.insert(target_ref, catalog_item);
                changed = true;
            }
            Some(current)
                if current.get("value") != catalog_item.get("value")
                    && untouched_unlearned_item(current) =>
            {
                *current = catalog_item;
                changed = true;
            }
            Some(_) => {}
        }
    }
    changed
}

fn parse_letter_catalog() -> Map<String, Value> {
    let mut items = Map::new();
    for line in LETTER_CSV.lines().skip(1) {
        let columns: Vec<&str> = line.trim_end_matches('\r').split(',').collect();
        if columns.len() < 4 {
            continue;
        }
        items.insert(columns[0].to_string(), json!({
            "value": format!("{} {}", columns[1], columns[2]), "uppercase": columns[1], "lowercase": columns[2], "association": columns[3],
            "status": "未学", "nextReviewAt": null, "lastSeenAt": null,
            "metrics": { "contactSessionIds": [], "independentCorrectSessionIds": [], "questionTypes": [], "incorrectCount": 0 }
        }));
    }
    items
}

fn parse_math_catalog() -> Map<String, Value> {
    let entries: Vec<Value> = serde_json::from_str(MATH_CATALOG_JSON)
        .expect("内置数学课程目录必须是有效 JSON");
    let mut items = Map::new();
    for entry in entries {
        let Some(target_ref) = entry.get("ref").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let mut item = entry.as_object().cloned().unwrap_or_default();
        item.remove("ref");
        item.insert("status".into(), Value::String("未学".into()));
        item.insert("nextReviewAt".into(), Value::Null);
        item.insert("lastSeenAt".into(), Value::Null);
        item.insert("metrics".into(), json!({
            "contactSessionIds": [], "independentCorrectSessionIds": [], "questionTypes": [], "incorrectCount": 0
        }));
        items.insert(target_ref, Value::Object(item));
    }
    items
}

fn initial_state() -> Value {
    json!({
        "protocol": STATE_PROTOCOL,
        "schemaVersion": 1,
        "createdAt": now(),
        "updatedAt": now(),
        "appliedUpdateIds": [],
        "appliedSessionIds": [],
        "appliedBaselineIds": [],
        "ignoredEventIds": [],
        "items": {
            "hanzi": Value::Object(parse_hanzi_catalog()),
            "english_letter": Value::Object(parse_letter_catalog()),
            "math": Value::Object(parse_math_catalog())
        }
    })
}

fn ensure_data(root: &Path) -> Result<(), String> {
    for relative in [
        "raw/sessions",
        "state",
        "ai/archive",
        "audio/voice-pack",
        "rules",
        "schemas",
        "catalog",
    ] {
        fs::create_dir_all(root.join(relative))
            .map_err(|error| format!("创建数据目录失败：{error}"))?;
    }
    write_if_missing(&root.join("rules/WORKFLOW.md"), WORKFLOW)?;
    write_if_missing(&root.join("rules/PROTOCOL_V1.md"), PROTOCOL_DOC)?;
    write_if_missing(&root.join("schemas/lesson.schema.json"), LESSON_SCHEMA)?;
    write_if_missing(&root.join("schemas/session.schema.json"), SESSION_SCHEMA)?;
    write_if_missing(
        &root.join("schemas/state-update.schema.json"),
        UPDATE_SCHEMA,
    )?;
    write_if_missing(&root.join("catalog/幼儿汉字1000字表.csv"), HANZI_CSV)?;
    write_if_missing(&root.join("catalog/英语字母26个.csv"), LETTER_CSV)?;
    write_if_missing(&root.join("catalog/数学启蒙课程.json"), MATH_CATALOG_JSON)?;

    let state_path = root.join("state/learning-state.json");
    if !state_path.exists() {
        write_json(&state_path, &initial_state())?;
    } else {
        let mut state = read_json(&state_path)?;
        let items = state
            .get_mut("items")
            .and_then(Value::as_object_mut)
            .ok_or("正式进度文件缺少 items 对象")?;
        let mut catalog_changed = false;
        {
            let hanzi = items
                .entry("hanzi".to_string())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or("正式进度文件 items.hanzi 必须是对象")?;
            catalog_changed |= reconcile_hanzi_catalog(hanzi);
        }
        {
            let math = items
                .entry("math".to_string())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or("正式进度文件 items.math 必须是对象")?;
            for (target_ref, item) in parse_math_catalog() {
                if !math.contains_key(&target_ref) {
                    math.insert(target_ref, item);
                    catalog_changed = true;
                }
            }
        }
        if catalog_changed {
            state["updatedAt"] = Value::String(now());
            write_json(&state_path, &state)?;
        }
    }

    let lesson_path = root.join("ai/next-lesson.json");
    let has_sessions = fs::read_dir(root.join("raw/sessions"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.path().extension().and_then(|x| x.to_str()) == Some("json"))
        })
        .unwrap_or(false);
    if !lesson_path.exists() && !has_sessions {
        write_if_missing(&lesson_path, INITIAL_LESSON)?;
    }
    Ok(())
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

fn list_sessions(root: &Path) -> Result<Vec<Value>, String> {
    let mut paths: Vec<PathBuf> = fs::read_dir(root.join("raw/sessions"))
        .map_err(|error| format!("无法读取原始记录目录：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    paths.sort();
    paths.into_iter().map(|path| read_json(&path)).collect()
}

fn item<'a>(state: &'a Value, subject: &str, target_ref: &str) -> Option<&'a Value> {
    state.get("items")?.get(subject)?.get(target_ref)
}

fn item_mut<'a>(state: &'a mut Value, subject: &str, target_ref: &str) -> Option<&'a mut Value> {
    state
        .get_mut("items")?
        .get_mut(subject)?
        .get_mut(target_ref)
}

fn choice_prompt_leaks_answer(task: &Value) -> bool {
    let prompt = task
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let answer = task
        .get("correctAnswer")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    !answer.is_empty() && prompt.contains(&answer)
}

fn child_facing_audience_issue(task: &Value) -> Option<&'static str> {
    const FIELDS: [&str; 6] = [
        "prompt",
        "speechPrompt",
        "context",
        "hint",
        "demonstration",
        "reinforcement",
    ];
    const THIRD_PERSON_PHRASES: [&str; 6] =
        ["请孩子", "让孩子", "孩子自己", "听孩子", "提醒孩子", "家长"];
    FIELDS.into_iter().find(|field| {
        task.get(*field)
            .and_then(Value::as_str)
            .is_some_and(|text| {
                THIRD_PERSON_PHRASES
                    .iter()
                    .any(|phrase| text.contains(phrase))
            })
    })
}

fn validate_lesson(lesson: &Value, state: &Value, latest_session_id: Option<&str>) -> Vec<String> {
    let mut errors = Vec::new();
    if lesson.get("protocol").and_then(Value::as_str) != Some(LESSON_PROTOCOL) {
        errors.push(format!("课程 protocol 必须为 {LESSON_PROTOCOL}"));
    }
    if lesson.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        errors.push("课程 schemaVersion 必须为 1".into());
    }
    if lesson
        .get("lessonId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        errors.push("课程缺少 lessonId".into());
    }
    let max_tasks = if lesson.pointer("/metadata/testScope").and_then(Value::as_str).is_some() {
        2000
    } else {
        20
    };
    let tasks = match lesson.get("tasks").and_then(Value::as_array) {
        Some(tasks) if !tasks.is_empty() && tasks.len() <= max_tasks => tasks,
        _ => {
            errors.push(format!("课程 tasks 必须包含 1 至 {max_tasks} 题"));
            return errors;
        }
    };
    let mut task_ids = HashSet::new();
    let mut new_hanzi = HashSet::new();
    let mut new_letters = HashSet::new();
    let mut new_math = HashSet::new();
    for (index, task) in tasks.iter().enumerate() {
        let label = format!("第 {} 题", index + 1);
        let task_id = task.get("taskId").and_then(Value::as_str).unwrap_or("");
        if task_id.is_empty() || !task_ids.insert(task_id.to_string()) {
            errors.push(format!("{label} taskId 缺失或重复"));
        }
        let subject = task.get("subject").and_then(Value::as_str).unwrap_or("");
        if subject != "hanzi" && subject != "english_letter" && subject != "math" {
            errors.push(format!("{label} 仅支持汉字、英语字母或数学"));
            continue;
        }
        let question_type = task
            .get("questionType")
            .and_then(Value::as_str)
            .unwrap_or("");
        if question_type != "recognition" && question_type != "choice" {
            errors.push(format!("{label} 题型不受支持"));
        }
        if let Some(field) = child_facing_audience_issue(task) {
            errors.push(format!(
                "{label} {field} 必须直接对孩子说，不能使用‘请孩子’或‘家长’等旁观口吻"
            ));
        }
        let target_ref = task
            .pointer("/target/ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let display = task
            .pointer("/target/display")
            .and_then(Value::as_str)
            .unwrap_or("");
        match item(state, subject, target_ref) {
            None => errors.push(format!("{label} 引用了不存在的 targetRef：{target_ref}")),
            Some(catalog_item) => {
                let expected = catalog_item
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if expected != display {
                    errors.push(format!("{label} target.display 与正式词库不一致"));
                }
            }
        }
        if task.get("isNew").and_then(Value::as_bool) == Some(true) {
            if subject == "hanzi" {
                new_hanzi.insert(target_ref);
            } else if subject == "english_letter" {
                new_letters.insert(target_ref);
            } else {
                new_math.insert(target_ref);
            }
        }
        if question_type == "choice" {
            let options = task.get("options").and_then(Value::as_array);
            if options.map(Vec::len) != Some(4) {
                errors.push(format!("{label} 选择题必须恰有 4 个选项"));
            }
            if let Some(options) = options {
                let mut seen_options = HashSet::new();
                for option in options {
                    match option.as_str().map(str::trim).filter(|value| !value.is_empty()) {
                        None => errors.push(format!("{label} 选择题选项必须是非空文字")),
                        Some(value) if !seen_options.insert(value) => {
                            errors.push(format!("{label} 选择题选项不能重复"));
                        }
                        Some(_) => {}
                    }
                }
            }
            let answer = task.get("correctAnswer");
            if !options
                .map(|values| values.iter().any(|value| Some(value) == answer))
                .unwrap_or(false)
            {
                errors.push(format!("{label} correctAnswer 不在 options 中"));
            }
            if choice_prompt_leaks_answer(task) {
                errors.push(format!("{label} 选择题题干不得直接出现正确答案"));
            }
        }
        if let Some(composition) = task.get("composition") {
            let valid = match (
                composition.get("whole").and_then(Value::as_i64),
                composition.get("left").and_then(Value::as_i64),
            ) {
                (Some(whole @ 2..=5), Some(left)) if left >= 1 && left < whole => {
                    let expected_ref = format!("M-COMP-{whole}");
                    let expected_answer = (whole - left).to_string();
                    let evidence = task.get("evidenceType").and_then(Value::as_str);
                    subject == "math"
                        && question_type == "choice"
                        && matches!(evidence, Some("math_visual_model" | "math_transfer"))
                        && target_ref == expected_ref
                        && task.get("correctAnswer").and_then(Value::as_str)
                            == Some(expected_answer.as_str())
                }
                _ => false,
            };
            if !valid {
                errors.push(format!("{label} 分与合的总数、分组或答案不一致"));
            }
        }
    }
    if new_hanzi.len() > 6 {
        errors.push("每课新汉字不得超过 6 个".into());
    }
    if new_letters.len() > 6 {
        errors.push("每课新字母不得超过 6 个".into());
    }
    if new_math.len() > 4 {
        errors.push("每课新数学目标不得超过 4 个".into());
    }
    for (field, max_items) in [
        ("previousNewHanziRefs", 6_usize),
        ("nextPreviewHanziRefs", 4_usize),
    ] {
        let Some(value) = lesson.pointer(&format!("/metadata/{field}")) else {
            continue;
        };
        let Some(refs) = value.as_array() else {
            errors.push(format!("课程 metadata.{field} 必须是数组"));
            continue;
        };
        if refs.len() > max_items {
            errors.push(format!("课程 metadata.{field} 最多 {max_items} 项"));
        }
        let mut seen_refs = HashSet::new();
        for target_ref in refs {
            let Some(target_ref) = target_ref
                .as_str()
                .filter(|target_ref| !target_ref.is_empty())
            else {
                errors.push(format!("课程 metadata.{field} 包含无效编号"));
                continue;
            };
            if !seen_refs.insert(target_ref.to_string()) {
                errors.push(format!("课程 metadata.{field} 包含重复编号：{target_ref}"));
            }
            if item(state, "hanzi", target_ref).is_none() {
                errors.push(format!(
                    "课程 metadata.{field} 引用了不存在的汉字：{target_ref}"
                ));
            }
        }
    }
    if let Some(latest) = latest_session_id {
        let based = lesson.get("basedOnSessionIds").and_then(Value::as_array);
        if !based
            .map(|values| values.iter().any(|value| value.as_str() == Some(latest)))
            .unwrap_or(false)
        {
            errors.push(format!("下一课必须基于最新学习记录 {latest}"));
        }
        if lesson.get("isBootstrap").and_then(Value::as_bool) == Some(true) {
            errors.push("已有学习记录后不能继续使用启动课程".into());
        }
    }
    errors
}

fn is_lesson_refresh_warning(issue: &str) -> bool {
    issue.starts_with("下一课必须基于最新学习记录") || issue == "已有学习记录后不能继续使用启动课程"
}

fn rank(subject: &str, status: &str) -> Option<i32> {
    match (subject, status) {
        ("hanzi", "未学") | ("english_letter", "未学") | ("math", "未学") => Some(0),
        ("hanzi", "初见") | ("english_letter", "初见") | ("math", "初见") => Some(1),
        ("hanzi", "学习中")
        | ("hanzi", "薄弱")
        | ("english_letter", "能指认")
        | ("english_letter", "薄弱")
        | ("math", "学习中")
        | ("math", "薄弱") => Some(2),
        ("hanzi", "会认") | ("english_letter", "能说出") | ("math", "理解") => Some(3),
        ("hanzi", "稳定掌握") | ("english_letter", "稳定掌握") | ("math", "稳定掌握") => Some(4),
        _ => None,
    }
}

fn evidence_for<'a>(
    sessions: &'a [Value],
    session_ids: &HashSet<String>,
    ignored_event_ids: &HashSet<String>,
    target_ref: &str,
) -> Vec<(&'a Value, &'a Value)> {
    let mut evidence = Vec::new();
    for session in sessions {
        let session_id = session
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !session_ids.contains(session_id) {
            continue;
        }
        for event in session
            .get("events")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let event_id = event.get("eventId").and_then(Value::as_str).unwrap_or("");
            if ignored_event_ids.contains(event_id) {
                continue;
            }
            if event.get("targetRef").and_then(Value::as_str) == Some(target_ref) {
                evidence.push((session, event));
            }
        }
    }
    evidence
}

fn metrics_for(sessions: &[Value], ignored_event_ids: &HashSet<String>, target_ref: &str) -> Value {
    let mut contacts = HashSet::new();
    let mut correct_sessions = HashSet::new();
    let mut question_types = HashSet::new();
    let mut incorrect_count = 0_u64;
    let mut last_seen = String::new();
    for session in sessions {
        let session_id = session
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        for event in session
            .get("events")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let event_id = event.get("eventId").and_then(Value::as_str).unwrap_or("");
            if ignored_event_ids.contains(event_id) {
                continue;
            }
            if event.get("targetRef").and_then(Value::as_str) != Some(target_ref) {
                continue;
            }
            contacts.insert(session_id.to_string());
            let recorded = event
                .get("recordedAt")
                .and_then(Value::as_str)
                .unwrap_or("");
            if recorded > last_seen.as_str() {
                last_seen = recorded.to_string();
            }
            if event.get("result").and_then(Value::as_str) == Some("incorrect") {
                incorrect_count += 1;
            }
            if event.get("result").and_then(Value::as_str) == Some("correct")
                && event.get("independent").and_then(Value::as_bool) == Some(true)
            {
                correct_sessions.insert(session_id.to_string());
                if let Some(kind) = event
                    .get("evidenceType")
                    .and_then(Value::as_str)
                    .or_else(|| event.get("questionType").and_then(Value::as_str))
                {
                    question_types.insert(kind.to_string());
                }
            }
        }
    }
    let mut contacts: Vec<String> = contacts.into_iter().collect();
    contacts.sort();
    let mut correct: Vec<String> = correct_sessions.into_iter().collect();
    correct.sort();
    let mut types: Vec<String> = question_types.into_iter().collect();
    types.sort();
    json!({
        "contactSessionIds": contacts,
        "independentCorrectSessionIds": correct,
        "questionTypes": types,
        "incorrectCount": incorrect_count,
        "lastSeenAt": if last_seen.is_empty() { Value::Null } else { Value::String(last_seen) }
    })
}

fn array_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn apply_parent_baseline(root: &Path, state: &mut Value) -> Result<(String, Vec<String>), String> {
    let path = root.join("ai/parent-baseline.json");
    if !path.exists() {
        return Ok(("missing".into(), Vec::new()));
    }
    let baseline = match read_json(&path) {
        Ok(value) => value,
        Err(error) => return Ok(("invalid".into(), vec![error])),
    };
    let mut errors = Vec::new();
    if baseline.get("protocol").and_then(Value::as_str) != Some(PARENT_BASELINE_PROTOCOL) {
        errors.push(format!(
            "parent-baseline protocol 必须为 {PARENT_BASELINE_PROTOCOL}"
        ));
    }
    if baseline.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        errors.push("parent-baseline schemaVersion 必须为 1".into());
    }
    let baseline_id = baseline
        .get("baselineId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !safe_id(baseline_id) {
        errors.push("baselineId 只能包含字母、数字、连字符和下划线".into());
    }
    if !errors.is_empty() {
        return Ok(("invalid".into(), errors));
    }
    let archive_path = root.join(format!("ai/archive/{baseline_id}.json"));
    let applied = array_strings(state.get("appliedBaselineIds"));
    if applied.iter().any(|value| value == baseline_id) {
        write_immutable_json(&archive_path, &baseline)?;
        return Ok(("already_applied".into(), Vec::new()));
    }
    let recorded_at = baseline
        .get("recordedAt")
        .and_then(Value::as_str)
        .unwrap_or("");
    if recorded_at.is_empty() {
        errors.push("parent-baseline 缺少 recordedAt".into());
    }
    let entries = baseline
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        errors.push("parent-baseline items 至少需要一项".into());
    }
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let label = format!("第 {} 条家长确认", index + 1);
        let subject = entry.get("subject").and_then(Value::as_str).unwrap_or("");
        let target_ref = entry.get("targetRef").and_then(Value::as_str).unwrap_or("");
        let display = entry.get("display").and_then(Value::as_str).unwrap_or("");
        if subject != "hanzi" && subject != "english_letter" && subject != "math" {
            errors.push(format!("{label} 仅支持汉字、英语字母或数学"));
            continue;
        }
        if entry.get("assessment").and_then(Value::as_str) != Some("not_tested") {
            errors.push(format!("{label} assessment 必须为 not_tested"));
        }
        if !seen.insert(format!("{subject}:{target_ref}")) {
            errors.push(format!("{label} 与前面的确认项重复"));
        }
        match item(state, subject, target_ref) {
            None => errors.push(format!("{label} targetRef 不存在：{target_ref}")),
            Some(catalog_item) => {
                let expected = catalog_item
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if expected != display {
                    errors.push(format!("{label} display 与正式词库不一致"));
                }
            }
        }
    }
    if !errors.is_empty() {
        return Ok(("invalid".into(), errors));
    }

    let mut next_state = state.clone();
    for entry in &entries {
        let subject = entry.get("subject").and_then(Value::as_str).unwrap_or("");
        let target_ref = entry.get("targetRef").and_then(Value::as_str).unwrap_or("");
        if let Some(target) = item_mut(&mut next_state, subject, target_ref) {
            if target.get("status").and_then(Value::as_str) == Some("未学") {
                target["status"] = Value::String("初见".into());
            }
            target["parentConfirmedAt"] = Value::String(recorded_at.to_string());
            target["needsAssessment"] = Value::Bool(true);
            target["nextReviewAt"] = Value::String(recorded_at.to_string());
        }
    }
    next_state["updatedAt"] = Value::String(now());
    let mut applied_ids = applied;
    applied_ids.push(baseline_id.to_string());
    applied_ids.sort();
    applied_ids.dedup();
    next_state["appliedBaselineIds"] = json!(applied_ids);
    write_immutable_json(&archive_path, &baseline)?;
    write_json(&root.join("state/learning-state.json"), &next_state)?;
    *state = next_state;
    Ok(("applied".into(), Vec::new()))
}

fn apply_state_update(
    root: &Path,
    state: &mut Value,
    sessions: &[Value],
) -> Result<(String, Vec<String>), String> {
    let path = root.join("ai/state-update.json");
    if !path.exists() {
        return Ok(("missing".into(), Vec::new()));
    }
    let update = match read_json(&path) {
        Ok(value) => value,
        Err(error) => return Ok(("invalid".into(), vec![error])),
    };
    let mut errors = Vec::new();
    if update.get("protocol").and_then(Value::as_str) != Some(UPDATE_PROTOCOL) {
        errors.push(format!("state-update protocol 必须为 {UPDATE_PROTOCOL}"));
    }
    if update.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        errors.push("state-update schemaVersion 必须为 1".into());
    }
    let update_id = update.get("updateId").and_then(Value::as_str).unwrap_or("");
    if !safe_id(update_id) {
        errors.push("updateId 只能包含字母、数字、连字符和下划线".into());
    }
    if !errors.is_empty() {
        return Ok(("invalid".into(), errors));
    }
    let archive_path = root.join(format!("ai/archive/{update_id}.json"));
    let applied = array_strings(state.get("appliedUpdateIds"));
    if applied.iter().any(|value| value == update_id) {
        write_immutable_json(&archive_path, &update)?;
        return Ok(("already_applied".into(), Vec::new()));
    }
    let based_ids = array_strings(update.get("basedOnSessionIds"));
    if based_ids.is_empty() {
        errors.push("basedOnSessionIds 至少需要一个原始记录".into());
    }
    let available: HashSet<String> = sessions
        .iter()
        .filter_map(|session| session.get("sessionId")?.as_str().map(str::to_string))
        .collect();
    for session_id in &based_ids {
        if !available.contains(session_id) {
            errors.push(format!("找不到依据记录：{session_id}"));
        }
    }
    let based_set: HashSet<String> = based_ids.iter().cloned().collect();
    let ignored_ids = array_strings(update.get("ignoredEventIds"));
    if update.get("ignoredEventIds").is_some()
        && update.get("ignoredEventIds").and_then(Value::as_array).is_none()
    {
        errors.push("ignoredEventIds 必须是数组".into());
    }
    let mut ignored_in_update = HashSet::new();
    for event_id in &ignored_ids {
        if !ignored_in_update.insert(event_id.clone()) {
            errors.push(format!("ignoredEventIds 包含重复事件：{event_id}"));
            continue;
        }
        let source_session = sessions.iter().find(|session| {
            session
                .get("events")
                .and_then(Value::as_array)
                .map(|events| {
                    events.iter().any(|event| {
                        event.get("eventId").and_then(Value::as_str) == Some(event_id.as_str())
                    })
                })
                .unwrap_or(false)
        });
        match source_session {
            None => errors.push(format!("ignoredEventIds 找不到原始事件：{event_id}")),
            Some(session) => {
                let session_id = session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !based_set.contains(session_id) {
                    errors.push(format!("忽略事件 {event_id} 所在记录未列入 basedOnSessionIds"));
                }
            }
        }
    }
    let mut effective_ignored: HashSet<String> =
        array_strings(state.get("ignoredEventIds")).into_iter().collect();
    effective_ignored.extend(ignored_ids.iter().cloned());
    let changes = update
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if update.get("changes").and_then(Value::as_array).is_none() {
        errors.push("changes 必须是数组".into());
    }
    let mut changed_targets = HashSet::new();

    for (index, change) in changes.iter().enumerate() {
        let label = format!("第 {} 条状态建议", index + 1);
        let subject = change.get("subject").and_then(Value::as_str).unwrap_or("");
        let target_ref = change
            .get("targetRef")
            .and_then(Value::as_str)
            .unwrap_or("");
        let proposed = change
            .get("proposedStatus")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !changed_targets.insert(format!("{subject}:{target_ref}")) {
            errors.push(format!("{label} 与前面的建议重复引用同一学习项"));
        }
        let current_item = match item(state, subject, target_ref) {
            Some(value) => value,
            None => {
                errors.push(format!("{label} targetRef 不存在：{target_ref}"));
                continue;
            }
        };
        let current = current_item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("未学");
        let Some(current_rank) = rank(subject, current) else {
            errors.push(format!("{label} 当前状态非法"));
            continue;
        };
        let Some(proposed_rank) = rank(subject, proposed) else {
            errors.push(format!("{label} proposedStatus 不属于该学科"));
            continue;
        };
        if proposed_rank > current_rank + 1 {
            errors.push(format!("{label} 不得从“{current}”跨级到“{proposed}”"));
        }
        let evidence = evidence_for(sessions, &based_set, &effective_ignored, target_ref);
        if evidence.is_empty() {
            errors.push(format!("{label} 在 basedOnSessionIds 中没有对应原始事件"));
        }
        if proposed_rank > current_rank
            && !evidence
                .iter()
                .any(|(_, event)| event.get("result").and_then(Value::as_str) == Some("correct"))
            && proposed != "初见"
        {
            errors.push(format!("{label} 升级到“{proposed}”缺少正确作答证据"));
        }
        if proposed == "薄弱"
            && current != "薄弱"
            && !evidence.iter().any(|(_, event)| {
                matches!(
                    event.get("result").and_then(Value::as_str),
                    Some("incorrect" | "hint_shown" | "demonstrated")
                )
            })
        {
            errors.push(format!("{label} 标记薄弱却没有错误或提示证据"));
        }
        if proposed_rank < current_rank && proposed != "薄弱" {
            errors.push(format!(
                "{label} 如需降级只能回到“薄弱”，不能直接改成“{proposed}”"
            ));
        }
        if proposed == "稳定掌握" {
            let metrics = metrics_for(sessions, &effective_ignored, target_ref);
            let session_count = metrics
                .get("independentCorrectSessionIds")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let type_count = metrics
                .get("questionTypes")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if session_count < 3 || type_count < 2 {
                errors.push(format!("{label} 稳定掌握需要至少 3 节独立答对且覆盖 2 种题型；当前为 {session_count} 节、{type_count} 种"));
            }
        }
    }
    if !errors.is_empty() {
        return Ok(("invalid".into(), errors));
    }

    let mut next_state = state.clone();
    for change in &changes {
        let subject = change.get("subject").and_then(Value::as_str).unwrap_or("");
        let target_ref = change
            .get("targetRef")
            .and_then(Value::as_str)
            .unwrap_or("");
        let metrics = metrics_for(sessions, &effective_ignored, target_ref);
        if let Some(target) = item_mut(&mut next_state, subject, target_ref) {
            target["status"] = change.get("proposedStatus").cloned().unwrap_or(Value::Null);
            target["nextReviewAt"] = change.get("nextReviewAt").cloned().unwrap_or(Value::Null);
            target["metrics"] = metrics.clone();
            target["lastSeenAt"] = metrics.get("lastSeenAt").cloned().unwrap_or(Value::Null);
            target["needsAssessment"] = Value::Bool(false);
        }
    }
    next_state["updatedAt"] = Value::String(now());
    let mut applied_updates = array_strings(state.get("appliedUpdateIds"));
    applied_updates.push(update_id.to_string());
    applied_updates.sort();
    applied_updates.dedup();
    let mut applied_sessions = array_strings(state.get("appliedSessionIds"));
    applied_sessions.extend(based_ids);
    applied_sessions.sort();
    applied_sessions.dedup();
    next_state["appliedUpdateIds"] = json!(applied_updates);
    next_state["appliedSessionIds"] = json!(applied_sessions);
    let mut ignored_events: Vec<String> = effective_ignored.into_iter().collect();
    ignored_events.sort();
    next_state["ignoredEventIds"] = json!(ignored_events);
    write_immutable_json(&archive_path, &update)?;
    write_json(&root.join("state/learning-state.json"), &next_state)?;
    *state = next_state;
    Ok(("applied".into(), Vec::new()))
}

fn state_summary(state: &Value) -> Value {
    let count = |subject: &str| -> usize {
        state
            .pointer(&format!("/items/{subject}"))
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .values()
                    .filter(|item| item.get("status").and_then(Value::as_str) != Some("未学"))
                    .count()
            })
            .unwrap_or(0)
    };
    let assessment_count = |subject: &str| -> usize {
        state
            .pointer(&format!("/items/{subject}"))
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .values()
                    .filter(|item| {
                        item.get("needsAssessment").and_then(Value::as_bool) == Some(true)
                    })
                    .count()
            })
            .unwrap_or(0)
    };
    json!({
        "hanziLearned": count("hanzi"),
        "letterLearned": count("english_letter"),
        "mathLearned": count("math"),
        "mathTotal": state.pointer("/items/math").and_then(Value::as_object).map(|items| items.len()).unwrap_or(0),
        "hanziNeedsAssessment": assessment_count("hanzi"),
        "letterNeedsAssessment": assessment_count("english_letter"),
        "mathNeedsAssessment": assessment_count("math")
    })
}

fn test_catalog(state: &Value) -> Value {
    let catalog_for = |subject: &str| -> Vec<Value> {
        state
            .get("items")
            .and_then(|items| items.get(subject))
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .map(|(target_ref, item)| {
                        let display = item
                            .get("value")
                            .and_then(Value::as_str)
                            .unwrap_or(target_ref);
                        let option_display = if subject == "english_letter" {
                            item.get("uppercase")
                                .and_then(Value::as_str)
                                .unwrap_or(display)
                        } else {
                            display
                        };
                        let last_seen_at = item
                            .get("lastSeenAt")
                            .filter(|value| !value.is_null())
                            .or_else(|| item.get("metrics").and_then(|metrics| metrics.get("lastSeenAt")))
                            .cloned()
                            .unwrap_or(Value::Null);
                        json!({
                            "ref": target_ref,
                            "display": display,
                            "optionDisplay": option_display,
                            "status": item.get("status").cloned().unwrap_or(Value::String("未学".into())),
                            "lastSeenAt": last_seen_at,
                            "incorrectCount": item.pointer("/metrics/incorrectCount").cloned().unwrap_or(Value::Number(0.into())),
                            "parentConfirmedAt": item.get("parentConfirmedAt").cloned().unwrap_or(Value::Null),
                            "needsAssessment": item.get("needsAssessment").cloned().unwrap_or(Value::Bool(false)),
                            "association": item.get("association").cloned().unwrap_or(Value::Null),
                            "stage": item.get("stage").cloned().unwrap_or(Value::Null),
                            "stageName": item.get("stageName").cloned().unwrap_or(Value::Null),
                            "order": item.get("order").cloned().unwrap_or(Value::Null),
                            "kind": item.get("kind").cloned().unwrap_or(Value::Null),
                            "number": item.get("number").cloned().unwrap_or(Value::Null),
                            "level": item.get("level").cloned().unwrap_or(Value::Null)
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    json!({
        "hanzi": catalog_for("hanzi"),
        "english_letter": catalog_for("english_letter"),
        "math": catalog_for("math")
    })
}

#[tauri::command]
fn load_dashboard(app: tauri::AppHandle) -> Result<Dashboard, String> {
    let _data_access = DATA_ACCESS.lock().map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    ensure_data(&root)?;
    let sessions = list_sessions(&root)?;
    let latest_session_id = sessions
        .last()
        .and_then(|session| session.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut state = read_json(&root.join("state/learning-state.json"))?;
    if state.get("protocol").and_then(Value::as_str) != Some(STATE_PROTOCOL) {
        return Err("正式进度文件协议错误，已停止使用以保护记录".into());
    }
    let (parent_baseline_status, parent_baseline_errors) =
        apply_parent_baseline(&root, &mut state)?;
    let (state_update_status, state_update_errors) =
        apply_state_update(&root, &mut state, &sessions)?;
    let lesson_path = root.join("ai/next-lesson.json");
    let lesson = if lesson_path.exists() {
        Some(read_json(&lesson_path)?)
    } else {
        None
    };
    let lesson_issues = lesson
        .as_ref()
        .map(|value| validate_lesson(value, &state, latest_session_id.as_deref()))
        .unwrap_or_else(|| vec!["缺少 ai/next-lesson.json".into()]);
    let (lesson_warnings, lesson_errors): (Vec<String>, Vec<String>) = lesson_issues
        .into_iter()
        .partition(|issue| is_lesson_refresh_warning(issue));
    let report_path = root.join("ai/parent-report.md");
    let parent_report = if report_path.exists() {
        Some(
            fs::read_to_string(&report_path)
                .map_err(|error| format!("读取家长报告失败：{error}"))?,
        )
    } else {
        None
    };
    Ok(Dashboard {
        data_dir: root.display().to_string(),
        lesson,
        lesson_validation: ValidationResult {
            valid: lesson_errors.is_empty(),
            errors: lesson_errors,
            warnings: lesson_warnings,
        },
        latest_session_id,
        state_summary: state_summary(&state),
        test_catalog: test_catalog(&state),
        ai: AiStatus {
            state_update_status,
            state_update_errors,
            parent_baseline_status,
            parent_baseline_errors,
            parent_report,
        },
    })
}

#[tauri::command]
fn load_voice_manifest(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let _data_access = DATA_ACCESS.lock().map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    ensure_data(&root)?;
    let path = root.join("audio/voice-pack/manifest.json");
    if !path.exists() {
        return Ok(None);
    }
    let manifest = read_json(&path)?;
    if manifest.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || manifest.get("clips").and_then(Value::as_object).is_none()
    {
        return Err("语音包 manifest.json 格式不正确".into());
    }
    Ok(Some(manifest))
}

#[tauri::command]
fn load_voice_clip(app: tauri::AppHandle, file_name: String) -> Result<Vec<u8>, String> {
    let safe_file_name = !file_name.is_empty()
        && file_name.len() <= 100
        && file_name.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
        })
        && (file_name.ends_with(".mp3") || file_name.ends_with(".wav"));
    if !safe_file_name {
        return Err("语音文件名包含不安全字符".into());
    }

    let root = data_dir(&app)?;
    let path = root.join("audio/voice-pack").join(&file_name);
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("读取语音文件 {} 失败：{error}", path.display()))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("单条语音文件不能超过 5 MB".into());
    }
    fs::read(&path).map_err(|error| format!("读取语音文件 {} 失败：{error}", path.display()))
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, session: Value) -> Result<SaveResult, String> {
    let _data_access = DATA_ACCESS.lock().map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    ensure_data(&root)?;
    if session.get("protocol").and_then(Value::as_str) != Some(SESSION_PROTOCOL) {
        return Err(format!("session protocol 必须为 {SESSION_PROTOCOL}"));
    }
    if session.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        return Err("session schemaVersion 必须为 1".into());
    }
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("缺少 sessionId")?;
    if !safe_id(session_id) {
        return Err("sessionId 包含不安全字符".into());
    }
    if session.get("endedAt").and_then(Value::as_str).is_none() {
        return Err("结束课程前必须写入 endedAt".into());
    }
    let state = read_json(&root.join("state/learning-state.json"))?;
    for (index, event) in session
        .get("events")
        .and_then(Value::as_array)
        .ok_or("events 必须是数组")?
        .iter()
        .enumerate()
    {
        let subject = event.get("subject").and_then(Value::as_str).unwrap_or("");
        let target_ref = event.get("targetRef").and_then(Value::as_str).unwrap_or("");
        if item(&state, subject, target_ref).is_none() {
            return Err(format!("第 {} 条事件引用了不存在的学习项", index + 1));
        }
        let question_type = event
            .get("questionType")
            .and_then(Value::as_str)
            .unwrap_or("");
        if question_type != "recognition" && question_type != "choice" {
            return Err(format!("第 {} 条事件题型不受支持", index + 1));
        }
        let result = event.get("result").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            result,
            "correct" | "incorrect" | "hint_shown" | "demonstrated"
        ) {
            return Err(format!("第 {} 条事件结果不受支持", index + 1));
        }
    }
    let path = root.join(format!("raw/sessions/{session_id}.json"));
    write_immutable_json(&path, &session)?;
    Ok(SaveResult {
        path: path.display().to_string(),
    })
}

#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let _data_access = DATA_ACCESS.lock().map_err(|_| "本地资料正在恢复，请重新打开软件")?;
    let root = data_dir(&app)?;
    ensure_data(&root)?;
    std::process::Command::new("explorer.exe")
        .arg(&root)
        .spawn()
        .map_err(|error| format!("无法打开数据文件夹：{error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            load_voice_manifest,
            load_voice_clip,
            save_session,
            open_data_folder
        ])
        .run(tauri::generate_context!())
        .expect("小芽家庭学习启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "family-learning-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    fn one_session() -> Value {
        json!({
            "protocol": SESSION_PROTOCOL,
            "schemaVersion": 1,
            "sessionId": "session-test-001",
            "lessonId": "lesson-test-001",
            "startedAt": "2026-08-20T08:00:00Z",
            "endedAt": "2026-08-20T08:08:00Z",
            "completed": true,
            "stopReason": "completed",
            "events": [{
                "eventId": "event-001",
                "recordedAt": "2026-08-20T08:01:00Z",
                "taskId": "task-001",
                "subject": "hanzi",
                "targetRef": "ZH-0001",
                "targetDisplay": "人",
                "questionType": "recognition",
                "attempt": 1,
                "result": "correct",
                "independent": true,
                "hintUsed": false,
                "responseTimeMs": 1200
            }]
        })
    }

    fn first_seen_update() -> Value {
        json!({
            "protocol": UPDATE_PROTOCOL,
            "schemaVersion": 1,
            "updateId": "update-retry-test",
            "generatedAt": "2026-08-20T08:10:00Z",
            "basedOnSessionIds": ["session-test-001"],
            "changes": [{
                "subject": "hanzi", "targetRef": "ZH-0001",
                "proposedStatus": "初见", "nextReviewAt": null,
                "reason": "实际接触并独立答对"
            }]
        })
    }

    #[test]
    fn retaining_existing_weakness_allows_correct_evidence_but_new_weakness_needs_error_evidence() {
        let root = test_root("retain-existing-weakness");
        fs::create_dir_all(root.join("ai/archive")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        fs::create_dir_all(root.join("raw/sessions")).unwrap();
        let session = one_session();
        let raw_path = root.join("raw/sessions/session-test-001.json");
        write_immutable_json(&raw_path, &session).unwrap();
        let raw_before = fs::read(&raw_path).unwrap();
        let mut update = first_seen_update();
        update["changes"][0]["proposedStatus"] = json!("薄弱");
        update["changes"][0]["reason"] = json!("本次独立答对，但证据尚不足以消除原有薄弱状态");
        write_json(&root.join("ai/state-update.json"), &update).unwrap();

        let mut state = initial_state();
        state["items"]["hanzi"]["ZH-0001"]["status"] = json!("学习中");
        write_json(&root.join("state/learning-state.json"), &state).unwrap();
        let before = state.clone();
        let (status, errors) = apply_state_update(&root, &mut state, &[session.clone()]).unwrap();
        assert_eq!(status, "invalid");
        assert!(errors.iter().any(|error| error.contains("标记薄弱却没有错误或提示证据")));
        assert_eq!(state, before);

        state["items"]["hanzi"]["ZH-0001"]["status"] = json!("薄弱");
        write_json(&root.join("state/learning-state.json"), &state).unwrap();
        let (status, errors) = apply_state_update(&root, &mut state, &[session.clone()]).unwrap();
        assert_eq!(status, "applied");
        assert!(errors.is_empty());
        assert_eq!(state["items"]["hanzi"]["ZH-0001"]["status"], "薄弱");
        assert_eq!(state["items"]["hanzi"]["ZH-0001"]["metrics"]["independentCorrectSessionIds"][0], "session-test-001");
        assert_eq!(apply_state_update(&root, &mut state, &[session]).unwrap().0, "already_applied");
        assert_eq!(fs::read(&raw_path).unwrap(), raw_before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn immutable_records_allow_identical_retries_and_reject_changed_payloads() {
        let root = test_root("immutable-retry");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.json");
        let session = one_session();
        write_immutable_json(&path, &session).unwrap();
        let original = fs::read(&path).unwrap();
        write_immutable_json(&path, &session).expect("identical retry succeeds");
        let mut changed = session.clone();
        changed["endedAt"] = json!("2026-08-20T08:09:00Z");
        assert!(write_immutable_json(&path, &changed).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_raw_publication_never_overwrites_the_winner() {
        use std::sync::{Arc, Barrier};
        let root = test_root("immutable-concurrent");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.json");
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|index| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut session = one_session();
                session["events"][0]["responseTimeMs"] = json!(index);
                barrier.wait();
                (write_immutable_json(&path, &session), session)
            })
        }).collect();
        let results: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|(result, _)| result.is_ok()).count(), 1);
        let winner = results.iter().find(|(result, _)| result.is_ok()).unwrap();
        assert_eq!(read_json(&path).unwrap(), winner.1);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn json_replacement_updates_an_existing_file_without_leftover_temporary_files() {
        let root = test_root("atomic-replace");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        write_json(&path, &json!({"version": 1})).unwrap();
        write_json(&path, &json!({"version": 2})).unwrap();
        assert_eq!(read_json(&path).unwrap(), json!({"version": 2}));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_windows_replacement_preserves_the_original_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_root("locked-replace");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        let original = json!({"version": 1});
        write_json(&path, &original).unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        assert!(write_json(&path, &json!({"version": 2})).is_err());
        drop(lock);
        assert_eq!(read_json(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_failure_leaves_formal_and_in_memory_progress_unchanged() {
        let root = test_root("archive-failure");
        fs::create_dir_all(root.join("ai/archive/update-retry-test.json")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        let mut state = initial_state();
        let original = state.clone();
        write_json(&root.join("state/learning-state.json"), &state).unwrap();
        write_json(&root.join("ai/state-update.json"), &first_seen_update()).unwrap();
        assert!(apply_state_update(&root, &mut state, &[one_session()]).is_err());
        assert_eq!(state, original);
        assert_eq!(read_json(&root.join("state/learning-state.json")).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_state_commit_can_retry_the_existing_archive_without_reapplying_twice() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_root("state-commit-retry");
        fs::create_dir_all(root.join("ai/archive")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        let mut state = initial_state();
        let original = state.clone();
        let state_path = root.join("state/learning-state.json");
        let archive_path = root.join("ai/archive/update-retry-test.json");
        write_json(&state_path, &state).unwrap();
        let update = first_seen_update();
        write_json(&root.join("ai/state-update.json"), &update).unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&state_path).unwrap();
        assert!(apply_state_update(&root, &mut state, &[one_session()]).is_err());
        assert_eq!(state, original);
        assert_eq!(read_json(&archive_path).unwrap(), update);
        drop(lock);
        assert_eq!(read_json(&state_path).unwrap(), original);
        assert_eq!(apply_state_update(&root, &mut state, &[one_session()]).unwrap().0, "applied");
        let committed = state.clone();
        assert_eq!(apply_state_update(&root, &mut state, &[one_session()]).unwrap().0, "already_applied");
        assert_eq!(state, committed);
        assert_eq!(state["appliedUpdateIds"], json!(["update-retry-test"]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn applied_update_repairs_a_missing_archive_and_rejects_reused_id_with_different_content() {
        let root = test_root("applied-archive-retry");
        fs::create_dir_all(root.join("ai/archive")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        let mut state = initial_state();
        let mut update = first_seen_update();
        let archive_path = root.join("ai/archive/update-retry-test.json");
        write_json(&root.join("ai/state-update.json"), &update).unwrap();
        apply_state_update(&root, &mut state, &[one_session()]).unwrap();
        let committed = state.clone();
        fs::remove_file(&archive_path).unwrap();
        assert_eq!(apply_state_update(&root, &mut state, &[one_session()]).unwrap().0, "already_applied");
        assert_eq!(read_json(&archive_path).unwrap(), update);
        update["changes"][0]["reason"] = json!("修改了已应用的建议");
        write_json(&root.join("ai/state-update.json"), &update).unwrap();
        assert!(apply_state_update(&root, &mut state, &[one_session()]).is_err());
        assert_eq!(state, committed);
        assert_eq!(read_json(&root.join("state/learning-state.json")).unwrap(), committed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_duplicate_blank_and_non_text_choice_options() {
        for options in [json!(["人", "大", "小", "人"]), json!(["人", "大", "小", " "]), json!(["人", "大", "小", 3])] {
            let mut lesson: Value = serde_json::from_str(INITIAL_LESSON).unwrap();
            lesson["tasks"][1]["options"] = options;
            let issues = validate_lesson(&lesson, &initial_state(), None);
            assert!(issues.iter().any(|issue| issue.contains("选项不能重复") || issue.contains("选项必须是非空文字")));
        }
    }

    #[test]
    fn rejects_cross_level_and_early_stable_mastery() {
        let root = test_root("reject-update");
        fs::create_dir_all(root.join("ai/archive")).expect("create test directory");
        let mut state = initial_state();
        write_json(&root.join("state.json"), &state).expect("write state");
        let update = json!({
            "protocol": UPDATE_PROTOCOL,
            "schemaVersion": 1,
            "updateId": "update-test-reject",
            "generatedAt": "2026-08-20T08:10:00Z",
            "basedOnSessionIds": ["session-test-001"],
            "changes": [{
                "subject": "hanzi", "targetRef": "ZH-0001",
                "proposedStatus": "稳定掌握", "nextReviewAt": null, "reason": "一次答对"
            }]
        });
        write_json(&root.join("ai/state-update.json"), &update).expect("write update");
        let (status, errors) =
            apply_state_update(&root, &mut state, &[one_session()]).expect("validate update");
        assert_eq!(status, "invalid");
        assert!(errors.iter().any(|error| error.contains("跨级")));
        assert!(errors.iter().any(|error| error.contains("至少 3 节")));
        assert_eq!(item(&state, "hanzi", "ZH-0001").unwrap()["status"], "未学");
        fs::remove_dir_all(root).expect("remove isolated test directory");
    }

    #[test]
    fn accepts_first_seen_with_raw_evidence() {
        let root = test_root("accept-update");
        fs::create_dir_all(root.join("ai/archive")).expect("create test directory");
        let mut state = initial_state();
        fs::create_dir_all(root.join("state")).expect("create state directory");
        let update = json!({
            "protocol": UPDATE_PROTOCOL,
            "schemaVersion": 1,
            "updateId": "update-test-accept",
            "generatedAt": "2026-08-20T08:10:00Z",
            "basedOnSessionIds": ["session-test-001"],
            "changes": [{
                "subject": "hanzi", "targetRef": "ZH-0001",
                "proposedStatus": "初见", "nextReviewAt": "2026-08-21T08:00:00Z", "reason": "本节实际接触并独立答对"
            }]
        });
        write_json(&root.join("ai/state-update.json"), &update).expect("write update");
        let (status, errors) =
            apply_state_update(&root, &mut state, &[one_session()]).expect("apply update");
        assert_eq!(status, "applied");
        assert!(errors.is_empty());
        assert_eq!(item(&state, "hanzi", "ZH-0001").unwrap()["status"], "初见");
        assert_eq!(state["appliedSessionIds"][0], "session-test-001");
        fs::remove_dir_all(root).expect("remove isolated test directory");
    }

    #[test]
    fn applies_parent_confirmed_items_as_untested_first_seen() {
        let root = test_root("parent-baseline");
        fs::create_dir_all(root.join("ai/archive")).expect("create ai directory");
        fs::create_dir_all(root.join("state")).expect("create state directory");
        let mut state = initial_state();
        write_json(&root.join("state/learning-state.json"), &state).expect("write state");
        let baseline = json!({
            "protocol": PARENT_BASELINE_PROTOCOL,
            "schemaVersion": 1,
            "baselineId": "parent-baseline-test",
            "recordedAt": "2026-08-21T10:58:37+08:00",
            "items": [
                {
                    "subject": "hanzi",
                    "targetRef": "ZH-0001",
                    "display": "人",
                    "assessment": "not_tested"
                },
                {
                    "subject": "math",
                    "targetRef": "M-NUM-1",
                    "display": "数字 1",
                    "assessment": "not_tested"
                }
            ]
        });
        write_json(&root.join("ai/parent-baseline.json"), &baseline).expect("write baseline");

        let (status, errors) =
            apply_parent_baseline(&root, &mut state).expect("apply parent baseline");
        assert_eq!(status, "applied");
        assert!(errors.is_empty());
        let target = item(&state, "hanzi", "ZH-0001").expect("target exists");
        assert_eq!(target["status"], "初见");
        assert_eq!(target["needsAssessment"], true);
        let math_target = item(&state, "math", "M-NUM-1").expect("math target exists");
        assert_eq!(math_target["status"], "初见");
        assert_eq!(math_target["needsAssessment"], true);
        assert_eq!(math_target["metrics"]["independentCorrectSessionIds"], json!([]));
        assert_eq!(state["appliedBaselineIds"][0], "parent-baseline-test");

        let (second_status, second_errors) =
            apply_parent_baseline(&root, &mut state).expect("repeat baseline");
        assert_eq!(second_status, "already_applied");
        assert!(second_errors.is_empty());
        fs::remove_dir_all(root).expect("remove isolated test directory");
    }

    #[test]
    fn replaces_only_untouched_hanzi_when_the_bundled_catalog_changes() {
        let mut state = initial_state();
        let hanzi = state
            .pointer_mut("/items/hanzi")
            .and_then(Value::as_object_mut)
            .expect("hanzi catalog");
        let replacements = [
            ("ZH-0942", "逾", "尾"),
            ("ZH-0947", "乃", "攻"),
            ("ZH-0955", "诺", "遇"),
            ("ZH-0962", "绑", "睛"),
            ("ZH-0972", "监", "影"),
            ("ZH-0974", "舔", "旗"),
            ("ZH-0981", "摄", "叔"),
            ("ZH-0986", "略", "暖"),
            ("ZH-0995", "勒", "灭"),
        ];
        for (target_ref, old_value, _) in replacements {
            hanzi.get_mut(target_ref).expect("replacement slot")["value"] =
                Value::String(old_value.into());
        }
        assert!(reconcile_hanzi_catalog(hanzi));
        for (target_ref, _, new_value) in replacements {
            assert_eq!(hanzi[target_ref]["value"], new_value);
        }

        hanzi.get_mut("ZH-0942").expect("replacement slot")["value"] = Value::String("逾".into());
        hanzi.get_mut("ZH-0942").expect("replacement slot")["status"] =
            Value::String("初见".into());
        assert!(!reconcile_hanzi_catalog(hanzi));
        assert_eq!(hanzi["ZH-0942"]["value"], "逾");
    }

    #[test]
    fn stale_bootstrap_lesson_only_needs_a_refresh_warning() {
        let lesson: Value = serde_json::from_str(INITIAL_LESSON).expect("parse lesson");
        let issues = validate_lesson(&lesson, &initial_state(), Some("session-new"));
        assert!(!issues.is_empty());
        assert!(issues.iter().all(|issue| is_lesson_refresh_warning(issue)));
    }

    #[test]
    fn rejects_choice_prompt_that_displays_the_correct_answer() {
        let mut lesson: Value = serde_json::from_str(INITIAL_LESSON).expect("parse lesson");
        lesson["tasks"][1]["prompt"] = json!("找到“人”，只要告诉我第几个。");
        let issues = validate_lesson(&lesson, &initial_state(), None);
        assert!(issues.iter().any(|issue| issue.contains("题干不得直接出现正确答案")));
    }

    #[test]
    fn rejects_parent_directed_classroom_language() {
        let mut lesson: Value = serde_json::from_str(INITIAL_LESSON).expect("parse lesson");
        lesson["tasks"][0]["speechPrompt"] = json!("请孩子自己读出这个字。");
        lesson["tasks"][0]["context"] = json!("家长先不要提示，听孩子说完再记录。");
        let issues = validate_lesson(&lesson, &initial_state(), None);
        assert!(issues
            .iter()
            .any(|issue| issue.contains("必须直接对孩子说")));
    }

    #[test]
    fn persists_ignored_evidence_without_mutating_raw_sessions() {
        let root = test_root("ignored-evidence");
        fs::create_dir_all(root.join("ai/archive")).expect("create ai directory");
        fs::create_dir_all(root.join("state")).expect("create state directory");
        let mut state = initial_state();
        let session = one_session();
        let ignored_event_id = session["events"][0]["eventId"]
            .as_str()
            .expect("event id")
            .to_string();
        let update = json!({
            "protocol": UPDATE_PROTOCOL,
            "schemaVersion": 1,
            "updateId": "update-ignore-leaked-prompt",
            "generatedAt": "2026-08-20T08:10:00Z",
            "basedOnSessionIds": ["session-test-001"],
            "ignoredEventIds": [ignored_event_id],
            "changes": []
        });
        write_json(&root.join("ai/state-update.json"), &update).expect("write update");
        let (status, errors) =
            apply_state_update(&root, &mut state, &[session.clone()]).expect("apply update");
        assert_eq!(status, "applied");
        assert!(errors.is_empty());
        assert_eq!(state["ignoredEventIds"][0], ignored_event_id);
        assert_eq!(session["events"][0]["result"], "correct");
        fs::remove_dir_all(root).expect("remove isolated test directory");
    }

    #[test]
    fn math_catalog_is_formal_and_math_lessons_pass_the_gate() {
        let state = initial_state();
        assert_eq!(
            state.pointer("/items/math").and_then(Value::as_object).map(|items| items.len()),
            Some(35)
        );
        let lesson = json!({
            "protocol": LESSON_PROTOCOL,
            "schemaVersion": 1,
            "lessonId": "math-lesson-test",
            "generatedAt": "2026-08-24T10:00:00Z",
            "basedOnSessionIds": [],
            "title": "数学第一课",
            "metadata": { "estimatedMinutes": 8, "mathStage": 1 },
            "tasks": [{
                "taskId": "math-num-0",
                "subject": "math",
                "questionType": "choice",
                "isNew": true,
                "prompt": "这个数字是几？",
                "visualPrompt": "0",
                "target": { "ref": "M-NUM-0", "display": "数字 0" },
                "hint": "想一想一个也没有。",
                "demonstration": "这是数字 0。",
                "options": ["0", "1", "2", "3"],
                "correctAnswer": "0"
            }]
        });
        assert!(validate_lesson(&lesson, &state, None).is_empty());
    }

    #[test]
    fn composition_board_requires_matching_whole_parts_and_answer() {
        let state = initial_state();
        let mut lesson = json!({
            "protocol": LESSON_PROTOCOL,
            "schemaVersion": 1,
            "lessonId": "composition-gate-test",
            "generatedAt": "2026-09-24T08:00:00Z",
            "basedOnSessionIds": [],
            "title": "分与合",
            "tasks": [{
                "taskId": "comp-5",
                "subject": "math",
                "questionType": "choice",
                "evidenceType": "math_visual_model",
                "isNew": false,
                "prompt": "把苹果分到两个盘子。",
                "target": { "ref": "M-COMP-5", "display": "5 的分与合" },
                "composition": { "whole": 5, "left": 1 },
                "hint": "再摆一次。",
                "demonstration": "一和四合起来是五。",
                "options": ["2", "3", "4", "5"],
                "correctAnswer": "4"
            }]
        });
        assert!(validate_lesson(&lesson, &state, None).is_empty());
        lesson["tasks"][0]["composition"]["left"] = json!(2);
        assert!(validate_lesson(&lesson, &state, None)
            .iter()
            .any(|error| error.contains("分与合的总数、分组或答案不一致")));
    }

    #[test]
    fn existing_state_is_migrated_with_unlearned_math_without_touching_sessions() {
        let root = test_root("math-migration");
        fs::create_dir_all(root.join("state")).expect("create state directory");
        let mut old_state = initial_state();
        old_state["items"].as_object_mut().expect("items").remove("math");
        write_json(&root.join("state/learning-state.json"), &old_state).expect("write old state");
        ensure_data(&root).expect("migrate data");
        let migrated = read_json(&root.join("state/learning-state.json")).expect("read migrated state");
        let math = migrated.pointer("/items/math").and_then(Value::as_object).expect("math catalog");
        assert_eq!(math.len(), 35);
        assert!(math.values().all(|item| item["status"] == "未学"));
        let raw_count = fs::read_dir(root.join("raw/sessions")).expect("raw sessions").count();
        assert_eq!(raw_count, 0);
        fs::remove_dir_all(root).expect("remove isolated test directory");
    }

}
