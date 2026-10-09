import { test, expect } from "claude-code/testing";
import {
  parseEntries,
  serializeEntries,
  emptyFile,
  entriesOf,
  findEntry,
  addEntry,
  removeEntry,
  replaceEntry,
  nextId,
  bumpSeen,
  cleanTitle,
  cleanBody,
  normaliseTags,
  FILE_HEADERS,
} from "../hooks/lib/entries.mjs";

const ENTRY =
  "## P-012 · Use PowerShell\ntags: powershell, claude p · seen: 2 · first: 2026-10-07 · last: 2026-10-08\nBody text.\n";

const mk = (id: string, title = "t", body = "b") => ({
  id, title, tags: ["a", "b"], seen: 1, first: "2026-10-01", last: "2026-10-01", body,
});

const FULL =
  FILE_HEADERS.lessons + "\n" +
  "## P-001 · First\ntags: a, b · seen: 1 · first: 2026-10-01 · last: 2026-10-01\nOne.\n\n" +
  "## notes\nhand written\n\n" +
  "## P-002 · Second\ntags: c, d · seen: 3 · first: 2026-10-02 · last: 2026-10-05\nTwo.\n\n";

test("parses an entry", () => {
  const f = parseEntries(ENTRY);
  expect(entriesOf(f)).toEqual([
    { id: "P-012", title: "Use PowerShell", tags: ["powershell", "claude p"], seen: 2,
      first: "2026-10-07", last: "2026-10-08", body: "Body text." },
  ]);
});

// Canonical layout: every entry followed by exactly one blank line.
test("round-trips a canonical file exactly", () => {
  expect(serializeEntries(parseEntries(FULL))).toBe(FULL);
  expect(parseEntries(FULL).blocks.map((b) => b.kind)).toEqual(["entry", "raw", "entry"]);
});

test("keeps malformed blocks verbatim", () => {
  const t = "# H\n\n## P-003 · x\ntags broken here\nbody\n\n";
  const f = parseEntries(t);
  expect(f.blocks).toHaveLength(1);
  expect(f.blocks[0].kind).toBe("raw");
  expect(serializeEntries(f)).toBe(t);
});

test("parses CRLF", () => {
  const f = parseEntries(FULL.replace(/\n/g, "\r\n"));
  expect(f.eol).toBe("\r\n");
  expect(entriesOf(f).map((e) => e.id)).toEqual(["P-001", "P-002"]);
});

test("keeps CRLF on serialise", () => {
  const t = FULL.replace(/\n/g, "\r\n");
  const out = serializeEntries(parseEntries(t));
  expect(out).toBe(t);
  expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
});

test("round-trips non-ASCII", () => {
  const e = { ...mk("P-001", "Uporabi šumnike č š ž 🙂"), tags: ["šumniki", "b"] };
  const t = serializeEntries(addEntry(emptyFile("lessons"), e));
  const back = entriesOf(parseEntries(t))[0];
  expect(back).toEqual(e);
  expect(serializeEntries(parseEntries(t))).toBe(t);
});

test("separator-looking text stays inside one entry", () => {
  const e = { ...mk("P-001", cleanTitle("a · b"), cleanBody("x ## y tags: z")) };
  const t = serializeEntries(addEntry(emptyFile("lessons"), e));
  const f = parseEntries(t);
  expect(f.blocks).toHaveLength(1);
  expect(entriesOf(f)[0]).toEqual(e);
  expect(serializeEntries(f)).toBe(t);
});

test("nextId continues from the highest id across files", () => {
  const l = addEntry(emptyFile("lessons"), mk("P-002"));
  const r = addEntry(emptyFile("rules"), mk("P-007"));
  expect(nextId("project", [l, r])).toBe("P-008");
  expect(nextId("project", [emptyFile("lessons")])).toBe("P-001");
  expect(nextId("global", [])).toBe("G-001");
  expect(nextId("project", [addEntry(emptyFile("lessons"), mk("P-1000"))])).toBe("P-1001");
});

test("removeEntry returns the entry and a file without it", () => {
  const f = parseEntries(FULL);
  const { file, entry } = removeEntry(f, "P-001");
  expect(entry?.id).toBe("P-001");
  expect(findEntry(file, "P-001")).toBeNull();
  expect(entriesOf(file)).toHaveLength(1);
  expect(removeEntry(f, "P-999").entry).toBeNull();
});

test("addEntry appends after the last block", () => {
  const f = addEntry(parseEntries(FULL), mk("P-003"));
  expect(f.blocks.map((b) => b.kind)).toEqual(["entry", "raw", "entry", "entry"]);
  expect(entriesOf(f).at(-1)?.id).toBe("P-003");
});

test("replaceEntry keeps position", () => {
  const f = replaceEntry(parseEntries(FULL), { ...mk("P-001"), title: "Changed" });
  expect(f.blocks.map((b) => b.kind)).toEqual(["entry", "raw", "entry"]);
  expect(entriesOf(f)[0].title).toBe("Changed");
});

test("bumpSeen", () => {
  const e = bumpSeen(mk("P-001"), "2026-11-01");
  expect(e.seen).toBe(2);
  expect(e.last).toBe("2026-11-01");
  expect(e.first).toBe("2026-10-01");
});

test("cleanTitle", () => {
  expect(cleanTitle("a\nb\r\n c")).toBe("a b c");
  expect(cleanTitle("## # Heading")).toBe("Heading");
  expect(cleanTitle("x <!-- lessons-learned:start --> y <!-- lessons-learned:end -->")).toBe("x y");
  const long = cleanTitle("x".repeat(81));
  expect(long).toHaveLength(80);
  expect(long).toBe("x".repeat(79) + "…");
  expect(cleanTitle("x".repeat(80))).toBe("x".repeat(80));
});

test("cleanBody", () => {
  expect(cleanBody("a\n## b\n<!-- lessons-learned:end -->")).toBe("a ## b");
  const long = cleanBody("y".repeat(401));
  expect(long).toHaveLength(400);
  expect(long.endsWith("…")).toBe(true);
  expect(cleanBody("see @a/b.md now")).toBe("see `@a/b.md` now");
  expect(cleanBody("see `@a/b.md` now")).toBe("see `@a/b.md` now");
  expect(cleanBody("mail me@x.com")).toBe("mail me@x.com");
});

test("normaliseTags", () => {
  expect(
    normaliseTags(["Code", "PowerShell", " powershell ", "fix", "slash-command", "a", "b", "c", "d"]),
  ).toEqual(["powershell", "slash-command", "a", "b", "c"]);
  expect(normaliseTags("nope")).toEqual([]);
  expect(normaliseTags(null)).toEqual([]);
});

test("addEntry on a header without trailing newline", () => {
  const f = addEntry(parseEntries("# H"), mk("P-001"));
  const back = parseEntries(serializeEntries(f));
  expect(entriesOf(back).map((e) => e.id)).toEqual(["P-001"]);
  expect(nextId("project", [back])).toBe("P-002");
});

test("cleanBody keeps the limit and leaves no bare @path", () => {
  const out = cleanBody("@a/b.md ".repeat(60));
  expect(Array.from(out).length).toBeLessThanOrEqual(400);
  expect(out.split(/(`[^`]*`)/).filter((_, i) => i % 2 === 0).join("")).not.toMatch(/@\S/);
  expect((out.match(/`/g) ?? []).length % 2).toBe(0);
});

test("cleanTitle defuses @ and tags drop it", () => {
  expect(cleanTitle("see @a/b.md")).toBe("see `@a/b.md`");
  expect(normaliseTags(["@x/y"])).toEqual(["x/y"]);
});

test("nextId counts ids in malformed raw blocks", () => {
  const f = parseEntries("# H\n\n## P-009 · broken\nno meta\n\n");
  expect(nextId("project", [f])).toBe("P-010");
});

test("serialise normalises entry whitespace", () => {
  const meta = (n: string) => `tags: a, b · seen: 1 · first: 2026-10-01 · last: 2026-10-01\n${n}`;
  const t = `# H\n\n## P-001 · A\n${meta("One.")}\n## P-002 · B\n${meta("Two.")}\n\n\n## P-003 · C\n${meta("Three.")}`;
  const f = parseEntries(t);
  expect(entriesOf(f).map((e) => e.body)).toEqual(["One.", "Two.", "Three."]);
  expect(serializeEntries(f)).toBe(
    `# H\n\n## P-001 · A\n${meta("One.")}\n\n## P-002 · B\n${meta("Two.")}\n\n## P-003 · C\n${meta("Three.")}\n\n`,
  );
});

test("an odd number of backticks leaves no @path outside a code span", () => {
  expect(cleanBody("use ` quoting @path")).toBe("use ' quoting `@path`");
  expect(cleanTitle("use ` quoting @path")).toBe("use ' quoting `@path`");
  expect(cleanBody("`a` b ` @c `d`")).toBe("'a' b ' `@c` 'd'");
  expect(cleanBody("keep `@x` paired")).toBe("keep `@x` paired");
});

test("a BOM before the first entry does not hide it", () => {
  const t = "\uFEFF## P-001 · First\ntags: a, b · seen: 1 · first: 2026-10-01 · last: 2026-10-01\nOne.\n\n";
  const f = parseEntries(t);
  expect(entriesOf(f).map((e) => e.id)).toEqual(["P-001"]);
  expect(serializeEntries(f)).toBe(t);
  expect(nextId("project", [f])).toBe("P-002");
  expect(parseEntries(t.replace(/\n/g, "\r\n")).blocks.map((b) => b.kind)).toEqual(["entry"]);
});
