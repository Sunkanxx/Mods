import { test, expect } from "claude-code/testing";
import { serializeEntries, emptyFile, addEntry } from "../hooks/lib/entries.mjs";
import { insertBlock } from "../hooks/lib/claude-md.mjs";
import { formatBlock, RECALL_LEAD, RULES_LEAD } from "../hooks/lib/recall.mjs";
// The loaded plugin is its own module instance; paused is set on this file's instance, which
// recallContext (called directly, over the stand-in $) shares.
import { setPaused, recallContext } from "../hooks/lessons-learned.mjs";
import { world, type WorldOptions } from "./world";

const DIR = "C:\\Users\\u\\.claude";
const G = { lessons: `${DIR}\\lessons-learned.md`, rules: `${DIR}\\rules-learned.md`, md: `${DIR}\\CLAUDE.md` };
const REPO = "C:\\r";
const R = { lessons: `${REPO}\\lessons-learned.md`, rules: `${REPO}\\rules-learned.md`, md: `${REPO}\\CLAUDE.md` };

const entry = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, tags: ["powershell", "quoting"], seen: 1, first: "2026-10-01", last: "2026-10-01", body: "Body.", ...o,
});
const fileOf = (kind: "lessons" | "rules", list: any[] = []) =>
  serializeEntries(list.reduce((f: any, e: any) => addEntry(f, e), emptyFile(kind)));
const filesWith = (o: { gl?: any[]; pl?: any[]; pr?: any[] } = {}) => ({
  [G.lessons]: fileOf("lessons", o.gl), [G.rules]: fileOf("rules"), [G.md]: insertBlock(null, "rules-learned.md"),
  [R.lessons]: fileOf("lessons", o.pl), [R.rules]: fileOf("rules", o.pr), [R.md]: insertBlock(null, "rules-learned.md"),
});

const LESSON = entry("G-001", "Quote carefully");
const setUp = (on: any, o: WorldOptions = {}) =>
  world(on, { files: filesWith({ gl: [LESSON] }), repo: { root: REPO }, allowTools: ["Read", "Edit", "Write", "Bash", "Grep"], ...o });
const submit = ($: any, text: string, context?: string[]) =>
  $.prompt.submit({ text, origin: { kind: "composer" }, wait: false, context });
const block = (...entries: any[]) => formatBlock(RECALL_LEAD, entries);

test("attaches matching lessons", async ($: any, on: any) => {
  setUp(on);
  const out = await submit($, "fix the powershell quoting", ["earlier"]);
  expect(out.context).toEqual(["earlier", block(LESSON)]);
});

test("no match adds no context", async ($: any, on: any) => {
  setUp(on);
  const out = await submit($, "hello there");
  expect(out.context).toBeUndefined();
});

test("uses touched paths", async ($: any, on: any) => {
  const lesson = entry("G-002", "Signing", { tags: ["sign module", "signing"] });
  setUp(on, { files: filesWith({ gl: [lesson] }) });
  await $.tool.call({ tool: "Edit", file_path: "C:\\r\\tools\\sign_module.py" });
  const out = await submit($, "go on");
  expect(out.context).toEqual([block(lesson)]);
});

test("at most maxRecall", { options: { maxRecall: 2 } } as any, async ($: any, on: any) => {
  const gl = ["G-001", "G-002", "G-003"].map((id) => entry(id, id));
  setUp(on, { files: filesWith({ gl }) });
  const out = await submit($, "powershell quoting");
  expect(out.context).toHaveLength(1);
  expect(out.context[0].split("\n")).toHaveLength(1 + 2);
});

test("no repeat within a session", async ($: any, on: any) => {
  setUp(on);
  expect((await submit($, "powershell quoting")).context).toHaveLength(1);
  expect((await submit($, "powershell quoting")).context).toBeUndefined();
});

test("new session id resets", async ($: any, on: any) => {
  const opts: WorldOptions = { files: filesWith({ gl: [LESSON] }), repo: { root: REPO }, sessionId: "s1" };
  world(on, opts);
  expect((await submit($, "powershell quoting")).context).toHaveLength(1);
  opts.sessionId = "s2";
  expect((await submit($, "powershell quoting")).context).toHaveLength(1);
});

const TRANSCRIPT = [{ role: "user", text: "fix the quoting", toolUses: [] }, { role: "assistant", text: "Done.", toolUses: [] }];
const SUMMARY = [{ role: "user", text: "summary", toolUses: [] }];

test("session.compact resets", async ($: any, on: any) => {
  setUp(on);
  on("session.compact", () => ({ messages: SUMMARY }));
  expect((await submit($, "powershell quoting")).context).toHaveLength(1);
  await $.session.compact({ trigger: "manual", messages: TRANSCRIPT, instructions: "keep going" });
  expect((await submit($, "powershell quoting")).context).toHaveLength(1);
});

const NO_RESET: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["a vetoed compaction", { trigger: "manual", messages: TRANSCRIPT }, { skip: "not now" }],
  ["a precompute", { trigger: "precompute", messages: TRANSCRIPT }, { messages: SUMMARY }],
  ["a subagent's compaction", { trigger: "auto", agentId: "agent-1", messages: TRANSCRIPT }, { messages: SUMMARY }],
];
for (const [name, input, result] of NO_RESET) {
  test(`${name} does not reset recall`, async ($: any, on: any) => {
    setUp(on);
    on("session.compact", () => result);
    expect((await submit($, "powershell quoting")).context).toHaveLength(1);
    expect(await $.session.compact(input)).toEqual(result);
    expect((await submit($, "powershell quoting")).context).toBeUndefined();
  });
}

test("attaches promoted rules once", async ($: any, on: any) => {
  const lesson = entry("P-004", "Use PowerShell", { tags: ["alpha", "beta"] });
  const seen = setUp(on, {
    files: filesWith({ pl: [lesson] }),
    messages: [{ role: "assistant", text: "Ran it in Git Bash.", toolUses: [] }],
    model: [JSON.stringify({ correction: true, title: "Use PowerShell", body: "Body.", tags: ["alpha", "beta"], scope: "project", repeatOf: "P-004" })],
    asks: ["Promote to rule"],
  });
  await submit($, "no, use PowerShell");
  await seen.clock.settle();
  await $.turn.complete({ answer: "Done.", reason: "answer", durationMs: 1, isAborted: false, turnId: "t" });
  await seen.clock.advance(0);
  const next = await submit($, "go on");
  expect(next.context).toHaveLength(1);
  expect(next.context[0].startsWith(`${RULES_LEAD}
- P-004 Use PowerShell`)).toBe(true);
  expect((await submit($, "go on")).context).toBeUndefined();
});

test("recall runs without surfaces", async ($: any, on: any) => {
  setUp(on, { surfaces: [] });
  expect((await submit($, "powershell quoting")).context).toEqual([block(LESSON)]);
});

test("recall runs while paused", async ($: any, on: any) => {
  const seen = setUp(on);
  setPaused(true);
  try {
    expect(await recallContext(seen.$, { text: "powershell quoting" })).toEqual([block(LESSON)]);
  } finally {
    setPaused(false);
  }
});

test("no lessons files: no context, no error", async ($: any, on: any) => {
  const seen = setUp(on, { files: {} });
  const out = await submit($, "powershell quoting");
  expect(out.text).toBe("powershell quoting");
  expect(out.context).toBeUndefined();
  expect(seen.logs.every((l) => l.to === "debug")).toBe(true);
});

test("tracker ignores other tools and non-path inputs", async ($: any, on: any) => {
  const lesson = entry("G-002", "Signing", { tags: ["sign module", "signing"] });
  setUp(on, { files: filesWith({ gl: [lesson] }) });
  await $.tool.call({ tool: "Bash", command: "python sign_module.py", file_path: "sign_module.py" });
  await $.tool.call({ tool: "Read", file_path: 42 });
  expect((await submit($, "go on")).context).toBeUndefined();
  await $.tool.call({ tool: "Grep", path: "C:\\r\\sign_module.py" });
  expect((await submit($, "go on")).context).toEqual([block(lesson)]);
});

test("tracker records notebook_path", async ($: any, on: any) => {
  const lesson = entry("G-002", "Signing", { tags: ["sign module", "signing"] });
  setUp(on, { files: filesWith({ gl: [lesson] }), allowTools: ["NotebookEdit"] });
  await $.tool.call({ tool: "NotebookEdit", notebook_path: "C:\\r\\sign_module.ipynb" });
  expect((await submit($, "go on")).context).toEqual([block(lesson)]);
});
