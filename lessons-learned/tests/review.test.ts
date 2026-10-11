import { test, expect } from "claude-code/testing";
import { serializeEntries, emptyFile, parseEntries, entriesOf } from "../hooks/lib/entries.mjs";
import { insertBlock } from "../hooks/lib/claude-md.mjs";
import { reviewQuestion } from "../hooks/lib/confirm.mjs";
import { world, type WorldOptions } from "./world";

// The session-start question about waiting items (spec §5.3, 0.2.0).

const DIR = "C:\\Users\\u\\.claude";
const G = { lessons: `${DIR}\\lessons-learned.md`, rules: `${DIR}\\rules-learned.md`, md: `${DIR}\\CLAUDE.md` };
const REPO = "C:\\r";
const R = { lessons: `${REPO}\\lessons-learned.md`, rules: `${REPO}\\rules-learned.md`, md: `${REPO}\\CLAUDE.md` };
const SETUP_QUESTION = "Set up lessons-learned for this project? It adds two files next to CLAUDE.md and one import line.";

const GLOBAL_FILES = {
  [G.lessons]: serializeEntries(emptyFile("lessons")), [G.rules]: serializeEntries(emptyFile("rules")), [G.md]: insertBlock(null, "rules-learned.md"),
};
const PROJECT_FILES = {
  [R.lessons]: serializeEntries(emptyFile("lessons")), [R.rules]: serializeEntries(emptyFile("rules")), [R.md]: insertBlock(null, "rules-learned.md"),
};
const setUp = (on: any, o: WorldOptions = {}) =>
  world(on, { files: { ...GLOBAL_FILES, ...PROJECT_FILES }, repo: { root: REPO }, ...o });

const item = (key: string, o: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => ({
  key, dismissed: 0, createdAt: "2026-10-10", repoRoot: null,
  detection: { mistake: "Ran it in Git Bash.", title: `Lesson ${key}`, body: "Why it matters.", tags: ["alpha", "beta"], scope: "global", repeatOf: null, repeatKind: null, ...d },
  ...o,
});
const elsewhere = item("x:1", { repoRoot: "C:\\other" }, { scope: "project" });

async function start($: any, seen: any) {
  await $.session.start({ cwd: REPO } as any);
  await seen.clock.advance(0);
}
const keys = (seen: any) => ((seen.store.get("queue") ?? []) as any[]).map((i) => i.key);
const titles = (seen: any, path: string) => entriesOf(parseEntries(seen.files.get(path))).map((e: any) => e.title);
const question = (n: number) => reviewQuestion(n).question;

test("reviewQuestion", () => {
  expect(reviewQuestion(2)).toEqual({
    question: "lessons-learned has 2 possible lessons from earlier corrections. Review them now?",
    options: ["Review now", "Later", "Discard all"],
    header: "Lesson",
  });
  expect(reviewQuestion(1).question).toBe("lessons-learned has 1 possible lesson from an earlier correction. Review it now?");
});

test("asks once at session start when items wait", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1"), item("a:2")] }, asks: ["Later"] });
  await start($, seen);
  expect(seen.asks).toEqual([{ question: question(2), options: ["Review now", "Later", "Discard all"] }]);
  expect(seen.headers).toEqual(["Lesson"]);
  expect(seen.store.get("offeredSession")).toBe("s1");
  expect(seen.statuses.at(-1)).toBe("lessons: 2 to review");
});

test("nothing waiting: no question", async ($: any, on: any) => {
  const seen = setUp(on);
  await start($, seen);
  expect(seen.asks).toEqual([]);
  expect(seen.store.has("offeredSession")).toBe(false);
  expect(seen.statuses.at(-1)).toBeUndefined();
});

test("Review now walks the items", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1"), item("a:2")] }, asks: ["Review now", "Save", "Skip"] });
  await start($, seen);
  expect(seen.asks).toHaveLength(3);
  expect(seen.asks[1].question.startsWith("You corrected: Ran it in Git Bash. — Lesson (global)")).toBe(true);
  expect(titles(seen, G.lessons)).toEqual(["Lesson a:1"]);
  expect(keys(seen)).toEqual([]);
  expect(seen.statuses.at(-1)).toBeUndefined();
});

test("a dismissal stops the walk", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1"), item("a:2")] }, asks: ["Review now", { reject: true }] });
  await start($, seen);
  expect(seen.asks).toHaveLength(2);
  expect((seen.store.get("queue") as any[]).map((i) => [i.key, i.dismissed])).toEqual([["a:1", 1], ["a:2", 0]]);
  expect(seen.statuses.at(-1)).toBe("lessons: 2 to review");
});

test("Review now also offers items dismissed twice", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1", { dismissed: 2 })] }, asks: ["Review now", "Save"] });
  await start($, seen);
  expect(titles(seen, G.lessons)).toEqual(["Lesson a:1"]);
});

test("Later keeps them", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1")] }, asks: ["Later"] });
  await start($, seen);
  expect(keys(seen)).toEqual(["a:1"]);
  expect(seen.store.get("offeredSession")).toBe("s1");
  expect(seen.writes.filter((w) => w.path === G.lessons)).toEqual([]);
});

test("a dismissed question keeps them", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1")] } });
  await start($, seen);
  expect(seen.asks).toHaveLength(1);
  expect(keys(seen)).toEqual(["a:1"]);
  expect((seen.store.get("queue") as any[])[0].dismissed).toBe(0);
  expect(seen.store.get("offeredSession")).toBe("s1");
});

test("Discard all leaves another repo's items", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1"), elsewhere] }, asks: ["Discard all"] });
  await start($, seen);
  expect(seen.asks[0].question).toBe(question(1));
  expect(keys(seen)).toEqual(["x:1"]);
  expect(seen.writes).toEqual([]);
  expect(seen.statuses.at(-1)).toBeUndefined();
});

test("reload in the same session does not ask again", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1")], offeredSession: "s1" }, asks: ["Later"] });
  await start($, seen);
  expect(seen.asks).toEqual([]);
  expect(seen.statuses.at(-1)).toBe("lessons: 1 to review");
});

test("a new session asks again", async ($: any, on: any) => {
  const seen = setUp(on, { sessionId: "s2", store: { queue: [item("a:1")], offeredSession: "s1" }, asks: ["Later"] });
  await start($, seen);
  expect(seen.asks).toHaveLength(1);
  expect(seen.store.get("offeredSession")).toBe("s2");
});

for (const askAt of ["never", "turn end"]) {
  test(`askAt ${askAt}: no session-start question`, { options: { askAt } } as any, async ($: any, on: any) => {
    const seen = setUp(on, { store: { queue: [item("a:1")] }, asks: ["Later"] });
    await start($, seen);
    expect(seen.asks).toEqual([]);
    expect(seen.statuses.at(-1)).toBe("lessons: 1 to review");
  });
}

test("no surfaces: no question, nothing recorded", async ($: any, on: any) => {
  const seen = setUp(on, { surfaces: [], store: { queue: [item("a:1")] }, asks: ["Later"] });
  await start($, seen);
  expect(seen.asks).toEqual([]);
  expect(seen.store.has("offeredSession")).toBe(false);
});

test("only another repo's items: no question", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [elsewhere] }, asks: ["Later"] });
  await start($, seen);
  expect(seen.asks).toEqual([]);
  expect(seen.statuses.at(-1)).toBeUndefined();
});

test("setup question first, review question after it", async ($: any, on: any) => {
  const seen = setUp(on, { files: GLOBAL_FILES, store: { queue: [item("a:1")] }, asks: ["Not here", "Later"] });
  await start($, seen);
  expect(seen.asks.map((a) => a.question)).toEqual([SETUP_QUESTION, question(1)]);
});

test("a dialog already open: the question is not asked and not recorded", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [item("a:1")] }, asks: [{ answer: "Skip", delay: 1000 }] });
  const reviewing = $.command.run({ command: "lessons", args: "review" } as any);
  await seen.clock.advance(0);
  await start($, seen);
  expect(seen.asks).toHaveLength(1);
  expect(seen.store.has("offeredSession")).toBe(false);
  await seen.clock.advance(1000);
  await reviewing;
});

test("0.1.x review items move into the queue", async ($: any, on: any) => {
  const seen = setUp(on, { store: { review: [item("old:1", { dismissed: 2 })], queue: [item("a:1")] }, asks: ["Later"] });
  await start($, seen);
  expect(keys(seen)).toEqual(["a:1", "old:1"]);
  expect(seen.store.has("review")).toBe(false);
  expect(seen.asks[0].question).toBe(question(2));
});

test("the migration keeps the newest 10", async ($: any, on: any) => {
  const queue = Array.from({ length: 9 }, (_, i) => item(`q${i + 1}`));
  const seen = setUp(on, { store: { review: [item("r1"), item("r2")], queue }, asks: ["Later"] });
  await start($, seen);
  expect(keys(seen)).toEqual([...queue.slice(1).map((i) => i.key), "r1", "r2"]);
});

test("an item queued by 0.1.x has no mistake line", async ($: any, on: any) => {
  const old = item("a:1", {}, { mistake: undefined });
  const seen = setUp(on, { store: { queue: [old] }, asks: ["Review now", "Skip"] });
  await start($, seen);
  expect(seen.asks[1].question.startsWith('Lesson (global): "Lesson a:1"')).toBe(true);
});
