// Deterministic, invented test progress. Never read the family's runtime data in CI.
import { readFileSync } from "node:fs";

export function syntheticState() {
  const pkg = JSON.parse(readFileSync(new URL("../app-mobile/public/course/course-package.json", import.meta.url), "utf8"));
  const items = {};
  for (const [subject, entries] of Object.entries(pkg.catalog)) {
    items[subject] = Object.fromEntries(entries.map((entry, index) => [entry.ref, {
      ...entry,
      value: entry.display,
      uppercase: subject === "english_letter" ? entry.optionDisplay : undefined,
      status: index % 3 === 0 ? "初见" : "未学",
      lastSeenAt: null,
      nextReviewAt: null,
      needsAssessment: index % 3 === 0,
      metrics: { contactSessionIds: [], independentCorrectSessionIds: [], questionTypes: [], incorrectCount: 0 }
    }]));
  }
  return { protocol: "FAMILY_LEARNING_STATE_V1", schemaVersion: 1, items, appliedSessionIds: [], appliedUpdateIds: [] };
}
