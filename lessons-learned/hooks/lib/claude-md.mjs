// Pure helpers for the CLAUDE.md import block and .gitignore lines.

export const BLOCK_START = "<!-- lessons-learned:start -->";
export const BLOCK_END = "<!-- lessons-learned:end -->";

const IGNORE_LINES = ["lessons-learned.md", "rules-learned.md"];

export function blockText(importPath, eol = "\n") {
  return [
    BLOCK_START,
    "## Learned rules",
    `@${importPath}`,
    "Past corrections that aren't rules yet are in `lessons-learned.md`; relevant ones are attached to your prompt automatically.",
    BLOCK_END,
  ].join(eol);
}

export function hasBlock(text) {
  return typeof text === "string" && text.includes(BLOCK_START) && text.includes(BLOCK_END);
}

function eolOf(text) {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

export function insertBlock(text, importPath) {
  if (text === null || text === undefined || text === "") return blockText(importPath) + "\n";
  if (hasBlock(text)) return text;
  const eol = eolOf(text);
  // Leave exactly one blank line between existing text and the block.
  let gap = eol + eol;
  if (text.endsWith(eol + eol)) gap = "";
  else if (text.endsWith(eol)) gap = eol;
  return text + gap + blockText(importPath, eol) + eol;
}

export function addIgnoreLines(text) {
  const base = text ?? "";
  const eol = eolOf(base);
  const present = new Set(base.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return base;
  const lead = base === "" || base.endsWith("\n") ? "" : eol;
  return base + lead + missing.join(eol) + eol;
}

export function pickClaudeMd(rootExists, dotClaudeExists) {
  if (!rootExists && dotClaudeExists) {
    return { rel: ".claude/CLAUDE.md", importPath: "../rules-learned.md" };
  }
  return { rel: "CLAUDE.md", importPath: "rules-learned.md" };
}
