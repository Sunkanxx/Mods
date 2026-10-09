import { test, expect } from "claude-code/testing";
import { dialogFor, interpret, onDismiss, capDialog, interpretCap, offerable } from "../hooks/lib/confirm.mjs";

const det = (o = {}) => ({ title: "Use PowerShell", body: "b", tags: ["a", "b"], scope: "project", repeatOf: null, repeatKind: null, ...o });
const item = (o = {}, d = {}) => ({ key: "k", detection: det(d), repoRoot: "/r", dismissed: 0, createdAt: "2026-10-01", ...o });
const entry = (id, title, o = {}) => ({ id, title, tags: [], seen: 1, first: "2026-01-01", last: "2026-01-01", body: "x", ...o });
const ctx = { projectAvailable: true, target: null };

test("new lesson dialog", () => {
  const d = dialogFor(item(), ctx);
  expect(d).toEqual({ kind: "new", question: 'Lesson: "Use PowerShell" (project). Save it?', options: ["Save", "Save as global", "Skip"], header: "Lesson" });
  expect(dialogFor(item({}, { scope: "global" }), ctx).options).toEqual(["Save", "Save to project", "Skip"]);
  expect(dialogFor(item(), { ...ctx, projectAvailable: false }).options).toEqual(["Save", "Skip"]);
});

test("repeat of a lesson", () => {
  const it = item({}, { repeatOf: "P-012", repeatKind: "lesson" });
  const d = dialogFor(it, { ...ctx, target: entry("P-012", "Use PowerShell") });
  expect(d.kind).toBe("repeatLesson");
  expect(d.question).toBe('Looks like a repeat of P-012 "Use PowerShell". Promote it to a rule?');
  expect(d.options).toEqual(["Promote to rule", "Save as new", "Skip"]);
  expect(dialogFor(it, ctx).kind).toBe("new");
});

test("repeat of a rule", () => {
  const it = item({}, { repeatOf: "P-003", repeatKind: "rule" });
  const d = dialogFor(it, { ...ctx, target: entry("P-003", "X") });
  expect(d.kind).toBe("repeatRule");
  expect(d.question).toBe('Rule P-003 "X" was broken again. Note it?');
  expect(d.options).toEqual(["Note it", "Skip"]);
});

test("interpret", () => {
  const it = item();
  const nd = dialogFor(it, ctx);
  expect(interpret("Save", it, nd)).toEqual({ type: "save", scope: "project" });
  expect(interpret("Save as global", it, nd)).toEqual({ type: "save", scope: "global" });
  const gi = item({}, { scope: "global" });
  expect(interpret("Save to project", gi, dialogFor(gi, ctx))).toEqual({ type: "save", scope: "project" });
  expect(interpret("Skip", it, nd)).toEqual({ type: "skip" });
  expect(interpret("my text", it, nd)).toEqual({ type: "save", scope: "project", body: "my text" });
  expect(interpret("  \n ", it, nd)).toEqual({ type: "skip" });
  expect(interpret("save", it, nd)).toEqual({ type: "save", scope: "project", body: "save" });

  const rl = item({}, { repeatOf: "P-012", repeatKind: "lesson" });
  const rd = dialogFor(rl, { ...ctx, target: entry("P-012", "T") });
  expect(interpret("Promote to rule", rl, rd)).toEqual({ type: "promote", id: "P-012" });
  expect(interpret("Save as new", rl, rd)).toEqual({ type: "save", scope: "project" });
  expect(interpret("words", rl, rd)).toEqual({ type: "save", scope: "project", body: "words" });

  const ru = item({}, { repeatOf: "P-003", repeatKind: "rule" });
  const ud = dialogFor(ru, { ...ctx, target: entry("P-003", "X") });
  expect(interpret("Note it", ru, ud)).toEqual({ type: "note", id: "P-003" });
  expect(interpret("other", ru, ud)).toEqual({ type: "save", scope: "project", body: "other" });
  expect(interpret("Skip", ru, ud)).toEqual({ type: "skip" });
});

test("onDismiss", () => {
  const it = item();
  const a = onDismiss(it);
  expect(a.item.dismissed).toBe(1);
  expect(a.toReview).toBe(false);
  expect(it.dismissed).toBe(0);
  expect(onDismiss(a.item).toReview).toBe(true);
});

test("capDialog and interpretCap", () => {
  const rules = Array.from({ length: 20 }, (_, i) =>
    entry(`P-${String(i + 1).padStart(3, "0")}`, `Rule ${i + 1}`, { seen: 5 + i, last: `2026-02-${String(10 + (i % 10)).padStart(2, "0")}` }));
  rules[3] = entry("P-004", "x".repeat(50), { seen: 1, last: "2026-01-05" });
  rules[8] = entry("P-009", "Nine", { seen: 1, last: "2026-01-01" });
  rules[5] = entry("P-006", "Six", { seen: 1, last: "2026-01-09" });
  const c = capDialog("project", rules);
  expect(c.question).toBe("Project already has 20 rules. Which one goes back to lessons?");
  expect(c.candidates).toEqual(["P-009", "P-004", "P-006"]);
  expect(c.options).toEqual(["P-009 Nine", "P-004 " + "x".repeat(40) + "…", "P-006 Six", "Cancel promotion"]);
  expect(capDialog("global", rules).question.startsWith("Global ")).toBe(true);
  expect(interpretCap(c.options[1], rules, c.candidates)).toBe("P-004");
  expect(interpretCap("p-009", rules, c.candidates)).toBe("P-009");
  expect(interpretCap("P-099", rules, c.candidates)).toBeNull();
  expect(interpretCap("Cancel promotion", rules, c.candidates)).toBeNull();
  expect(interpretCap("whatever", rules, c.candidates)).toBeNull();
});

test("offerable", () => {
  expect(offerable(item({}, { scope: "global" }), null)).toBe(true);
  expect(offerable(item(), "/r")).toBe(true);
  expect(offerable(item(), "/other")).toBe(false);
  expect(offerable(item(), null)).toBe(false);
});

test("promote and note take the id from the item, not the question", () => {
  const rl = item({}, { repeatOf: "P-012", repeatKind: "lesson" });
  const rd = { kind: "repeatLesson", question: "no id here", options: ["Promote to rule", "Save as new", "Skip"], header: "Lesson" };
  expect(interpret("Promote to rule", rl, rd)).toEqual({ type: "promote", id: "P-012" });
  const ru = item({}, { repeatOf: "P-003", repeatKind: "rule" });
  const ud = { kind: "repeatRule", question: "something else", options: ["Note it", "Skip"], header: "Lesson" };
  expect(interpret("Note it", ru, ud)).toEqual({ type: "note", id: "P-003" });
});

test("scope labels count only when offered", () => {
  const it = item();
  const d = dialogFor(it, { ...ctx, projectAvailable: false });
  expect(interpret("Save to project", it, d)).toEqual({ type: "save", scope: "project", body: "Save to project" });
  expect(interpret("Save as global", it, d)).toEqual({ type: "save", scope: "project", body: "Save as global" });
});

test("a label of another dialog kind is Other text", () => {
  const it = item();
  expect(interpret("Promote to rule", it, dialogFor(it, ctx))).toEqual({ type: "save", scope: "project", body: "Promote to rule" });
  const ru = item({}, { repeatOf: "P-003", repeatKind: "rule" });
  const ud = dialogFor(ru, { ...ctx, target: entry("P-003", "X") });
  expect(interpret("Save", ru, ud)).toEqual({ type: "save", scope: "project", body: "Save" });
});
