import { test, expect } from "claude-code/testing";
import { FILE_HEADERS } from "../hooks/lib/entries.mjs";
import { offerProjectSetup, readScope, updateFile } from "../hooks/lessons-learned.mjs";
import { insertBlock, addIgnoreLines } from "../hooks/lib/claude-md.mjs";
import { world } from "./world";

const HOME = "C:\\Users\\u";
const DIR = `${HOME}\\.claude`;
const G = { lessons: `${DIR}\\lessons-learned.md`, rules: `${DIR}\\rules-learned.md`, md: `${DIR}\\CLAUDE.md` };
const REPO = "C:\\r";
const R = { lessons: `${REPO}\\lessons-learned.md`, rules: `${REPO}\\rules-learned.md`, md: `${REPO}\\CLAUDE.md` };
const QUESTION = "Set up lessons-learned for this project? It adds two files next to CLAUDE.md and one import line.";
const OPTIONS = ["Yes, commit them", "Yes, keep out of git", "Not here"];
const LESSONS = FILE_HEADERS.lessons + "\n";
const RULES = FILE_HEADERS.rules + "\n";
const GLOBAL_FILES = { [G.lessons]: LESSONS, [G.rules]: RULES, [G.md]: insertBlock(null, "rules-learned.md") };

async function start($: any, cwd = REPO) {
  await $.session.start({ source: "startup", cwd } as any);
}

const written = (seen: any) => Object.fromEntries(seen.writes.map((w: any) => [w.path, w.text]));

test("creates global files and block on first start", async ($: any, on: any) => {
  const seen = world(on);
  await start($);
  expect(written(seen)).toEqual({
    [G.lessons]: LESSONS,
    [G.rules]: RULES,
    [G.md]: insertBlock(null, "rules-learned.md"),
  });
  expect(seen.asks).toEqual([]);
  expect(seen.store.get("globalSetupDone")).toBe(true);
});

test("respects CLAUDE_CONFIG_DIR", async ($: any, on: any) => {
  const seen = world(on, { env: { CLAUDE_CONFIG_DIR: "D:\\cfg", USERPROFILE: HOME } });
  await start($);
  expect(seen.writes.map((w: any) => w.path)).toEqual(["D:\\cfg\\lessons-learned.md", "D:\\cfg\\rules-learned.md", "D:\\cfg\\CLAUDE.md"]);
});

test("falls back to HOME", async ($: any, on: any) => {
  const seen = world(on, { env: { HOME: "/home/u" } });
  await start($);
  // The engine normalises the POSIX path on Windows (C:\home\u\.claude\...).
  expect(seen.writes.some((w: any) => /home.u.\.claude.CLAUDE\.md$/.test(w.path))).toBe(true);
});

test("leaves an existing global CLAUDE.md intact apart from the block", async ($: any, on: any) => {
  const mine = "# My rules\r\n- be kind";
  const seen = world(on, { files: { [G.md]: mine } });
  await start($);
  expect(seen.files.get(G.md)).toBe(insertBlock(mine, "rules-learned.md"));
  expect(seen.files.get(G.md)!.startsWith(mine)).toBe(true);
});

test("second start writes nothing", async ($: any, on: any) => {
  const seen = world(on);
  await start($);
  seen.writes.length = 0;
  await start($);
  expect(seen.writes).toEqual([]);
});

test("does not touch files that already exist", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [G.lessons]: "# mine\n" } });
  await start($);
  expect(seen.writes).toEqual([]);
});

test("recreates a deleted global file", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES });
  seen.files.delete(G.rules);
  await start($);
  expect(written(seen)).toEqual({ [G.rules]: RULES });
});

test("re-inserts a removed global block", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [G.md]: "# mine\n" } });
  await start($);
  expect(written(seen)).toEqual({ [G.md]: insertBlock("# mine\n", "rules-learned.md") });
});

test("asks once per repo", async ($: any, on: any) => {
  const seen = world(on, { repo: { root: REPO }, asks: ["Not here"] });
  await start($);
  expect(seen.asks).toEqual([{ question: QUESTION, options: OPTIONS }]);
});

test("Yes, commit them writes the project files and block", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, repo: { root: REPO }, asks: ["Yes, commit them"] });
  await start($);
  expect(written(seen)).toEqual({
    [R.lessons]: LESSONS,
    [R.rules]: RULES,
    [R.md]: insertBlock(null, "rules-learned.md"),
  });
  await start($);
  expect(seen.asks).toHaveLength(1);
});

test("Yes, commit them keeps an existing project CLAUDE.md and leaves .gitignore alone", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [R.md]: "# Repo\n", [`${REPO}\\.gitignore`]: "dist\n" }, repo: { root: REPO }, asks: ["Yes, commit them"] });
  await start($);
  expect(seen.files.get(R.md)).toBe(insertBlock("# Repo\n", "rules-learned.md"));
  expect(seen.writes.map((w: any) => w.path)).not.toContain(`${REPO}\\.gitignore`);
});

test("Yes, keep out of git also edits .gitignore", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [`${REPO}\\.gitignore`]: "dist" }, repo: { root: REPO }, asks: ["Yes, keep out of git"] });
  await start($);
  expect(seen.files.get(`${REPO}\\.gitignore`)).toBe(addIgnoreLines("dist"));
  expect(seen.files.get(R.md)).toBe(insertBlock(null, "rules-learned.md"));
});

test("Yes, keep out of git creates a missing .gitignore", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, repo: { root: REPO }, asks: ["Yes, keep out of git"] });
  await start($);
  expect(seen.files.get(`${REPO}\\.gitignore`)).toBe(addIgnoreLines(null));
});

test("uses .claude/CLAUDE.md when it is the only one", async ($: any, on: any) => {
  const dot = `${REPO}\\.claude\\CLAUDE.md`;
  const seen = world(on, { files: { ...GLOBAL_FILES, [dot]: "# Repo\n" }, repo: { root: REPO }, asks: ["Yes, commit them"] });
  await start($);
  expect(seen.files.get(dot)).toBe(insertBlock("# Repo\n", "../rules-learned.md"));
  expect(seen.files.has(R.md)).toBe(false);
  expect(seen.files.has(R.rules)).toBe(true);
  await start($);
  expect(seen.asks).toHaveLength(1);
});

test("Not here is remembered", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, repo: { root: REPO }, asks: ["Not here"] });
  await start($);
  expect(seen.store.get("optOut:C:\\r")).toBe(true);
  expect(seen.writes).toEqual([]);
  await start($);
  expect(seen.asks).toHaveLength(1);
});

test("a dismissed setup ask stores nothing and asks again next session", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, repo: { root: REPO }, asks: [{ reject: true }, "Not here"] });
  await start($);
  expect([...seen.store.keys()].filter((k) => k.startsWith("optOut"))).toEqual([]);
  expect(seen.writes).toEqual([]);
  expect(seen.logs.filter((l) => l.to === "debug")).toHaveLength(1);
  await start($);
  expect(seen.asks).toHaveLength(2);
});

test("a project that is set up is not asked again", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [R.md]: insertBlock(null, "rules-learned.md"), [R.lessons]: LESSONS, [R.rules]: RULES }, repo: { root: REPO } });
  await start($);
  expect(seen.asks).toEqual([]);
  expect(seen.writes).toEqual([]);
});

test("a removed project block asks again", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [R.md]: "# Repo\n" }, repo: { root: REPO }, asks: ["Not here"] });
  await start($);
  expect(seen.asks).toHaveLength(1);
});

test("no surfaces: global setup runs, no project ask", async ($: any, on: any) => {
  const seen = world(on, { repo: { root: REPO }, surfaces: [] });
  await start($);
  expect(seen.writes.map((w: any) => w.path)).toContain(G.md);
  expect(seen.asks).toEqual([]);
});

test("not a git repo: no project ask", async ($: any, on: any) => {
  const seen = world(on, { repo: null, asks: ["Yes, commit them"] });
  await start($);
  expect(seen.asks).toEqual([]);
  expect(seen.writes).toHaveLength(3);
});

test("an fs failure does not throw and logs once to debug", async ($: any, on: any) => {
  const seen = world(on, { writeFails: true });
  await start($);
  expect(seen.logs).toHaveLength(1);
  expect(seen.logs[0].to).toBe("debug");
  expect(seen.store.has("globalSetupDone")).toBe(false);
});

test("an unreadable CLAUDE.md is never overwritten", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [G.md]: "# mine\n" }, readFails: (p: string) => p === G.md });
  await start($);
  expect(seen.writes).toEqual([]);
  expect(seen.logs).toHaveLength(1);
});

test("offerProjectSetup with force asks again after Not here", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, repo: { root: REPO }, asks: ["Not here", "Yes, commit them"] });
  await start($);
  await start($);
  expect(seen.asks).toHaveLength(1);
  await offerProjectSetup(seen.$, { force: true });
  expect(seen.asks).toHaveLength(2);
  expect(seen.store.has("optOut:C:\r")).toBe(false);
  expect(seen.files.get(R.md)).toBe(insertBlock(null, "rules-learned.md"));
});

test("readScope: global, project, and scopes without a base", async ($: any, on: any) => {
  const seen = world(on, { files: { ...GLOBAL_FILES, [G.rules]: "# mine\n\n## G-001 · T\ntags: a, b · seen: 1 · first: 2026-10-01 · last: 2026-10-01\nbody\n" }, repo: { root: REPO } });
  const g = await readScope(seen.$, "global");
  expect(g!.paths).toEqual({ lessons: G.lessons, rules: G.rules });
  expect(g!.rules.blocks).toHaveLength(1);
  expect(g!.lessons.blocks).toEqual([]);
  expect(await readScope(seen.$, "project")).toBeNull();
  seen.files.set(R.md, insertBlock(null, "rules-learned.md"));
  const p = await readScope(seen.$, "project");
  expect(p!.paths).toEqual({ lessons: R.lessons, rules: R.rules });
  expect(p!.lessons.header).toBe(LESSONS);
});

test("readScope: project without a repo is null", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES });
  expect(await readScope(seen.$, "project")).toBeNull();
});

test("readScope: unreadable file", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES, readFails: (p: string) => p === G.lessons });
  expect(await readScope(seen.$, "global")).toBeNull();
  expect(seen.logs).toHaveLength(1);
});

test("updateFile re-reads, mutates and writes once; a missing file starts empty", async ($: any, on: any) => {
  const seen = world(on, { files: GLOBAL_FILES });
  const add = (f: any) => ({ ...f, header: f.header + "x\n" });
  await updateFile(seen.$, G.lessons, "lessons", add);
  expect(seen.files.get(G.lessons)).toBe(LESSONS + "x\n");
  await updateFile(seen.$, `${DIR}\new.md`, "rules", add);
  expect(seen.files.get(`${DIR}\new.md`)).toBe(RULES + "x\n");
  expect(seen.writes).toHaveLength(2);
});

