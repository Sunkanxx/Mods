// Pure recall helpers: text normalising, tag matching, block formatting, recent-path memory.

export const PATH_MEMORY = 20;
export const RECALL_LINE_MAX = 400;
export const RECALL_LEAD = "Lessons the user confirmed from earlier corrections — apply them where relevant:";
export const RULES_LEAD = "Rules the user confirmed — follow them for the rest of this session:";

const PUNCTUATION = /[-_/\\.:,;()[\]{}"'`]/g;

/** Lowercase, punctuation to spaces, whitespace collapsed, one space at each end. */
export function normaliseText(s) {
  const words = String(s).toLowerCase().replace(PUNCTUATION, " ").split(/\s+/).filter(Boolean);
  return ` ${words.join(" ")} `.replace(/^ {2,}$/, " ");
}

/**
 * Lessons whose tags show up in the haystack: two tag hits, or one multi-word tag hit.
 * Ranked by hits, then most recent `last`; capped at o.max; o.exclude ids are skipped.
 */
export function matchLessons(lessons, haystack, o) {
  const text = normaliseText(haystack);
  const scored = [];
  for (const lesson of lessons) {
    if (o.exclude.has(lesson.id)) continue;
    let hits = 0;
    let multiWord = false;
    for (const tag of lesson.tags ?? []) {
      const t = normaliseText(tag);
      if (t.trim() === "" || !text.includes(t)) continue;
      hits++;
      if (t.trim().includes(" ")) multiWord = true;
    }
    if (hits >= 2 || multiWord) scored.push({ lesson, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || (a.lesson.last < b.lesson.last ? 1 : a.lesson.last > b.lesson.last ? -1 : 0));
  return scored.slice(0, o.max).map((s) => s.lesson);
}

/** Lead line, then one capped line per entry; "" when there are no entries. */
export function formatBlock(lead, entries) {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const chars = [...`- ${e.id} ${e.title}: ${e.body}`];
    return chars.length > RECALL_LINE_MAX ? chars.slice(0, RECALL_LINE_MAX - 1).join("") + "…" : chars.join("");
  });
  return [lead, ...lines].join("\n");
}

/** Newest last, deduped, at most PATH_MEMORY. */
export function rememberPath(paths, path) {
  return [...paths.filter((p) => p !== path), path].slice(-PATH_MEMORY);
}
