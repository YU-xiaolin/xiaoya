// 本地存储层：IndexedDB。
// 学习记录优先保存在手机上，只有点击“上传学习记录”才同步到云端。
const DB_NAME = "xiaoya-family-learning";
const DB_VERSION = 2;

let dbPromise = null;

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("当前浏览器不支持 IndexedDB，无法离线保存学习记录"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "sessionId" });
        // IndexedDB 的键不能是布尔值，同步状态用 0/1 数字表示。
        store.createIndex("uploadedFlag", "uploadedFlag", { unique: false });
        store.createIndex("endedAt", "endedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("packages")) {
        db.createObjectStore("packages", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("drafts")) {
        // 未完成的一节：每次作答后覆盖写入，仅用于刷新/关闭后恢复。
        const store = db.createObjectStore("drafts", { keyPath: "sessionId" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("logs")) {
        const store = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        store.createIndex("at", "at", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
  });
  return dbPromise;
}

function runTransaction(storeNames, mode, work) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("本地数据库操作被中止"));
    transaction.onerror = () => reject(transaction.error || new Error("本地数据库操作失败"));
    try {
      result = work(transaction);
    } catch (error) {
      try { transaction.abort(); } catch { /* 已经中止。 */ }
      reject(error);
    }
  }));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- meta ---------------- */

export async function getMeta(key, fallback = null) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : fallback);
    request.onerror = () => reject(request.error);
  });
}

export async function setMeta(key, value) {
  await runTransaction("meta", "readwrite", transaction => {
    transaction.objectStore("meta").put({ key, value });
  });
  return value;
}

export async function deleteMeta(key) {
  await runTransaction("meta", "readwrite", transaction => {
    transaction.objectStore("meta").delete(key);
  });
}

/* ---------------- sessions ---------------- */

export async function putSession(record, { finalizeDraft = false } = {}) {
  const row = { ...record, uploadedFlag: record.uploaded ? 1 : 0 };
  await runTransaction(finalizeDraft ? ["sessions", "drafts"] : "sessions", "readwrite", transaction => {
    // 同一 sessionId 只写一次：本地已有则保留原始记录，不覆盖。
    const store = transaction.objectStore("sessions");
    const existing = store.get(row.sessionId);
    existing.onsuccess = () => {
      if (!existing.result) store.put(row);
    };
    if (finalizeDraft) transaction.objectStore("drafts").delete(row.sessionId);
  });
  return row;
}

export async function getSession(sessionId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("sessions", "readonly").objectStore("sessions").get(sessionId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function listSessions({ pendingOnly = false } = {}) {
  const db = await openDatabase();
  const store = db.transaction("sessions", "readonly").objectStore("sessions");
  const request = pendingOnly ? store.index("uploadedFlag").getAll(IDBKeyRange.only(0)) : store.getAll();
  const rows = await requestToPromise(request);
  return rows.sort((left, right) => String(left.endedAt || "").localeCompare(String(right.endedAt || "")));
}

export async function markSessionsUploaded(sessionIds, uploadedAt) {
  if (!sessionIds.length) return 0;
  await runTransaction("sessions", "readwrite", transaction => {
    const store = transaction.objectStore("sessions");
    for (const sessionId of sessionIds) {
      const request = store.get(sessionId);
      request.onsuccess = () => {
        const row = request.result;
        if (!row) return;
        row.uploaded = true;
        row.uploadedFlag = 1;
        row.uploadedAt = uploadedAt;
        store.put(row);
      };
    }
  });
  return sessionIds.length;
}

export async function countSessions() {
  const db = await openDatabase();
  const rows = await requestToPromise(db.transaction("sessions", "readonly").objectStore("sessions").getAll());
  return {
    total: rows.length,
    pending: rows.filter(row => !row.uploadedFlag).length,
    uploaded: rows.filter(row => Boolean(row.uploadedFlag)).length,
    lastEndedAt: rows.map(row => row.endedAt).filter(Boolean).sort().at(-1) || null
  };
}

/* ---------------- 进行中的草稿 ---------------- */
// 与「不可变最终记录」分开存放：
//   sessions 表在 finishSession 写入一次，同一 sessionId 永不覆盖；
//   drafts 表在每次作答/提示/示范/暂停后覆盖写入，只用于恢复未完成的一节。
// 这样刷新/关闭页面不会丢已发生的作答，也不会污染最终记录。

export async function putDraft(draft) {
  await runTransaction("drafts", "readwrite", transaction => {
    transaction.objectStore("drafts").put({ ...draft, updatedAt: new Date().toISOString() });
  });
  return draft;
}

export async function getDraft(sessionId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").get(sessionId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteDraft(sessionId) {
  await runTransaction("drafts", "readwrite", transaction => {
    transaction.objectStore("drafts").delete(sessionId);
  });
}

export async function listDrafts() {
  const db = await openDatabase();
  const rows = await requestToPromise(db.transaction("drafts", "readonly").objectStore("drafts").getAll());
  return rows.sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")));
}

export async function latestDraft() {
  const rows = await listDrafts();
  return rows.at(-1) || null;
}

/* ---------------- packages ---------------- */

export async function putPackage(key, value) {
  await runTransaction("packages", "readwrite", transaction => {
    transaction.objectStore("packages").put({ key, ...value });
  });
  return value;
}

export async function getPackage(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("packages", "readonly").objectStore("packages").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- logs ---------------- */

export async function appendLog(entry) {
  const at = new Date().toISOString();
  await runTransaction("logs", "readwrite", transaction => {
    transaction.objectStore("logs").add({ at, ...entry });
  });
  return at;
}

export async function listLogs(limit = 30) {
  const db = await openDatabase();
  const rows = await requestToPromise(db.transaction("logs", "readonly").objectStore("logs").getAll());
  return rows.sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, limit);
}
