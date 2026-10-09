// Pure recall helpers: text normalising, tag matching, block formatting, recent-path memory.

export const PATH_MEMORY = 20;
export const RECALL_LINE_MAX = 400;
export const RECALL_LEAD = "Lessons the user confirmed from earlier corrections — apply them where relevant:";
export const RULES_LEAD = "Rules the user confirmed — follow them for the rest of this session:";

// Control characters plus NEL, LS and PS (U+0085, U+2028, U+2029).
const LINE_BREAKS = new RegExp("[\u0000-\u001F\u007F\u0085" + String.fromCharCode(0x2028, 0x2029) + "]+", "g");
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
    // Dedupe on the normalised form so "slash-command" and "slash command" count once.
    for (const t of new Set((lesson.tags ?? []).map(normaliseText))) {
      if (t.trim() === "" || !text.includes(t)) continue;
      hits++;
      if (t.trim().includes(" ")) multiWord = true;
    }
    if (hits >= 2 || multiWord) scored.push({ lesson, hits });
  }
  // `last` is an ISO YYYY-MM-DD string, so string comparison orders it by date.
  scored.sort((a, b) => b.hits - a.hits || (a.lesson.last < b.lesson.last ? 1 : a.lesson.last > b.lesson.last ? -1 : 0));
  return scored.slice(0, o.max).map((s) => s.lesson);
}

/** Lead line, then one capped line per entry; "" when there are no entries. */
export function formatBlock(lead, entries) {
  if (entries.length === 0) return "";
  // The lead is a trusted constant; entry fields are user text, so each stays on one line.
  const oneLine = (s) => String(s).replace(LINE_BREAKS, " ");
  const lines = entries.map((e) => {
    const chars = [...`- ${oneLine(e.id)} ${oneLine(e.title)}: ${oneLine(e.body)}`];
    return chars.length > RECALL_LINE_MAX ? chars.slice(0, RECALL_LINE_MAX - 1).join("") + "…" : chars.join("");
  });
  return [lead, ...lines].join("\n");
}

/** Newest last, deduped, at most PATH_MEMORY. */
export function rememberPath(paths, path) {
  return [...paths.filter((p) => p !== path), path].slice(-PATH_MEMORY);
}
