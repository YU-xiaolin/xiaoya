// 学习记录分析：只读原始事件，不推断软件尚未确认的状态。
// 与 Windows 端保持一致的原则——「展示过」不等于「已经会」，
// 提示后答对不算独立正确。
export function analyzeSessions(sessions) {
  const byTarget = new Map();
  const timeline = [];
  const subjects = new Set();

  const sorted = [...sessions].sort((left, right) => {
    const leftAt = left.endedAt || left.ended_at || left.startedAt || left.started_at || "";
    const rightAt = right.endedAt || right.ended_at || right.startedAt || right.started_at || "";
    return String(leftAt).localeCompare(String(rightAt));
  });

  for (const session of sorted) {
    const payload = session.payload || session;
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const endedAt = payload?.endedAt || session.ended_at || payload?.startedAt || session.started_at || null;
    let correct = 0;
    let incorrect = 0;
    let hintUsed = 0;
    for (const event of events) {
      const entry = byTarget.get(event.targetRef) || {
        targetRef: event.targetRef,
        subject: event.subject,
        display: event.targetDisplay,
        attempts: 0,
        correct: 0,
        incorrect: 0,
        independentCorrect: 0,
        hintShown: 0,
        demonstrated: 0,
        // 只有「独立答对」才算有效场次证据；错误、提示、示范都不计入。
        independentSessionIds: new Set(),
        evidenceTypes: new Set(),
        lastSeenAt: null
      };
      entry.attempts += 1;
      if (event.result === "correct") {
        entry.correct += 1;
        if (event.independent) {
          entry.independentCorrect += 1;
          entry.independentSessionIds.add(payload.sessionId);
        }
        correct += 1;
      } else if (event.result === "incorrect") {
        entry.incorrect += 1;
        incorrect += 1;
      } else if (event.result === "hint_shown") {
        entry.hintShown += 1;
        hintUsed += 1;
      } else if (event.result === "demonstrated") {
        entry.demonstrated += 1;
      }
      // 证据模式同样只在独立答对时计入，避免用提示/错误凑满两种模式。
      if (event.evidenceType && event.result === "correct" && event.independent) {
        entry.evidenceTypes.add(event.evidenceType);
      }
      entry.lastSeenAt = event.recordedAt || entry.lastSeenAt;
      byTarget.set(event.targetRef, entry);
      subjects.add(event.subject);
    }
    timeline.push({
      sessionId: payload.sessionId,
      endedAt,
      activityMode: payload.activityMode || null,
      lessonId: payload.lessonId || null,
      completed: Boolean(payload.completed),
      stopReason: payload.stopReason || null,
      eventCount: events.length,
      correct,
      incorrect,
      hintUsed,
      accuracy: correct + incorrect ? Math.round(correct / (correct + incorrect) * 100) : null
    });
  }

  const targets = [...byTarget.values()].map(entry => ({
    ...entry,
    independentSessionIds: [...entry.independentSessionIds],
    evidenceTypes: [...entry.evidenceTypes],
    sessionCount: entry.independentSessionIds.size,
    // 与 Windows 端的稳定掌握判据一致：≥3 个不同场次**独立答对**，且覆盖 ≥2 种证据模式。
    // 错误、提示后答对、示范都不能补足场次数或证据类型。
    stableByRule: entry.independentSessionIds.size >= 3 && entry.evidenceTypes.size >= 2 && entry.independentCorrect >= 3
  }));

  return {
    sessionCount: sorted.length,
    subjects: [...subjects],
    targets,
    timeline,
    totals: {
      events: timeline.reduce((sum, item) => sum + item.eventCount, 0),
      correct: timeline.reduce((sum, item) => sum + item.correct, 0),
      incorrect: timeline.reduce((sum, item) => sum + item.incorrect, 0),
      hintUsed: timeline.reduce((sum, item) => sum + item.hintUsed, 0)
    }
  };
}

// 由本机真实作答证据推导状态。公开课程包只包含课程定义（不携带家庭学习进度），
// 所以小测试的范围筛选、难度分档所需的 status / lastSeenAt 必须在本机推导。
// 判据与 Windows 端门禁一致：提示后答对不算独立正确；稳定掌握需要 ≥3 个不同场次的
// 独立答对，并覆盖 ≥2 种有效证据模式。
export function statusFromObserved(observed) {
  if (!observed) return "未学";
  if (observed.stableByRule) return "稳定掌握";
  if (observed.independentCorrect >= 1) return "学习中";
  if (observed.incorrect > 0) return "薄弱";
  return "初见";
}

export function mergeCatalogProgress(catalog, analysis) {
  const map = new Map(analysis.targets.map(target => [target.targetRef, target]));
  const decorate = subject => (catalog?.[subject] || []).map(item => {
    const stats = map.get(item.ref);
    const observed = stats
      ? {
        attempts: stats.attempts,
        incorrect: stats.incorrect,
        independentCorrect: stats.independentCorrect,
        sessionCount: stats.sessionCount,
        lastSeenAt: stats.lastSeenAt,
        stableByRule: stats.stableByRule
      }
      : null;
    return {
      ...item,
      // 课程包自带的状态优先（Windows 快照仍会带状态）；没有时才由本机证据推导。
      status: item.status ?? statusFromObserved(observed),
      lastSeenAt: item.lastSeenAt ?? observed?.lastSeenAt ?? null,
      observed
    };
  });
  return {
    hanzi: decorate("hanzi"),
    english_letter: decorate("english_letter"),
    math: decorate("math")
  };
}

// 错题与复习优先级：错误次数优先，其次接触少、久未复习。
// 只依据本机真实作答记录（analysis），不依赖公开课程包里的家庭进度字段。
export function reviewPriorities(catalog, analysis = null) {
  const observedMap = new Map((analysis?.targets || []).map(target => [target.targetRef, target]));
  const items = [];
  for (const subject of ["hanzi", "english_letter", "math"]) {
    for (const item of catalog?.[subject] || []) {
      const observed = item.observed || observedMap.get(item.ref) || null;
      const incorrect = observed?.incorrect || 0;
      if (incorrect <= 0) continue;
      items.push({
        subject,
        ref: item.ref,
        display: item.display,
        incorrect,
        lastSeenAt: observed?.lastSeenAt || null
      });
    }
  }
  return items.sort((left, right) =>
    right.incorrect - left.incorrect
    || String(left.lastSeenAt || "").localeCompare(String(right.lastSeenAt || "")))
    .slice(0, 60);
}

// 学习趋势：按天聚合本节数、作答数与正确率。
export function dailyTrend(analysis, days = 14) {
  const buckets = new Map();
  for (const item of analysis.timeline) {
    const day = String(item.endedAt || "").slice(0, 10);
    if (!day) continue;
    const bucket = buckets.get(day) || { day, sessions: 0, events: 0, correct: 0, incorrect: 0 };
    bucket.sessions += 1;
    bucket.events += item.eventCount;
    bucket.correct += item.correct;
    bucket.incorrect += item.incorrect;
    buckets.set(day, bucket);
  }
  const ordered = [...buckets.values()].sort((left, right) => left.day.localeCompare(right.day));
  return ordered.slice(-days).map(bucket => ({
    ...bucket,
    accuracy: bucket.correct + bucket.incorrect
      ? Math.round(bucket.correct / (bucket.correct + bucket.incorrect) * 100)
      : null
  }));
}
