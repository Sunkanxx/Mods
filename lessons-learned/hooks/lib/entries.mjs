// Pure library: parse, edit and serialise the lessons / rules markdown files.
// No host API in here, so it can be imported straight into tests.

export const FILE_HEADERS = {
  lessons:
    "# Lessons learned\n\nCorrections confirmed once. Relevant ones are attached to prompts automatically; a repeat promotes one to rules-learned.md. Managed by the lessons-learned mod — edit freely, keep each entry's two first lines.\n",
  rules:
    "# Rules learned\n\nCorrections made more than once. CLAUDE.md imports this file, so every rule applies in every session. Managed by the lessons-learned mod — edit freely, keep each entry's two first lines.\n",
};

export const GENERIC_TAGS = new Set([
  "code", "file", "files", "fix", "bug", "error", "issue", "change", "changes",
  "update", "thing", "work", "task", "project", "repo", "stuff",
]);

const TITLE_MAX = 80;
const BODY_MAX = 400;
const TAGS_MAX = 5;
const SEP = " · ";
const META_SEEN = " · seen: ";
const LINE1 = /^## ([GP]-\d{3,}) · (.+)$/;
const LINE2 = /^tags: (.*) · seen: (\d+) · first: (\d{4}-\d{2}-\d{2}) · last: (\d{4}-\d{2}-\d{2})$/;
const LEADING_HASHES = /^(?:#+\s*)+/;
const RAW_ID = /^## ([GP]-\d{3,})/;
const MARKERS = /<!--\s*lessons-learned:(?:start|end)\s*-->/g;

// Split the raw block text into a block: an entry if both meta lines match, else raw.
function parseBlock(text) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const m1 = LINE1.exec(lines[0]);
  const m2 = lines.length >= 2 ? LINE2.exec(lines[1]) : null;
  if (!m1 || !m2) return { kind: "raw", text };
  const tags = m2[1] === "" ? [] : m2[1].split(", ");
  return {
    kind: "entry",
    entry: {
      id: m1[1], title: m1[2], tags, seen: Number(m2[2]), first: m2[3], last: m2[4],
      body: lines.slice(2).join("\n"),
    },
  };
}

export function parseEntries(text) {
  const eol = /\r?\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
  const lf = text.replace(/\r\n/g, "\n");
  const starts = [];
  // A leading BOM stays in the header; the entry right after it still starts a block.
  const re = /^\uFEFF?## /gm;
  for (let m; (m = re.exec(lf)); ) starts.push(m.index + (m[0].startsWith("\uFEFF") ? 1 : 0));
  const header = lf.slice(0, starts[0] ?? lf.length);
  const blocks = starts.map((s, i) => parseBlock(lf.slice(s, starts[i + 1] ?? lf.length)));
  return { header, blocks, eol };
}

function entryText(e) {
  return `## ${e.id}${SEP}${e.title}\ntags: ${e.tags.join(", ")}${META_SEEN}${e.seen} · first: ${e.first} · last: ${e.last}\n${e.body}\n\n`;
}

export function serializeEntries(file) {
  const lf = file.header + file.blocks.map((b) => (b.kind === "entry" ? entryText(b.entry) : b.text)).join("");
  return file.eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

export function emptyFile(kind) {
  return { header: FILE_HEADERS[kind] + "\n", blocks: [], eol: "\n" };
}

export function entriesOf(file) {
  return file.blocks.filter((b) => b.kind === "entry").map((b) => b.entry);
}

export function findEntry(file, id) {
  return entriesOf(file).find((e) => e.id === id) ?? null;
}

// A trailing raw block may lack its closing blank line; add it so the new block starts cleanly.
export function addEntry(file, entry) {
  const blocks = file.blocks.slice();
  let header = file.header;
  if (blocks.length === 0 && header !== "" && !header.endsWith("\n\n")) {
    header = header.replace(/\n*$/, "\n\n");
  }
  const last = blocks[blocks.length - 1];
  if (last?.kind === "raw" && !last.text.endsWith("\n\n")) {
    blocks[blocks.length - 1] = { kind: "raw", text: last.text.replace(/\n*$/, "\n\n") };
  }
  blocks.push({ kind: "entry", entry });
  return { ...file, header, blocks };
}

export function removeEntry(file, id) {
  const entry = findEntry(file, id);
  if (!entry) return { file, entry: null };
  return { file: { ...file, blocks: file.blocks.filter((b) => !(b.kind === "entry" && b.entry.id === id)) }, entry };
}

export function replaceEntry(file, entry) {
  return {
    ...file,
    blocks: file.blocks.map((b) => (b.kind === "entry" && b.entry.id === entry.id ? { kind: "entry", entry } : b)),
  };
}

export function nextId(scope, files) {
  const prefix = scope === "global" ? "G" : "P";
  let max = 0;
  for (const f of files) {
    for (const b of f.blocks) {
      const id = b.kind === "entry" ? b.entry.id : RAW_ID.exec(b.text)?.[1];
      if (id?.startsWith(prefix + "-")) max = Math.max(max, Number(id.slice(2)));
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function bumpSeen(entry, today) {
  return { ...entry, seen: entry.seen + 1, last: today };
}

function oneLine(s) {
  return String(s ?? "").replace(MARKERS, " ").replace(/\s+/g, " ").trim();
}

function truncate(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

// Claude Code reads "@path" as an import wherever it starts the text or follows whitespace
// outside a code span, and a code span is closed only by a backtick run of the same length
// (an escaped "\`" is no backtick at all): wrapping in backticks cannot be made safe. So every
// "@" at the start or after whitespace, a backtick or a backslash becomes U+FF20 (fullwidth
// commercial at), which still reads as "@" but starts no import. An "@" inside a word
// (me@x.com) stays. Idempotent: the replacement is not "@" (spec §5.5).
const IMPORT_AT = /(^|[\s`\\])@/g;
const SAFE_AT = String.fromCodePoint(0xff20);

function defuseAt(s) {
  return s.replace(IMPORT_AT, `$1${SAFE_AT}`);
}

function clean(s, max) {
  return truncate(defuseAt(oneLine(s).replace(LEADING_HASHES, "")), max);
}

export function cleanTitle(s) {
  return clean(s, TITLE_MAX);
}

export function cleanBody(s) {
  return clean(s, BODY_MAX);
}

// Tags come from model output and go on the tags: line of every entry, rules-learned.md
// included: only a short keyword survives (letters or digits in any script, inner spaces and
// hyphens, at most 30 characters and 3 words). Anything else is dropped, not repaired
// (spec §5.5). NFC first, so a decomposed letter (s + combining caron) counts as a letter.
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,29}$/u;
const TAG_WORDS_MAX = 3;

export function normaliseTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const tag = String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase().normalize("NFC");
    if (!TAG.test(tag) || tag.split(" ").length > TAG_WORDS_MAX) continue;
    if (!GENERIC_TAGS.has(tag) && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, TAGS_MAX);
}
