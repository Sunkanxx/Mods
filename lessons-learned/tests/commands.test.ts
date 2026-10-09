import { test, expect } from "claude-code/testing";
import { serializeEntries, emptyFile, addEntry, parseEntries, entriesOf } from "../hooks/lib/entries.mjs";
import { insertBlock } from "../hooks/lib/claude-md.mjs";
import { world, type WorldOptions } from "./world";

const DIR = "C:\\Users\\u\\.claude";
const G = { lessons: `${DIR}\\lessons-learned.md`, rules: `${DIR}\\rules-learned.md`, md: `${DIR}\\CLAUDE.md` };
const REPO = "C:\\r";
const R = { lessons: `${REPO}\\lessons-learned.md`, rules: `${REPO}\\rules-learned.md`, md: `${REPO}\\CLAUDE.md` };
const USAGE = "Usage: /lessons [review | promote <id> | demote <id> | delete <id> | setup | pause | resume | eval]";

const entry = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, tags: ["alpha", "beta"], seen: 1, first: "2026-10-01", last: "2026-10-01", body: "Body.", ...o,
});
const fileOf = (kind: "lessons" | "rules", list: any[] = []) =>
  serializeEntries(list.reduce((f: any, e: any) => addEntry(f, e), emptyFile(kind)));
const filesWith = (o: { gl?: any[]; gr?: any[]; pl?: any[]; pr?: any[] } = {}) => ({
  [G.lessons]: fileOf("lessons", o.gl), [G.rules]: fileOf("rules", o.gr), [G.md]: insertBlock(null, "rules-learned.md"),
  [R.lessons]: fileOf("lessons", o.pl), [R.rules]: fileOf("rules", o.pr), [R.md]: insertBlock(null, "rules-learned.md"),
});
const setUp = (on: any, o: WorldOptions & { lists?: Parameters<typeof filesWith>[0] } = {}) => {
  const { lists, ...rest } = o;
  return world(on, { files: filesWith(lists), repo: { root: REPO }, ...rest });
};
const run = async ($: any, args = "") => ((await $.command.run({ command: "lessons", args } as any)) as any).text as string;
const ids = (seen: any, path: string) => entriesOf(parseEntries(seen.files.get(path))).map((e: any) => e.id);

const reviewItem = (key: string, title: string, o: Record<string, unknown> = {}) => ({
  key, dismissed: 2, createdAt: "2026-10-08", repoRoot: null,
  detection: { title, body: "Body.", tags: ["alpha", "beta"], scope: "global", ...o },
});

test("registers the command on session start", async ($: any, on: any) => {
  const seen = setUp(on);
  await $.session.start({ cwd: REPO } as any);
  expect(seen.commands).toEqual([{
    name: "lessons",
    description: "Learned lessons and rules: list, review, promote, demote, delete, setup, pause, resume, eval",
    argumentHint: "[review|promote <id>|demote <id>|delete <id>|setup|pause|resume|eval]",
  }]);
});

test("lists counts, rules and lessons", async ($: any, on: any) => {
  setUp(on, {
    lists: {
      gr: [entry("G-001", "Rule one"), entry("G-002", "Rule two")],
      gl: [1, 2, 3, 4, 5].map((n) => entry(`G-00${n + 2}`, `Lesson ${n}`)),
      pr: [entry("P-001", "Project rule")],
      pl: [entry("P-004", "Use PowerShell", { seen: 2 }), entry("P-005", "B"), entry("P-006", "C")],
    },
    store: { review: [reviewItem("k1", "Pending")] },
  });
  const text = await run($);
  const lines = text.split("\n");
  expect(lines[0]).toBe("Global: 2 rules, 5 lessons · Project: 1 rule, 3 lessons · 1 to review");
  expect(lines).toContain("Rules");
  expect(lines).toContain("Lessons");
  expect(lines).toContain("G-001 · Rule one · seen 1");
  expect(lines).toContain("P-004 · Use PowerShell · seen 2");
  expect(lines.indexOf("Rules")).toBeLessThan(lines.indexOf("Lessons"));
});

test("without a project there are no project counts", async ($: any, on: any) => {
  setUp(on, { repo: null, lists: { gl: [entry("G-001", "One")] } });
  expect((await run($)).split("\n")[0]).toBe("Global: 0 rules, 1 lesson");
});

test("unknown subcommand gives the usage line", async ($: any, on: any) => {
  setUp(on);
  expect(await run($, "frobnicate")).toBe(USAGE);
  expect(await run($, "promote")).toBe(USAGE);
});

test("promote moves a lesson to rules, case-insensitively", async ($: any, on: any) => {
  const seen = setUp(on, { lists: { pl: [entry("P-004", "Use PowerShell")] } });
  expect(await run($, "promote p-004")).toBe("Promoted P-004 to a rule.");
  expect(ids(seen, R.rules)).toEqual(["P-004"]);
  expect(ids(seen, R.lessons)).toEqual([]);
  expect(entriesOf(parseEntries(seen.files.get(R.rules)!))[0].seen).toBe(2);
});

test("promote at the cap asks which rule goes back", { options: { ruleCap: 1 } } as any, async ($: any, on: any) => {
  const seen = setUp(on, {
    lists: { gr: [entry("G-001", "Old rule")], gl: [entry("G-002", "New lesson")] },
    asks: ["G-001 Old rule"],
  });
  expect(await run($, "promote G-002")).toBe("Promoted G-002 to a rule.");
  expect(seen.asks).toHaveLength(1);
  expect(ids(seen, G.rules)).toEqual(["G-002"]);
  expect(ids(seen, G.lessons)).toEqual(["G-001"]);
});

test("demote moves a rule back to lessons keeping seen and dates", async ($: any, on: any) => {
  const seen = setUp(on, { lists: { pr: [entry("P-003", "Old rule", { seen: 4, first: "2026-01-02", last: "2026-09-09" })] } });
  expect(await run($, "demote P-003")).toBe("Demoted P-003 to a lesson.");
  expect(ids(seen, R.rules)).toEqual([]);
  expect(entriesOf(parseEntries(seen.files.get(R.lessons)!))[0]).toMatchObject({
    id: "P-003", seen: 4, first: "2026-01-02", last: "2026-09-09",
  });
});

test("unknown id", async ($: any, on: any) => {
  setUp(on);
  expect(await run($, "promote P-099")).toBe("No entry P-099.");
  expect(await run($, "demote G-099")).toBe("No entry G-099.");
  expect(await run($, "delete P-099")).toBe("No entry P-099.");
});

test("delete asks first and removes on Delete", async ($: any, on: any) => {
  const seen = setUp(on, { lists: { gl: [entry("G-002", "Quote it")] }, asks: ["Delete"] });
  expect(await run($, "delete g-002")).toBe("Deleted G-002.");
  expect(seen.asks).toEqual([{ question: 'Delete G-002 "Quote it"?', options: ["Delete", "Keep"] }]);
  expect(ids(seen, G.lessons)).toEqual([]);
});

test("delete removes a rule too", async ($: any, on: any) => {
  const seen = setUp(on, { lists: { gr: [entry("G-002", "Quote it")] }, asks: ["Delete"] });
  await run($, "delete G-002");
  expect(ids(seen, G.rules)).toEqual([]);
});

test("delete kept or dismissed changes nothing", async ($: any, on: any) => {
  const seen = setUp(on, { lists: { gl: [entry("G-002", "Quote it")] }, asks: ["Keep"] });
  expect(await run($, "delete G-002")).toBe("Kept G-002.");
  expect(await run($, "delete G-002")).toBe("Kept G-002."); // queue empty: dismissed
  expect(ids(seen, G.lessons)).toEqual(["G-002"]);
});

test("review with nothing says so", async ($: any, on: any) => {
  setUp(on);
  expect(await run($, "review")).toBe("Nothing to review.");
});

test("review asks once per item and removes the answered", async ($: any, on: any) => {
  const seen = setUp(on, {
    store: { review: [reviewItem("k1", "First"), reviewItem("k2", "Second")] },
    asks: ["Save", "Skip"],
  });
  expect(await run($, "review")).toBe("Reviewed 2 items.");
  expect(seen.asks.map((a) => a.question)).toEqual(['Lesson: "First" (global). Save it?', 'Lesson: "Second" (global). Save it?']);
  expect(seen.store.get("review")).toEqual([]);
  expect(ids(seen, G.lessons)).toEqual(["G-001"]);
});

test("a dismissed review item stays and stops the walk", async ($: any, on: any) => {
  const seen = setUp(on, { store: { review: [reviewItem("k1", "First"), reviewItem("k2", "Second")] } });
  expect(await run($, "review")).toBe("Reviewed 0 items, 2 left.");
  expect(seen.asks).toHaveLength(1);
  expect((seen.store.get("review") as any[]).map((i) => i.key)).toEqual(["k1", "k2"]);
});

test("review does not open a second dialog while one is open", async ($: any, on: any) => {
  const seen = setUp(on, { store: { review: [reviewItem("k1", "First")] }, asks: [{ answer: "Save", delay: 1000 }] });
  const first = run($, "review");
  await seen.clock.advance(0);
  expect(await run($, "review")).toBe("A lesson dialog is already open.");
  expect(seen.asks).toHaveLength(1);
  await seen.clock.advance(1000);
  expect(await first).toBe("Reviewed 1 item.");
});

test("setup outside a repository", async ($: any, on: any) => {
  const seen = setUp(on, { repo: null });
  expect(await run($, "setup")).toBe("Not in a git repository.");
  expect(seen.asks).toEqual([]);
});

test("setup offers the dialog even after an opt-out", async ($: any, on: any) => {
  const seen = setUp(on, {
    files: { [G.lessons]: fileOf("lessons"), [G.rules]: fileOf("rules"), [G.md]: insertBlock(null, "rules-learned.md") },
    store: { [`optOut:${REPO}`]: true },
    asks: ["Yes, commit them"],
  });
  expect(await run($, "setup")).toBe("Lessons are set up for this project.");
  expect(seen.asks).toHaveLength(1);
  expect(seen.files.has(R.rules)).toBe(true);
});

test("pause stops capture while recall still runs; resume restores it", async ($: any, on: any) => {
  const seen = setUp(on, {
    lists: { gl: [entry("G-001", "Quote carefully", { tags: ["powershell", "quoting"] })] },
    messages: [{ role: "assistant", text: "Ran it.", toolUses: [] }],
    model: ["{}", "{}"],
    allowTools: ["Read"],
  });
  const submit = (text: string) => $.prompt.submit({ text, origin: { kind: "composer" }, wait: false });
  expect(await run($, "pause")).toBe("Capture paused for this session.");
  const out = await submit("no, fix the powershell quoting");
  await seen.clock.settle();
  expect(seen.modelCalls).toHaveLength(0);
  expect(out.context).toHaveLength(1);
  expect(out.context[0]).toContain("G-001");
  expect(await run($, "resume")).toBe("Capture resumed.");
  await submit("no, use something else");
  await seen.clock.settle();
  expect(seen.modelCalls).toHaveLength(1);
});
