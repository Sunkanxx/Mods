// Pure confirmation logic: builds dialogs and interprets answers. No host calls.

export const HEADER = "Lesson";
const CANCEL = "Cancel promotion";
const TITLE_MAX = 40;

function other(scope) {
  return scope === "global" ? "project" : "global";
}

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

// Every question shows the detected body: what Save, Save as new or Note it is about (spec §7).
// A repeat names the target by its current title; ctx.target is the entry found now.
export function dialogFor(item, ctx) {
  const d = item.detection;
  const target = ctx.target;
  if (target && d.repeatKind === "lesson") {
    return {
      kind: "repeatLesson",
      question: `Looks like a repeat of ${target.id} "${target.title}" — ${d.body} Promote it to a rule?`,
      options: ["Promote to rule", "Save as new", "Skip"],
      header: HEADER,
    };
  }
  if (target && d.repeatKind === "rule") {
    return {
      kind: "repeatRule",
      question: `Rule ${target.id} "${target.title}" was broken again — ${d.body} Note it?`,
      options: ["Note it", "Skip"],
      header: HEADER,
    };
  }
  const options = ["Save"];
  if (ctx.projectAvailable) options.push(d.scope === "global" ? "Save to project" : "Save as global");
  options.push("Skip");
  return {
    kind: "new",
    question: `Lesson (${d.scope}): "${d.title}" — ${d.body} Save it?`,
    options,
    header: HEADER,
  };
}

export function interpret(answer, item, dialog) {
  const scope = item.detection.scope;
  const text = typeof answer === "string" ? answer : "";
  if (text === "Skip") return { type: "skip" };
  if (dialog.kind === "repeatRule") {
    if (text === "Note it") return { type: "note", id: item.detection.repeatOf };
  } else if (dialog.kind === "repeatLesson") {
    if (text === "Promote to rule") return { type: "promote", id: item.detection.repeatOf };
    if (text === "Save as new") return { type: "save", scope };
  } else {
    if (text === "Save") return { type: "save", scope };
    if (text === "Save as global" && dialog.options.includes(text)) return { type: "save", scope: "global" };
    if (text === "Save to project" && dialog.options.includes(text)) return { type: "save", scope: "project" };
  }
  if (text.trim() === "") return { type: "skip" };
  return { type: "save", scope, body: text };
}

export function onDismiss(item) {
  const dismissed = item.dismissed + 1;
  return { item: { ...item, dismissed }, toReview: dismissed >= 2 };
}

function candidateLabel(rule) {
  return `${rule.id} ${truncate(rule.title, TITLE_MAX)}`;
}

export function capDialog(scope, rules) {
  const sorted = [...rules].sort((a, b) => a.seen - b.seen || (a.last < b.last ? -1 : a.last > b.last ? 1 : 0));
  const picked = sorted.slice(0, 3);
  const name = scope === "global" ? "Global" : "Project";
  return {
    question: `${name} already has ${rules.length} rules. Which one goes back to lessons?`,
    options: [...picked.map(candidateLabel), CANCEL],
    candidates: picked.map((r) => r.id),
  };
}

export function interpretCap(answer, rules, candidates) {
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!text || text === CANCEL) return null;
  for (const id of candidates) {
    const rule = rules.find((r) => r.id === id);
    if (rule && candidateLabel(rule) === text) return id;
  }
  const typed = rules.find((r) => r.id.toLowerCase() === text.toLowerCase());
  return typed ? typed.id : null;
}

// An item tied to a repo (project scope, or a repeat of a P- entry) is offered only there.
export function offerable(item, repoRoot) {
  if (item.repoRoot != null) return repoRoot === item.repoRoot;
  return item.detection.scope === "global";
}
