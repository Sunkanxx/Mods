import { test, expect } from "claude-code/testing";
import {
  BLOCK_START, BLOCK_END, blockText, hasBlock, insertBlock, addIgnoreLines, pickClaudeMd,
} from "../hooks/lib/claude-md.mjs";
import { joinPath, configDirFrom, scopeFiles, selfAndParents } from "../hooks/lib/paths.mjs";

const BLOCK =
  "<!-- lessons-learned:start -->\n## Learned rules\n@rules-learned.md\n" +
  "Past corrections that aren't rules yet are in `lessons-learned.md`; relevant ones are attached to your prompt automatically.\n" +
  "<!-- lessons-learned:end -->";

test("blockText matches the spec", () => {
  expect(BLOCK_START).toBe("<!-- lessons-learned:start -->");
  expect(BLOCK_END).toBe("<!-- lessons-learned:end -->");
  expect(blockText("rules-learned.md")).toBe(BLOCK);
  expect(blockText("../rules-learned.md")).toContain("\n@../rules-learned.md\n");
  expect(blockText("rules-learned.md", "\r\n")).toBe(BLOCK.replace(/\n/g, "\r\n"));
});

test("hasBlock needs both markers", () => {
  expect(hasBlock(null)).toBe(false);
  expect(hasBlock(BLOCK)).toBe(true);
  expect(hasBlock(BLOCK_START)).toBe(false);
  expect(hasBlock(BLOCK_END)).toBe(false);
});

test("insertBlock into nothing", () => {
  expect(insertBlock(null, "rules-learned.md")).toBe(BLOCK + "\n");
});

test("insertBlock preserves existing text byte for byte", () => {
  expect(insertBlock("# Mine\nno newline", "rules-learned.md")).toBe("# Mine\nno newline\n\n" + BLOCK + "\n");
  expect(insertBlock("# Mine\n", "rules-learned.md")).toBe("# Mine\n\n" + BLOCK + "\n");
  expect(insertBlock("# Mine\n\n", "rules-learned.md")).toBe("# Mine\n\n" + BLOCK + "\n");
});

test("insertBlock keeps a BOM", () => {
  const out = insertBlock("\uFEFF# Mine\n", "rules-learned.md");
  expect(out.startsWith("\uFEFF# Mine\n")).toBe(true);
  expect(out).toBe("\uFEFF# Mine\n\n" + BLOCK + "\n");
});

test("insertBlock keeps CRLF and is idempotent", () => {
  const out = insertBlock("# Mine\r\nbody\r\n", "rules-learned.md");
  expect(out).toBe("# Mine\r\nbody\r\n\r\n" + BLOCK.replace(/\n/g, "\r\n") + "\r\n");
  expect(insertBlock(out, "rules-learned.md")).toBe(out);
  expect(insertBlock("x\n", "rules-learned.md")).toBe(insertBlock(insertBlock("x\n", "rules-learned.md"), "rules-learned.md"));
});

test("addIgnoreLines", () => {
  expect(addIgnoreLines(null)).toBe("lessons-learned.md\nrules-learned.md\n");
  expect(addIgnoreLines("node_modules\n")).toBe("node_modules\nlessons-learned.md\nrules-learned.md\n");
  expect(addIgnoreLines("node_modules")).toBe("node_modules\nlessons-learned.md\nrules-learned.md\n");
  expect(addIgnoreLines("rules-learned.md\n")).toBe("rules-learned.md\nlessons-learned.md\n");
  const full = "a\nlessons-learned.md\nrules-learned.md\n";
  expect(addIgnoreLines(full)).toBe(full);
  expect(addIgnoreLines(addIgnoreLines("a\n"))).toBe("a\nlessons-learned.md\nrules-learned.md\n");
});

test("pickClaudeMd", () => {
  const root = { rel: "CLAUDE.md", importPath: "rules-learned.md" };
  expect(pickClaudeMd(true, true)).toEqual(root);
  expect(pickClaudeMd(true, false)).toEqual(root);
  expect(pickClaudeMd(false, false)).toEqual(root);
  expect(pickClaudeMd(false, true)).toEqual({ rel: ".claude/CLAUDE.md", importPath: "../rules-learned.md" });
});

test("joinPath takes the separator from base", () => {
  expect(joinPath("C:\\Users\\x", ".claude")).toBe("C:\\Users\\x\\.claude");
  expect(joinPath("/home/x", ".claude")).toBe("/home/x/.claude");
  expect(joinPath("/home/x/", "a", "b")).toBe("/home/x/a/b");
});

test("configDirFrom", () => {
  expect(configDirFrom({ CLAUDE_CONFIG_DIR: "D:\\cfg", USERPROFILE: "C:\\u", HOME: "/h" })).toBe("D:\\cfg");
  expect(configDirFrom({ USERPROFILE: "C:\\Users\\x", HOME: "/h" })).toBe("C:\\Users\\x\\.claude");
  expect(configDirFrom({ HOME: "/home/x" })).toBe("/home/x/.claude");
  expect(configDirFrom({})).toBeNull();
});

test("scopeFiles", () => {
  expect(scopeFiles("/home/x/.claude")).toEqual({
    lessons: "/home/x/.claude/lessons-learned.md",
    rules: "/home/x/.claude/rules-learned.md",
  });
  expect(scopeFiles("C:\\r").rules).toBe("C:\\r\\rules-learned.md");
});

test("selfAndParents walks up to the root", () => {
  expect(selfAndParents("C:\\r\\wt\\src")).toEqual(["C:\\r\\wt\\src", "C:\\r\\wt", "C:\\r", "C:\\"]);
  expect(selfAndParents("C:\\r\\")).toEqual(["C:\\r", "C:\\"]);
  expect(selfAndParents("C:\\")).toEqual(["C:\\"]);
  expect(selfAndParents("/home/u/r")).toEqual(["/home/u/r", "/home/u", "/home", "/"]);
  expect(selfAndParents("/")).toEqual(["/"]);
});
