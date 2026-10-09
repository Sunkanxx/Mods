import { test, expect } from "claude-code/testing";
import { parseEntries, serializeEntries, emptyFile, addEntry, entriesOf, cleanBody } from "../hooks/lib/entries.mjs";
import { insertBlock } from "../hooks/lib/claude-md.mjs";
import { DETECTOR_SYSTEM, buildDetectorPrompt } from "../hooks/lib/detector.mjs";
import { capDialog } from "../hooks/lib/confirm.mjs";
// The loaded plugin is its own module instance: module state (paused, promotedThisSession) is
// checked by calling this file's instance directly, over the stand-in `seen.$`.
import { setPaused, promotedThisSession, startCapture, promote } from "../hooks/lessons-learned.mjs";
import { world, type WorldOptions } from "./world";

const HOME = "C:\\Users\\u";
const DIR = `${HOME}\\.claude`;
const G = { lessons: `${DIR}\\lessons-learned.md`, rules: `${DIR}\\rules-learned.md`, md: `${DIR}\\CLAUDE.md` };
const REPO = "C:\\r";
const R = { lessons: `${REPO}\\lessons-learned.md`, rules: `${REPO}\\rules-learned.md`, md: `${REPO}\\CLAUDE.md` };
const TODAY = "2026-10-09";

const entry = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, tags: ["powershell", "quoting"], seen: 1, first: "2026-10-01", last: "2026-10-01", body: "Body.", ...o,
});
const fileOf = (kind: "lessons" | "rules", list: any[] = []) =>
  serializeEntries(list.reduce((f: any, e: any) => addEntry(f, e), emptyFile(kind)));
const entriesIn = (seen: any, path: string) => entriesOf(parseEntries(seen.files.get(path)!));

// Global and project scopes both set up, with the given entries.
const filesWith = (o: { gl?: any[]; gr?: any[]; pl?: any[]; pr?: any[] } = {}) => ({
  [G.lessons]: fileOf("lessons", o.gl), [G.rules]: fileOf("rules", o.gr), [G.md]: insertBlock(null, "rules-learned.md"),
  [R.lessons]: fileOf("lessons", o.pl), [R.rules]: fileOf("rules", o.pr), [R.md]: insertBlock(null, "rules-learned.md"),
});

const REPLY = "I ran the command in Git Bash.";
const MESSAGES = [
  { role: "user", text: "run /deploy", toolUses: [] },
  { role: "assistant", text: REPLY, toolUses: [] },
  { role: "assistant", text: "", toolUses: [] },
];
const PROMPT = "no, use PowerShell for slash commands";
const TITLE = "Use PowerShell for slash commands";
const BODY = "Git Bash rewrites /cmd into a path.";
const TAGS = ["powershell", "slash commands"];
const detected = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ correction: true, title: TITLE, body: BODY, tags: TAGS, scope: "project", repeatOf: null, ...o });

const setUp = (on: any, o: WorldOptions = {}) =>
  world(on, { files: filesWith(), repo: { root: REPO }, messages: MESSAGES, ...o });

const submit = ($: any, text = PROMPT, origin = "composer") =>
  $.prompt.submit({ text, origin: { kind: origin }, wait: false });

async function turnEnd($: any, seen: any, reason = "answer", extra: Record<string, unknown> = {}) {
  await $.turn.complete({ answer: "Done.", reason, durationMs: 1, isAborted: reason === "aborted", turnId: "t", ...extra });
  await seen.clock.advance(0);
}

// A prompt that is a correction, then its turn ending with an answer.
async function turn($: any, seen: any, text = PROMPT) {
  await submit($, text);
  await seen.clock.settle();
  await turnEnd($, seen);
}

const queued = (key: string, o: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => ({
  key,
  detection: { title: `Lesson ${key}`, body: "Why it matters.", tags: ["alpha", "beta"], scope: "global", repeatOf: null, repeatKind: null, ...d },
  repoRoot: null, dismissed: 0, createdAt: "2026-10-01", ...o,
});

const NEW_QUESTION = `Lesson: "${TITLE}" (project). Save it?`;
const debugOnly = (seen: any) => seen.logs.every((l: any) => l.to === "debug");

// ---------- capture ----------

const SKIPS: { name: string; text?: string; origin?: string; o?: WorldOptions }[] = [
  { name: "slash command", text: "/help" },
  { name: "no previous reply", o: { messages: [{ role: "user", text: "hi", toolUses: [] }, { role: "assistant", text: "", toolUses: [] }] } },
  { name: "no surfaces", o: { surfaces: [] } },
  { name: "not typed by the user", origin: "task-notification" },
];
for (const c of SKIPS) {
  test(`skips without a model call: ${c.name}`, async ($: any, on: any) => {
    const seen = setUp(on, { ...c.o, model: [] });
    await submit($, c.text, c.origin);
    await seen.clock.settle();
    await turnEnd($, seen);
    expect(seen.modelCalls).toEqual([]);
    expect(seen.asks).toEqual([]);
    expect(seen.logs).toEqual([]);
  });
}

test("skips without a model call: paused", async ($: any, on: any) => {
  const seen = setUp(on, { model: [] });
  const e = { text: PROMPT, origin: { kind: "composer" }, wait: false };
  setPaused(true);
  try {
    await startCapture(seen.$, e);
  } finally {
    setPaused(false);
  }
  await seen.clock.settle();
  expect(seen.modelCalls).toEqual([]);
  seen.queueModel('{"correction": false}');
  await startCapture(seen.$, e);
  await seen.clock.settle();
  expect(seen.modelCalls).toHaveLength(1);
});

test("a failing host call still lets the prompt enter", async ($: any, on: any) => {
  const seen = setUp(on, { messages: () => { throw new Error("transcript unavailable"); }, model: [] });
  const entered = await submit($);
  expect(entered.text).toBe(PROMPT);
  await seen.clock.settle();
  expect(seen.modelCalls).toEqual([]);
  expect(seen.logs.length).toBeGreaterThan(0);
  expect(debugOnly(seen)).toBe(true);
});

test("does not delay the prompt", async ($: any, on: any) => {
  const seen = setUp(on, { model: [{ text: detected(), delay: 3000 }] });
  const startedAt = seen.clock.now();
  await submit($);
  await seen.clock.settle();
  expect(seen.clock.now()).toBe(startedAt);
  expect(seen.modelCalls).toHaveLength(1);
  expect(seen.store.has("queue")).toBe(false);
  await seen.clock.advance(3000);
  expect(seen.store.get("queue")).toHaveLength(1);
});

test("calls the configured model", { options: { model: "sonnet" } } as any, async ($: any, on: any) => {
  const rule = entry("G-001", "Answer in English", { tags: ["language", "english"] });
  const lesson = entry("P-004", "Use PowerShell");
  const seen = setUp(on, { files: filesWith({ gr: [rule], pl: [lesson] }), model: ['{"correction": false}'] });
  await submit($);
  await seen.clock.settle();
  expect(seen.modelCalls).toEqual([{
    model: "sonnet",
    system: DETECTOR_SYSTEM,
    maxTokens: 400,
    prompt: buildDetectorPrompt({
      previousReply: REPLY,
      userMessage: PROMPT,
      existing: [
        { id: "G-001", title: "Answer in English", tags: ["language", "english"], kind: "rule" },
        { id: "P-004", title: "Use PowerShell", tags: ["powershell", "quoting"], kind: "lesson" },
      ],
      projectSetUp: true,
    }),
  }]);
});

test("the detector model defaults to haiku", async ($: any, on: any) => {
  const seen = setUp(on, { model: ['{"correction": false}'] });
  await submit($);
  await seen.clock.settle();
  expect(seen.modelCalls[0].model).toBe("haiku");
});

test("a scope that cannot be read adds nothing to existing", async ($: any, on: any) => {
  const seen = setUp(on, {
    files: filesWith({ gl: [entry("G-002", "Global one")], pl: [entry("P-004", "Use PowerShell")] }),
    readFails: (p: string) => p === R.rules,
    model: ['{"correction": false}'],
  });
  await submit($);
  await seen.clock.settle();
  expect(seen.modelCalls[0].prompt).toContain("G-002 · Global one");
  expect(seen.modelCalls[0].prompt).not.toContain("P-004");
});

// ---------- confirm: new lessons ----------

test("saves on Save", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: ["Save"] });
  await turn($, seen);
  expect(seen.asks).toEqual([{ question: NEW_QUESTION, options: ["Save", "Save as global", "Skip"] }]);
  expect(entriesIn(seen, R.lessons)).toEqual([
    { id: "P-001", title: TITLE, tags: TAGS, seen: 1, first: TODAY, last: TODAY, body: BODY },
  ]);
  expect(seen.store.get("queue")).toEqual([]);
});

test("Other text replaces the body and goes through cleanBody", async ($: any, on: any) => {
  const typed = "  ## Run it in PowerShell,\n see @docs/shell.md  ";
  const seen = setUp(on, { model: [detected()], asks: [typed] });
  await turn($, seen);
  const [saved] = entriesIn(seen, R.lessons);
  expect(saved.body).toBe(cleanBody(typed));
  expect(saved.body).toBe("Run it in PowerShell, see `@docs/shell.md`");
  expect(saved.title).toBe(TITLE);
  expect(saved.tags).toEqual(TAGS);
});

test("Other text that cleans to nothing saves nothing", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: ["## "] });
  await turn($, seen);
  expect(seen.writes).toEqual([]);
  expect(seen.store.get("queue")).toEqual([]);
});

test("Save as global", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: ["Save as global"] });
  await turn($, seen);
  expect(entriesIn(seen, G.lessons).map((e: any) => e.id)).toEqual(["G-001"]);
  expect(entriesIn(seen, R.lessons)).toEqual([]);
});

test("Skip writes nothing and clears the item", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: ["Skip"] });
  await turn($, seen);
  expect(seen.writes).toEqual([]);
  expect(seen.store.get("queue")).toEqual([]);
});

test("a new id continues from the highest in both files", async ($: any, on: any) => {
  const seen = setUp(on, {
    files: filesWith({ pl: [entry("P-002", "Two")], pr: [entry("P-007", "Seven")] }),
    model: [detected()],
    asks: ["Save"],
  });
  await turn($, seen);
  expect(entriesIn(seen, R.lessons).map((e: any) => e.id)).toEqual(["P-002", "P-008"]);
});

test("a CRLF lessons file stays CRLF", async ($: any, on: any) => {
  const files = filesWith({ pl: [entry("P-001", "One")] });
  files[R.lessons] = files[R.lessons].replace(/\n/g, "\r\n");
  const seen = setUp(on, { files, model: [detected()], asks: ["Save"] });
  await turn($, seen);
  const text = seen.files.get(R.lessons)!;
  expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  expect(entriesIn(seen, R.lessons).map((e: any) => e.id)).toEqual(["P-001", "P-002"]);
});

test("non-ASCII text is saved unchanged", async ($: any, on: any) => {
  const title = "Uporabi PowerShell za ukaze s poševnico 🚀";
  const body = "Git Bash spremeni /ukaz v pot — čšž.";
  const seen = setUp(on, { model: [detected({ title, body, tags: ["šumniki", "ukazi"] })], asks: ["Save"] });
  await turn($, seen, "ne, uporabi PowerShell — čšž");
  expect(seen.asks[0].question).toBe(`Lesson: "${title}" (project). Save it?`);
  const [saved] = entriesIn(seen, R.lessons);
  expect([saved.title, saved.body, saved.tags]).toEqual([title, body, ["šumniki", "ukazi"]]);
});

test("a global detection outside a repo offers no project option", async ($: any, on: any) => {
  const seen = setUp(on, { repo: null, model: [detected({ scope: "global" })], asks: ["Save"] });
  await turn($, seen);
  expect(seen.asks[0]).toEqual({ question: `Lesson: "${TITLE}" (global). Save it?`, options: ["Save", "Skip"] });
  expect(entriesIn(seen, G.lessons).map((e: any) => e.id)).toEqual(["G-001"]);
});

// ---------- confirm: repeats ----------

test("promotes a repeat", async ($: any, on: any) => {
  const lesson = entry("P-004", "Use PowerShell");
  const seen = setUp(on, { files: filesWith({ pl: [lesson] }), model: [detected({ repeatOf: "P-004" })], asks: ["Promote to rule"] });
  await turn($, seen);
  expect(seen.asks).toEqual([{
    question: 'Looks like a repeat of P-004 "Use PowerShell". Promote it to a rule?',
    options: ["Promote to rule", "Save as new", "Skip"],
  }]);
  expect(entriesIn(seen, R.lessons)).toEqual([]);
  expect(entriesIn(seen, R.rules)).toEqual([{ ...lesson, seen: 2, last: TODAY }]);
});

test("promote records the rule in promotedThisSession", async ($: any, on: any) => {
  const lesson = entry("P-004", "Use PowerShell");
  const seen = setUp(on, { files: filesWith({ pl: [lesson] }) });
  const before = promotedThisSession.length;
  expect(await promote(seen.$, "project", "P-004")).toBe(true);
  expect(promotedThisSession.slice(before)).toEqual([{ ...lesson, seen: 2, last: TODAY }]);
  expect(await promote(seen.$, "project", "P-099")).toBe(false);
  expect(promotedThisSession.length).toBe(before + 1);
});

const twentyRules = () =>
  Array.from({ length: 20 }, (_, i) =>
    entry(`P-${String(101 + i).padStart(3, "0")}`, `Rule number ${i + 1}`, { seen: 2 + (i % 4), last: `2026-09-${String(10 + i).padStart(2, "0")}` }));

test("cap dialog on promote: a picked rule goes back to lessons", async ($: any, on: any) => {
  const rules = twentyRules();
  const lesson = entry("P-004", "Use PowerShell");
  const cap = capDialog("project", rules);
  const seen = setUp(on, {
    files: filesWith({ pl: [lesson], pr: rules }),
    model: [detected({ repeatOf: "P-004" })],
    asks: ["Promote to rule", cap.options[1]],
  });
  await turn($, seen);
  expect(seen.asks[1]).toEqual({ question: cap.question, options: cap.options });
  const demoted = cap.candidates[1];
  const ruleIds = entriesIn(seen, R.rules).map((e: any) => e.id);
  expect(ruleIds).toHaveLength(20);
  expect(ruleIds).toContain("P-004");
  expect(ruleIds).not.toContain(demoted);
  expect(entriesIn(seen, R.lessons)).toEqual([rules.find((r) => r.id === demoted)]);
});

test("cap dialog on promote: Cancel promotion leaves both files unchanged", async ($: any, on: any) => {
  const files = filesWith({ pl: [entry("P-004", "Use PowerShell")], pr: twentyRules() });
  const seen = setUp(on, { files, model: [detected({ repeatOf: "P-004" })], asks: ["Promote to rule", "Cancel promotion"] });
  await turn($, seen);
  expect(seen.asks).toHaveLength(2);
  expect(seen.writes).toEqual([]);
  expect(seen.files.get(R.lessons)).toBe(files[R.lessons]);
  expect(seen.files.get(R.rules)).toBe(files[R.rules]);
  expect(seen.store.get("queue")).toEqual([]);
});

test("notes a broken rule", async ($: any, on: any) => {
  const rule = entry("P-003", "Run tests before committing", { seen: 2 });
  const seen = setUp(on, { files: filesWith({ pr: [rule] }), model: [detected({ repeatOf: "P-003" })], asks: ["Note it"] });
  await turn($, seen);
  expect(seen.asks).toEqual([{
    question: 'Rule P-003 "Run tests before committing" was broken again. Note it?',
    options: ["Note it", "Skip"],
  }]);
  expect(entriesIn(seen, R.rules)).toEqual([{ ...rule, seen: 3, last: TODAY }]);
});

test("a repeat whose target is gone before the answer is saved as new", async ($: any, on: any) => {
  const seen = setUp(on, {
    files: filesWith({ pl: [entry("P-004", "Use PowerShell")] }),
    model: [detected({ repeatOf: "P-004" })],
    asks: [{ answer: "Promote to rule", delay: 10 }],
  });
  await turn($, seen);
  seen.files.set(R.lessons, fileOf("lessons"));
  await seen.clock.advance(10);
  expect(entriesIn(seen, R.rules)).toEqual([]);
  expect(entriesIn(seen, R.lessons)).toEqual([
    { id: "P-001", title: TITLE, tags: TAGS, seen: 1, first: TODAY, last: TODAY, body: BODY },
  ]);
});

// ---------- confirm: queue ----------

test("dismiss then review", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: [{ reject: true }, { reject: true }] });
  await turn($, seen);
  expect(seen.asks).toHaveLength(1);
  expect((seen.store.get("queue") as any[]).map((i) => i.dismissed)).toEqual([1]);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(2);
  expect(seen.asks[1].question).toBe(NEW_QUESTION);
  expect(seen.store.get("queue")).toEqual([]);
  const review = seen.store.get("review") as any[];
  expect(review).toHaveLength(1);
  expect(review[0]).toMatchObject({ dismissed: 2, repoRoot: REPO, detection: { title: TITLE, scope: "project" } });
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(2);
  expect(seen.writes).toEqual([]);
  expect(debugOnly(seen)).toBe(true);
});

test("queue survives a session; a project item is not offered in another repo", async ($: any, on: any) => {
  const elsewhere = queued("old:2", { repoRoot: "C:\\other" }, { scope: "project" });
  const global = queued("old:3");
  const seen = setUp(on, { store: { queue: [elsewhere, global] }, asks: ["Save"] });
  await turnEnd($, seen);
  expect(seen.asks).toEqual([{ question: 'Lesson: "Lesson old:3" (global). Save it?', options: ["Save", "Save to project", "Skip"] }]);
  expect(entriesIn(seen, G.lessons).map((e: any) => e.title)).toEqual(["Lesson old:3"]);
  expect(seen.store.get("queue")).toEqual([elsewhere]);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(1);
});

test("waits at most 5 s", async ($: any, on: any) => {
  const seen = setUp(on, { model: [{ text: detected(), delay: 6000 }], asks: ["Save"] });
  await turn($, seen);
  await seen.clock.advance(5000);
  expect(seen.asks).toEqual([]);
  await seen.clock.advance(1000);
  expect(seen.asks).toEqual([]);
  expect(seen.store.get("queue")).toHaveLength(1);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(1);
  expect(entriesIn(seen, R.lessons).map((e: any) => e.id)).toEqual(["P-001"]);
});

test("a result within 5 s is asked at this turn end", async ($: any, on: any) => {
  const seen = setUp(on, { model: [{ text: detected(), delay: 4000 }], asks: ["Save"] });
  await turn($, seen);
  expect(seen.asks).toEqual([]);
  await seen.clock.advance(4000);
  expect(seen.asks).toHaveLength(1);
});

for (const [name, reply] of [["rejects", { reject: true }], ["returns not json", "not json"]] as const) {
  test(`model failure leaves no trace: model ${name}`, async ($: any, on: any) => {
    const seen = setUp(on, { model: [reply as any] });
    await turn($, seen);
    await seen.clock.advance(5000);
    expect(seen.asks).toEqual([]);
    expect(seen.writes).toEqual([]);
    expect(seen.store.has("queue")).toBe(false);
    expect(debugOnly(seen)).toBe(true);
  });
}

test("one ask per turn end", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [queued("a:1"), queued("a:2")] }, asks: ["Skip", "Skip"] });
  await turnEnd($, seen);
  expect(seen.asks.map((a: any) => a.question)).toEqual(['Lesson: "Lesson a:1" (global). Save it?']);
  await turnEnd($, seen);
  expect(seen.asks.map((a: any) => a.question)).toEqual([
    'Lesson: "Lesson a:1" (global). Save it?',
    'Lesson: "Lesson a:2" (global). Save it?',
  ]);
  expect(seen.store.get("queue")).toEqual([]);
});

test("a turn end while an ask is open does nothing", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [queued("a:1"), queued("a:2")] }, asks: [{ answer: "Skip", delay: 1000 }, "Skip"] });
  await turnEnd($, seen);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(1);
  await seen.clock.advance(1000);
  expect((seen.store.get("queue") as any[]).map((i) => i.key)).toEqual(["a:2"]);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(2);
});

test("a detection landing while a dialog is open is kept", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [queued("a:1")] }, model: [detected()], asks: [{ answer: "Skip", delay: 1000 }] });
  await turnEnd($, seen);
  await submit($);
  await seen.clock.settle();
  await seen.clock.advance(1000);
  expect((seen.store.get("queue") as any[]).map((i) => i.key)).toEqual(["s1:1"]);
});

test("aborted turn keeps the queue", async ($: any, on: any) => {
  const seen = setUp(on, { model: [detected()], asks: ["Save"] });
  await submit($);
  await seen.clock.settle();
  await turnEnd($, seen, "aborted");
  await seen.clock.advance(5000);
  expect(seen.asks).toEqual([]);
  expect(seen.store.get("queue")).toHaveLength(1);
  await turnEnd($, seen);
  expect(seen.asks).toHaveLength(1);
  expect(seen.store.get("queue")).toEqual([]);
});

test("a subagent's turn end asks nothing", async ($: any, on: any) => {
  const seen = setUp(on, { store: { queue: [queued("a:1")] }, asks: ["Skip"] });
  await turnEnd($, seen, "answer", { agentId: "agent-1" });
  expect(seen.asks).toEqual([]);
});

test("no surfaces at the turn end: nothing asked, the queue kept", async ($: any, on: any) => {
  const seen = setUp(on, { surfaces: [], store: { queue: [queued("a:1")] } });
  await turnEnd($, seen);
  expect(seen.asks).toEqual([]);
  expect(seen.store.get("queue")).toEqual([queued("a:1")]);
});

test("the queue item key is the session id and turn count", async ($: any, on: any) => {
  const seen = setUp(on, { sessionId: "abc", turns: 7, model: [detected()] });
  await submit($);
  await seen.clock.settle();
  expect(seen.store.get("queue")).toEqual([{
    key: "abc:7",
    detection: { title: TITLE, body: BODY, tags: TAGS, scope: "project", repeatOf: null, repeatKind: null },
    repoRoot: REPO,
    dismissed: 0,
    createdAt: TODAY,
  }]);
});
