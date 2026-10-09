# lessons-learned Implementation Plan

> The implementation plan the mod was built from, task by task. Steps use checkbox (`- [ ]`) syntax; each task carries `Model / Effort / Files / Depends on` tags.

**Goal:** Build the standalone `lessons-learned` Claude Code mod: detect corrections, confirm them, store lessons and rules per scope, recall lessons by tag, promote repeats to rules imported by `CLAUDE.md`.

**Architecture:** One hooks module `hooks/lessons-learned.mjs` holds every `on(...)` and every `$.noun.method(...)` call (the engine reads them from the source, so they stay spelled out and the functions that take `$` live at the top level). All logic that can be pure lives in `hooks/lib/*.mjs` (no `$`), unit-tested directly. Hook tests stub the host with `claude-code/testing`.

**Tech Stack:** Claude Code mod API (ES modules, `.mjs`), TypeScript tests via `claude plugin test` (`import { test, expect, mock } from "claude-code/testing"`), `claude plugin validate`.

**Spec:** `lessons-learned/docs/design.md` (read it with this plan; section numbers below refer to it).

## Global Constraints

- Standalone: no import, call or mention of any other plugin, skill, agent or tool; only the Claude Code mod API.
- Repo `Mods/` = marketplace `sunkanxx-mods`; plugin folder `lessons-learned/`; author `Sunkanxx`; licence MIT.
- Files: global `<configDir>/lessons-learned.md`, `<configDir>/rules-learned.md`, `<configDir>/CLAUDE.md`; project `<repo>/lessons-learned.md`, `<repo>/rules-learned.md`, `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md`.
- `<configDir>` = env `CLAUDE_CONFIG_DIR` if set, else `<USERPROFILE or HOME>/.claude`. Never hard-code a drive or `/home`.
- Ids `G-NNN` / `P-NNN`, zero-padded to 3, stable through promotion and demotion.
- Detector: `$.model.complete`, model from config (default `haiku`), `maxTokens: 400`, previous reply truncated to its last 6,000 characters. Never `$.model.fork`.
- Config defaults in code: `model = "haiku"`, `ruleCap = 20`, `maxRecall = 3`.
- Confirmation only at `turn.complete`, waiting at most 5,000 ms for this turn's detector result.
- Title ≤ 80 characters, body ≤ 400 characters, 2–5 tags, generic tags dropped.
- No prompt delay: the detector call is never awaited inside `prompt.submit`.
- Every failure (model, fs, parse) degrades to "no capture" and logs only with `$.ui.log(..., { to: "debug" })`.
- Nothing is pushed; creating the GitHub repo is out of this plan.

## Review Focus

1. **Non-ASCII text** (Slovenian `č š ž`, emoji) in prompts, titles and tags must survive parse → serialise → recall unchanged. Tests: Task 2 `round-trips non-ASCII`, Task 5 `matches non-ASCII tags`.
2. **CRLF files** — a hand-edited or git-checked-out file with `\r\n` must parse, and a write must keep the file's line ending. Tests: Task 2 `parses CRLF` and `keeps CRLF on serialise`, Task 3 `insertBlock keeps CRLF`.
3. **The user's own CLAUDE.md** with no trailing newline, a BOM, or existing content: the block is appended once, nothing else changes. Test: Task 3 `insertBlock preserves existing text byte for byte`.
4. **Text that imitates the detector's framing** (`</user_message>` inside a prompt or reply) must not break out of its block. Test: Task 4 `escapes closing tags in data`.
5. **Separators inside entry text** — a title containing ` · `, a body containing `## ` or a line starting `tags:` must round-trip as one entry. Test: Task 2 `separator-looking text stays inside one entry`.

---

### Task 1: Probe spike — concurrent asks, background model call, `@` in code spans (throwaway)

Model: sonnet · Effort: medium · Depends on: none
Files: scratchpad only (`<scratchpad>/probe/probe-a/`, `<scratchpad>/probe/probe-b/`, `<scratchpad>/probe/workdir/`); then `lessons-learned/docs/design.md` (new §11)

Answers three questions the build depends on. Nothing from the probe is kept except the findings.

- [ ] **Step 1: Write probe plugin A** at `<scratchpad>/probe/probe-a/` (`.claude-plugin/plugin.json`, `hooks/hooks.json` with `{ "modules": ["./probe-a.mjs"] }`, `hooks/probe-a.mjs`):
  - `prompt.submit`: start `$.model.complete({ model: "haiku", prompt: "Reply with the word ok.", maxTokens: 10 })` **without awaiting**; keep the promise in a module variable; record `Date.now()`; return `next(e)`.
  - `turn.complete`: await that promise (5,000 ms race); `$.ui.log` `probe-a model: <text|timeout|error> after <ms> ms`; then `await $.ui.ask("Probe A: which dialog is this?", ["A-one", "A-two"])` and log the answer or the rejection message.
  - `prompt.context`: log every `e.instructionFiles` path (`probe-a files: …`), return `next(e)`.
- [ ] **Step 2: Write probe plugin B** at `<scratchpad>/probe/probe-b/`: only `turn.complete` → `$.ui.ask("Probe B: which dialog is this?", ["B-one", "B-two"])`, log answer or rejection.
- [ ] **Step 3: Write the workdir** `<scratchpad>/probe/workdir/`: `CLAUDE.md` containing the lines `` See `@quoted.md` for nothing. `` and `@plain.md`; files `quoted.md` and `plain.md` each with one line.
- [ ] **Step 4: Validate both probes**
  Run: `claude plugin validate .` in each probe dir. Expected: no errors.
- [ ] **Step 5: USER runs the probe** (interactive; a subagent cannot). From PowerShell in the workdir:
  `claude --plugin-dir <scratchpad>\probe\probe-a --plugin-dir <scratchpad>\probe\probe-b`
  Send one prompt (`hi`), answer whatever dialogs appear, then `/exit`. Report: the transcript's `probe-a …`/`probe-b …` lines, how many dialogs appeared and in what order, and whether any ask rejected. If `--plugin-dir` is not accepted, use a temporary local marketplace instead and say so.
- [ ] **Step 6: Record findings** as a new `## 11. Build findings (probe, <date>)` in `design.md`, answering exactly:
  1. Two simultaneous asks: queued / replaced / rejected → confirm strategy: *queued* → ask directly; *replaced or rejected* → `ASK_RETRY_DELAY_MS = 1500` and one retry.
  2. Un-awaited `$.model.complete` from `prompt.submit` resolves and is readable at `turn.complete`: yes / no → if no, capture awaits the call in a `$.clock.after(0, …)` callback started from `prompt.submit` instead.
  3. `quoted.md` in `instructionFiles`: no → `AT_STRATEGY = "codespan"`; yes → `AT_STRATEGY = "space"` (insert a space after `@`).
- [ ] **Step 7: Commit** `design.md` only: `docs(lessons-learned): probe findings`. Delete nothing in the scratchpad (it is session-temporary).

---

### Task 2: Scaffold the repo and the entries library

Model: sonnet · Effort: medium · Depends on: Task 1
Files: `.gitignore`, `.claude-plugin/marketplace.json`, `lessons-learned/.claude-plugin/plugin.json`, `lessons-learned/hooks/hooks.json`, `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tsconfig.json`, `lessons-learned/LICENSE`, `lessons-learned/hooks/lib/entries.mjs`, `lessons-learned/tests/entries.test.ts`

**Interfaces — Produces:**
```ts
type Entry = { id: string; title: string; tags: string[]; seen: number; first: string; last: string; body: string }
type Block = { kind: "entry"; entry: Entry } | { kind: "raw"; text: string }
type ParsedFile = { header: string; blocks: Block[]; eol: "\n" | "\r\n" }
type Kind = "lessons" | "rules";   type Scope = "global" | "project"
export const FILE_HEADERS: Record<Kind, string>
export const GENERIC_TAGS: Set<string>
export const AT_STRATEGY: "codespan" | "space"        // value from Task 1 finding 3
export function parseEntries(text: string): ParsedFile
export function serializeEntries(file: ParsedFile): string
export function emptyFile(kind: Kind): ParsedFile
export function entriesOf(file: ParsedFile): Entry[]
export function findEntry(file: ParsedFile, id: string): Entry | null
export function addEntry(file: ParsedFile, entry: Entry): ParsedFile
export function removeEntry(file: ParsedFile, id: string): { file: ParsedFile; entry: Entry | null }
export function replaceEntry(file: ParsedFile, entry: Entry): ParsedFile
export function nextId(scope: Scope, files: ParsedFile[]): string
export function bumpSeen(entry: Entry, today: string): Entry
export function cleanTitle(s: string): string
export function cleanBody(s: string): string
export function normaliseTags(tags: unknown): string[]
```

- [ ] **Step 1: Scaffold.**
  - `Mods/.gitignore`: `*/.claude-plugin/types/` and `node_modules/`.
  - `Mods/.claude-plugin/marketplace.json`: marketplace `name: "sunkanxx-mods"`, owner `Sunkanxx`, one plugin entry `{ name: "lessons-learned", source: "./lessons-learned", description: <plugin.json description> }`.
  - `plugin.json`: `name: "lessons-learned"`, `version: "0.1.0"`, `author: { name: "Sunkanxx" }`, `license: "MIT"`, description "Learns from your corrections: confirms each one, recalls the lesson when it is relevant again, and turns a repeated correction into a rule CLAUDE.md loads in every session.", `userConfig` `model` (string, default `haiku`), `ruleCap` (number, default 20), `maxRecall` (number, default 3) with one-line descriptions.
  - `hooks.json`: `{ "modules": ["./lessons-learned.mjs"] }`; `lessons-learned.mjs`: header comment + `export function register(on, options) {}`.
  - `tsconfig.json`: `{ "extends": "./.claude-plugin/types/tsconfig.json" }`; `LICENSE`: MIT, `Copyright (c) 2026 Sunkanxx`.
- [ ] **Step 2: Validate the scaffold.** Run `claude plugin validate .` in `lessons-learned/` and in `Mods/`. Expected: no errors (the types folder appears on first load).
- [ ] **Step 3: Write failing tests** in `tests/entries.test.ts`:
  - `parses an entry` — `"## P-012 · Use PowerShell\ntags: powershell, claude p · seen: 2 · first: 2026-10-07 · last: 2026-10-08\nBody text.\n"` → one entry `{ id: "P-012", title: "Use PowerShell", tags: ["powershell","claude p"], seen: 2, first: "2026-10-07", last: "2026-10-08", body: "Body text." }`.
  - `round-trips a file exactly` — header + 2 entries + one unparseable `## notes` block: `serializeEntries(parseEntries(t)) === t`.
  - `keeps malformed blocks verbatim` — a `## P-003 · x` block with a broken meta line stays a `raw` block and serialises unchanged.
  - `parses CRLF` / `keeps CRLF on serialise` — same input with `\r\n`; `eol === "\r\n"`; output uses `\r\n` only.
  - `round-trips non-ASCII` — title `Uporabi šumnike č š ž 🙂`, tag `šumniki`.
  - `separator-looking text stays inside one entry` — title `a · b`, body `x ## y tags: z` (after cleaning) → one entry, round-trips.
  - `nextId continues from the highest id across files` — lessons `P-002`, rules `P-007` → `nextId("project", [l, r]) === "P-008"`; empty → `"P-001"`; global → `"G-001"`; `P-1000` stays 4 digits.
  - `removeEntry returns the entry and a file without it`; `addEntry appends after the last block`; `replaceEntry keeps position`.
  - `bumpSeen` — seen +1, `last` = today, `first` unchanged.
  - `cleanTitle` — newlines → single spaces, leading `#`s stripped, markers `<!-- lessons-learned:start -->` / `:end -->` removed, 81+ chars → first 79 + `…` (length 80).
  - `cleanBody` — same rules at 400; with `AT_STRATEGY === "codespan"`: `see @a/b.md now` → ``see `@a/b.md` now``, text already inside backticks untouched; with `"space"`: `@a/b.md` → `@ a/b.md`. Test only the active strategy.
  - `normaliseTags` — `["Code","PowerShell"," powershell ","fix","slash-command","a","b","c","d"]` → `["powershell","slash-command","a","b","c"]` (lowercased, trimmed, generic dropped, deduped, max 5); non-array → `[]`.
- [ ] **Step 4: Run** `claude plugin test` in `lessons-learned/`. Expected: the new tests FAIL (module not found).
- [ ] **Step 5: Implement `hooks/lib/entries.mjs`.** Entry block format (spec §4.3): line 1 `## <id> · <title>`, line 2 `tags: <t1, t2> · seen: <n> · first: <date> · last: <date>`, then the body line. Parse: header = text before the first line starting `## `; a block runs to the next line starting `## `; it is an entry only if line 1 matches `^## ([GP]-\d{3,}) · (.+)$` (split on the **first** ` · `) and line 2 matches `^tags: (.*) · seen: (\d+) · first: (\d{4}-\d{2}-\d{2}) · last: (\d{4}-\d{2}-\d{2})$` (anchor on the **last** ` · seen: `); otherwise `raw` with its exact text. Detect `eol` from the first line break. Serialised entry is followed by one blank line. `GENERIC_TAGS` = `code, file, files, fix, bug, error, issue, change, changes, update, thing, work, task, project, repo, stuff`. `FILE_HEADERS`: lessons → `# Lessons learned\n\nCorrections confirmed once. Relevant ones are attached to prompts automatically; a repeat promotes one to rules-learned.md. Managed by the lessons-learned mod — edit freely, keep each entry's two first lines.\n`; rules → `# Rules learned\n\nCorrections made more than once. CLAUDE.md imports this file, so every rule applies in every session. Managed by the lessons-learned mod — edit freely, keep each entry's two first lines.\n`.
- [ ] **Step 6: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(lessons-learned): scaffold and entries library`.

---

### Task 3: CLAUDE.md block and scope paths

Model: sonnet · Effort: low · Depends on: Task 2 · Parallel with: Tasks 4, 5, 6
Files: `lessons-learned/hooks/lib/claude-md.mjs`, `lessons-learned/hooks/lib/paths.mjs`, `lessons-learned/tests/claude-md.test.ts`

**Interfaces — Produces:**
```ts
export const BLOCK_START = "<!-- lessons-learned:start -->"; export const BLOCK_END = "<!-- lessons-learned:end -->"
export function blockText(importPath: string, eol?: "\n" | "\r\n"): string
export function hasBlock(text: string | null): boolean
export function insertBlock(text: string | null, importPath: string): string
export function addIgnoreLines(text: string | null): string
export function pickClaudeMd(rootExists: boolean, dotClaudeExists: boolean): { rel: "CLAUDE.md" | ".claude/CLAUDE.md"; importPath: "rules-learned.md" | "../rules-learned.md" }
export function joinPath(base: string, ...parts: string[]): string
export function configDirFrom(env: { CLAUDE_CONFIG_DIR?: string; USERPROFILE?: string; HOME?: string }): string | null
export function scopeFiles(base: string): { lessons: string; rules: string }
```

- [ ] **Step 1: Write failing tests:**
  - `blockText` equals spec §4.2 exactly with `@rules-learned.md`; `blockText("../rules-learned.md")` has `@../rules-learned.md`.
  - `insertBlock(null, p)` → `blockText(p) + "\n"`; `insertBlock preserves existing text byte for byte` — `"# Mine\nno newline"` → original + `"\n\n"` + block + `"\n"` (exactly one blank line between); BOM kept at the start; `insertBlock keeps CRLF` — CRLF input → block written with CRLF; calling twice returns the first result unchanged.
  - `hasBlock` true only when both markers are present.
  - `addIgnoreLines(null)` → `"lessons-learned.md\nrules-learned.md\n"`; an existing file gets only the missing lines, once.
  - `pickClaudeMd` — (true,true) and (true,false) and (false,false) → root; (false,true) → `.claude/CLAUDE.md` + `../rules-learned.md`.
  - `configDirFrom` — `CLAUDE_CONFIG_DIR` wins; else `USERPROFILE` + `.claude` with `\`; else `HOME` + `/.claude`; none → `null`.
  - `joinPath("C:\\Users\\x", ".claude")` → `C:\Users\x\.claude`; `joinPath("/home/x", ".claude")` → `/home/x/.claude` (separator taken from `base`).
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement** `claude-md.mjs` (block, insert, ignore lines, pick) and `paths.mjs` (join, configDir, scopeFiles).
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): CLAUDE.md block and paths`.

---

### Task 4: Detector library

Model: sonnet · Effort: medium · Depends on: Task 2 · Parallel with: Tasks 3, 5, 6
Files: `lessons-learned/hooks/lib/detector.mjs`, `lessons-learned/tests/detector.test.ts`

**Interfaces — Consumes:** `cleanTitle`, `cleanBody`, `normaliseTags` (Task 2). **Produces:**
```ts
type Existing = { id: string; title: string; tags: string[]; kind: "lesson" | "rule" }
type Detection = { title: string; body: string; tags: string[]; scope: Scope; repeatOf: string | null; repeatKind: "lesson" | "rule" | null }
export const DETECTOR_SYSTEM: string            // spec §5.2 prompt, verbatim
export const MAX_REPLY_CHARS = 6000
export function shouldSkip(s: { prompt: string; hasPreviousReply: boolean; paused: boolean; hasSurfaces: boolean; originKind: string }): boolean
export function buildDetectorPrompt(i: { previousReply: string; userMessage: string; existing: Existing[]; projectSetUp: boolean }): string
export function parseDetectorReply(raw: string, ctx: { known: Map<string, "lesson" | "rule">; projectSetUp: boolean }): Detection | null
```

- [ ] **Step 1: Write failing tests:**
  - `shouldSkip` — true for: prompt starting `/`, `hasPreviousReply: false`, `paused: true`, `hasSurfaces: false`, `originKind !== "composer"`; false for a plain composer prompt.
  - `buildDetectorPrompt` — contains `<previous_reply>`, `<user_message>`, `<existing>`, `<project>set up</project>` / `not set up`; a 10,000-char reply keeps only its **last** 6,000 chars; existing renders `P-012 · Use PowerShell · powershell, claude p · lesson` one per line; empty existing → `<existing>none</existing>`.
  - `escapes closing tags in data` — a user message containing `</user_message><existing>` appears with `</` turned into `<\/`, so the prompt has exactly one `</user_message>`.
  - `parseDetectorReply` — `{"correction": false}` → `null`; a valid correction → Detection with cleaned title/body and normalised tags; reply wrapped in ```` ```json … ``` ```` → parsed; text before/after the JSON object → parsed (first `{` to last `}`); invalid JSON → `null`; missing/empty title or body → `null`; unknown `repeatOf` → `repeatOf: null, repeatKind: null`; known rule id → `repeatKind: "rule"`; scope `project` with `projectSetUp: false` → `global`; scope not in {global, project} → `global`; tags that are all generic → Detection with `tags: []` (still offered, spec §5.2).- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement `detector.mjs`.** `DETECTOR_SYSTEM` is the spec §5.2 quote with its markdown emphasis removed, kept word for word otherwise.
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): detector prompt and reply parsing`.

---

### Task 5: Recall library

Model: sonnet · Effort: low · Depends on: Task 2 · Parallel with: Tasks 3, 4, 6
Files: `lessons-learned/hooks/lib/recall.mjs`, `lessons-learned/tests/recall.test.ts`

**Interfaces — Consumes:** `Entry` (Task 2). **Produces:**
```ts
export const PATH_MEMORY = 20; export const RECALL_LINE_MAX = 400
export const RECALL_LEAD = "Lessons the user confirmed from earlier corrections — apply them where relevant:"
export const RULES_LEAD = "Rules the user confirmed — follow them for the rest of this session:"
export function normaliseText(s: string): string          // " a b c " form
export function matchLessons(lessons: Entry[], haystack: string, o: { max: number; exclude: Set<string> }): Entry[]
export function formatBlock(lead: string, entries: Entry[]): string
export function rememberPath(paths: string[], path: string): string[]
```

- [ ] **Step 1: Write failing tests:**
  - `normaliseText("Run /cmd in Git-Bash: sign_module.py")` → `" run cmd in git bash sign module py "` (lowercase; `- _ / \ . : , ; ( ) [ ] { } " ' \`` → space; whitespace collapsed; one leading and trailing space).
  - `matches on two tags` — tags `["powershell","quoting"]`, haystack with both → matched; with one → not.
  - `matches on one multi-word tag` — tag `slash-command`, haystack `"the slash command broke"` → matched.
  - `matches non-ASCII tags` — tag `šumniki` in `"popravi šumniki"` → matched.
  - `ranks by hits then last` and `caps at max`; `exclude` ids never returned.
  - `formatBlock` — lead line then `- P-012 Use PowerShell: Body.` per entry; a line over 400 chars cut to 399 + `…`; empty list → `""`.
  - `rememberPath` — newest last, deduped (re-adding moves it to the end), max 20.
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement `recall.mjs`.** Tag hit = `normaliseText(text).includes(normaliseText(tag))` (both carry the surrounding spaces); multi-word = normalised tag contains an inner space.
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): recall matching`.

---

### Task 6: Confirmation library

Model: sonnet · Effort: medium · Depends on: Task 2 · Parallel with: Tasks 3, 4, 5
Files: `lessons-learned/hooks/lib/confirm.mjs`, `lessons-learned/tests/confirm.test.ts`

**Interfaces — Consumes:** `Entry` (Task 2), `Detection` (Task 4, type only). **Produces:**
```ts
type QueueItem = { key: string; detection: Detection; repoRoot: string | null; dismissed: number; createdAt: string }
type Dialog = { kind: "new" | "repeatLesson" | "repeatRule"; question: string; options: string[]; header: "Lesson" }
type Action =
  | { type: "save"; scope: Scope; body?: string }      // body set when edited via Other
  | { type: "promote"; id: string } | { type: "note"; id: string } | { type: "skip" }
export function dialogFor(item: QueueItem, ctx: { projectAvailable: boolean; target: Entry | null }): Dialog
export function interpret(answer: string, item: QueueItem, dialog: Dialog): Action
export function onDismiss(item: QueueItem): { item: QueueItem; toReview: boolean }
export function capDialog(scope: Scope, rules: Entry[]): { question: string; options: string[]; candidates: string[] }
export function interpretCap(answer: string, rules: Entry[], candidates: string[]): string | null
export function offerable(item: QueueItem, repoRoot: string | null): boolean
```

- [ ] **Step 1: Write failing tests** (labels are exact copy from spec §5.3):
  - `new lesson dialog` — question `Lesson: "Use PowerShell" (project). Save it?`, options `["Save","Save as global","Skip"]`; global detection → `["Save","Save to project","Skip"]`; `projectAvailable: false` → `["Save","Skip"]`.
  - `repeat of a lesson` — `Looks like a repeat of P-012 "Use PowerShell". Promote it to a rule?`, `["Promote to rule","Save as new","Skip"]`. `target: null` (entry gone since detection) → falls back to the new-lesson dialog.
  - `repeat of a rule` — `Rule P-003 "X" was broken again. Note it?`, `["Note it","Skip"]`.
  - `interpret` — each label → its action (`Save` → item scope; `Save as global` → global; `Save as new` → save in item scope; `Promote to rule` → promote target id); any other non-empty text → `save` with `body` = that text in the item's scope; whitespace-only → `skip`.
  - `onDismiss` — first → `dismissed: 1, toReview: false`; second → `toReview: true`.
  - `capDialog` — 20 rules → question `<Project|Global> already has 20 rules. Which one goes back to lessons?`, options = 3 candidates (lowest `seen`, then oldest `last`) as `P-004 <title ≤ 40 chars>` + `"Cancel promotion"`; `interpretCap` maps a candidate label → its id, a typed id (`p-009`, case-insensitive) present in rules → that id, `Cancel promotion` or unknown → `null`.
  - `offerable` — global item always; project item only when `repoRoot` equals the item's.
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement `confirm.mjs`.**
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): confirmation dialogs`.

---

### Task 7: Setup hook, file IO and the shared test world

Model: sonnet · Effort: high · Depends on: Task 3
Files: `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tests/world.ts`, `lessons-learned/tests/setup.test.ts`

**Interfaces — Consumes:** Tasks 2, 3. **Produces** (top-level functions in `lessons-learned.mjs`; later tasks add to this file):
```ts
async function context($): Promise<{ today: string; configDir: string | null; repoRoot: string | null; project: null | { claudeMd: string; importPath: string; setUp: boolean } }>
async function readScope($, scope: Scope): Promise<{ lessons: ParsedFile; rules: ParsedFile; paths: { lessons: string; rules: string } } | null>
async function updateFile($, path: string, kind: Kind, mutate: (f: ParsedFile) => ParsedFile): Promise<void>   // re-reads just before writing
async function ensureGlobal($): Promise<void>
async function offerProjectSetup($, { force }: { force: boolean }): Promise<void>
// store keys
const KEY_GLOBAL_DONE = "globalSetupDone", KEY_QUEUE = "queue", KEY_REVIEW = "review"; const optOutKey = (root) => `optOut:${root}`
```
`tests/world.ts` exports `world(on, opts)` that stubs `fs.read/write/exists`, `env.get` (via `mock.env`), `session.repo/messages/surfaces/id`, `store.*` (via `mock.store`), `ui.ask` (scripted answers or rejection), `ui.log`, `model.complete` (scripted reply, delay or failure), `clock` (via `mock.clock`) and records writes, asks, logs and model calls — a small in-memory test world: each stub answers `{ value }`, and the world records what the mod did so a test can assert on it.

- [ ] **Step 1: Write `tests/world.ts`** with an in-memory `files: Map<string,string>` and the recorders above.
- [ ] **Step 2: Write failing tests** in `tests/setup.test.ts`:
  - `creates global files and block on first start` — empty fs, `USERPROFILE=C:\Users\u` → writes `C:\Users\u\.claude\lessons-learned.md` (`FILE_HEADERS.lessons`), `…\rules-learned.md`, `…\CLAUDE.md` = `insertBlock(null,"rules-learned.md")`; no ask.
  - `respects CLAUDE_CONFIG_DIR`; `leaves an existing global CLAUDE.md intact apart from the block`; `second start writes nothing`.
  - `recreates a deleted global file` and `re-inserts a removed global block`.
  - `asks once per repo` — repo `C:\r`, no block → one ask `Set up lessons-learned for this project? It adds two files next to CLAUDE.md and one import line.` with `["Yes, commit them","Yes, keep out of git","Not here"]`.
  - `Yes, commit them` → files at repo root + block in `C:\r\CLAUDE.md`; `.gitignore` untouched. `Yes, keep out of git` → also `addIgnoreLines` on `C:\r\.gitignore`. `.claude/CLAUDE.md` only → block there with `@../rules-learned.md`.
  - `Not here` → stores `optOut:C:\r`; next start asks nothing; `offerProjectSetup($,{force:true})` asks again.
  - `dismissed setup ask` → nothing stored, asks again next session.
  - `no surfaces` → global setup still runs, no project ask. `not a git repo` (`session.repo` → null) → no project ask.
  - `fs failure` (write rejects) → no throw; one debug log.
- [ ] **Step 3: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 4: Implement** `register(on, options)` with the `session.start` hook calling `ensureGlobal` then (when surfaces exist and not opted out and project not set up) `offerProjectSetup`, plus the functions in the Interfaces block. Config: `const cfg = { model: options?.model || "haiku", ruleCap: Number(options?.ruleCap) || 20, maxRecall: Number(options?.maxRecall) || 3 }`. Missing files are created with `FILE_HEADERS`; `context().project.setUp` = the chosen CLAUDE.md `hasBlock`.
- [ ] **Step 5: Run** `claude plugin test` and `claude plugin validate .`. Expected: PASS, no errors.
- [ ] **Step 6: Commit** `feat(lessons-learned): setup on session start`.

---

### Task 8: Capture and confirmation hooks

Model: opus · Effort: high · Depends on: Tasks 1, 4, 6, 7
Files: `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tests/capture.test.ts`

**Interfaces — Consumes:** `shouldSkip`, `buildDetectorPrompt`, `parseDetectorReply`, `DETECTOR_SYSTEM` (Task 4); `dialogFor`, `interpret`, `onDismiss`, `capDialog`, `interpretCap`, `offerable` (Task 6); `context`, `readScope`, `updateFile`, store keys (Task 7). **Produces:**
```ts
let paused = false; let pendingDetection: Promise<QueueItem | null> | null = null; let promotedThisSession: Entry[] = []
async function startCapture($, e): Promise<void>        // never awaits the model
async function runConfirm($): Promise<void>             // turn.complete
async function applyAction($, item: QueueItem, action: Action): Promise<void>
async function promote($, scope: Scope, id: string): Promise<boolean>   // cap dialog inside; pushes to promotedThisSession
```

- [ ] **Step 1: Write failing tests** in `tests/capture.test.ts` (use `world`):
  - `skips without a model call` — slash command, no previous assistant message, paused, no surfaces, non-composer origin: `model.complete` never called.
  - `does not delay the prompt` — model stub delays 3,000 ms; `prompt.submit` resolves before the model call does (clock-controlled).
  - `calls the configured model` — `options.model = "sonnet"` → request `{ model: "sonnet", system: DETECTOR_SYSTEM, maxTokens: 400 }`; prompt built from the last assistant message's text in `session.messages`.
  - `saves on Save` — detection `scope: project` → ask `Lesson: "…" (project). Save it?`; answer `Save` → `C:\r\lessons-learned.md` gains `P-001` with `seen: 1`, `first`/`last` = today.
  - `Other text replaces the body` and goes through `cleanBody`.
  - `Save as global` → entry `G-001` in the global lessons file.
  - `promotes a repeat` — existing lesson `P-004`; detection `repeatOf: "P-004"`; answer `Promote to rule` → removed from lessons, appended to rules with `seen` +1; `promotedThisSession` holds it.
  - `cap dialog on promote` — rules file has 20 entries → second ask; picking a candidate moves it to lessons and the promotion proceeds; `Cancel promotion` leaves both files unchanged.
  - `notes a broken rule` — `repeatOf` a rule → `Note it` → rule `seen` +1, `last` today.
  - `dismiss then review` — ask rejects → item stays in `queue` with `dismissed: 1`; next turn end asks again; rejects again → moved to `review`, removed from `queue`.
  - `queue survives a session` — item in stored `queue` from a previous session is offered at the first turn end; a project item is not offered in another repo.
  - `waits at most 5 s` — detection resolves after 6 s → no ask this turn; it is in `queue` and asked at the next turn end.
  - `model failure leaves no trace` — model rejects / returns `not json` → no ask, no write, only debug logs.
  - `one ask per turn end` — two queued items → one ask; the second at the next turn end.
  - `aborted turn keeps the queue` — `turn.complete` with reason `aborted` → no ask; the item is asked at the next `answer` turn end.
  - Plus the concurrency handling chosen in Task 1 finding 1 (if retry: `rejects once → retries after 1,500 ms`).
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement** the `prompt.submit` hook (call `startCapture`, then `return next(e)`), `turn.complete` hook (`runConfirm` after `next(e)`, only for reason `answer`; an `aborted` turn keeps the queue for the next answered turn, spec §8), and the functions above, following Task 1 findings 1 and 2. Queue item `key` = session id + turn count. Entries get ids from `nextId(scope, [lessons, rules])` at save time, not at detection time.
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): capture and confirmation`.

---

### Task 9: Recall and path-tracker hooks

Model: sonnet · Effort: medium · Depends on: Tasks 5, 8
Files: `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tests/recall-hooks.test.ts`

**Interfaces — Consumes:** `matchLessons`, `formatBlock`, `RECALL_LEAD`, `RULES_LEAD`, `rememberPath` (Task 5); `promotedThisSession` (Task 8). **Produces:** `let recentPaths: string[]`, `let recalled = { sessionId: "", ids: new Set<string>() }`, `async function recallContext($, e): Promise<string[]>`.

- [ ] **Step 1: Write failing tests:**
  - `attaches matching lessons` — global lesson tags `powershell, quoting`, prompt `fix the powershell quoting` → `prompt.submit` passes down `context` containing `formatBlock(RECALL_LEAD, [that lesson])`, after any context already on `e`.
  - `uses touched paths` — a prior `tool.call` `Edit` on `C:\r\tools\sign_module.py`; lesson tags `["sign module", "signing"]` (one multi-word hit) → attached for the prompt `go on`.
  - `at most maxRecall` (config 2 → 2); `no repeat within a session`; `new session id resets`; `session.compact resets`.
  - `attaches promoted rules once` — after a promotion, the next prompt carries `formatBlock(RULES_LEAD, [rule])`, the one after does not.
  - `recall runs without surfaces` and `while paused`; `no lessons files → no context, no error`.
  - `tracker ignores tools other than Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob` and records `file_path` / `path` / `notebook_path` inputs only.
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement** recall inside the existing `prompt.submit` hook (`return next({ ...e, context: [...(e.context ?? []), ...blocks] })`), a `tool.call` hook (record path, then `return next(e)`), and a `session.compact` hook (reset `recalled.ids`, then `return next(e)`).
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons-learned): recall by tag`.

---

### Task 10: `/lessons` command

Model: sonnet · Effort: medium · Depends on: Task 9
Files: `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tests/commands.test.ts`

**Interfaces — Consumes:** Tasks 2, 6, 7, 8. **Produces:** `$.command.register({ name: "lessons", description: "Learned lessons and rules: list, review, promote, demote, delete, setup, pause, resume", argumentHint: "[review|promote <id>|demote <id>|delete <id>|setup|pause|resume]" })` in `session.start`; `on("command.run", { command: "lessons" }, …)`.

- [ ] **Step 1: Write failing tests:**
  - `/lessons` output: `Global: 2 rules, 5 lessons · Project: 1 rule, 3 lessons · 1 to review`, then sections `Rules` and `Lessons`, one line `P-004 · Use PowerShell · seen 2` each; no project → no project counts.
  - `promote P-004` (cap dialog when full) / `demote P-003` (rule → lessons) / unknown id → `No entry P-099.`; ids are case-insensitive.
  - `delete G-002` asks `Delete G-002 "…"?` with `["Delete","Keep"]`; `Delete` removes it; dismissed → nothing.
  - `review` walks the `review` list with `dialogFor`/`interpret`, one ask per item, removing answered items; empty → `Nothing to review.`
  - `setup` → `offerProjectSetup($, { force: true })`; outside a repo → `Not in a git repository.`
  - `pause` / `resume` toggle `paused` and reply `Capture paused for this session.` / `Capture resumed.`
  - unknown subcommand → the usage line.
- [ ] **Step 2: Run** `claude plugin test`. Expected: FAIL.
- [ ] **Step 3: Implement** the command (reusing `promote`, `applyAction`, `updateFile`).
- [ ] **Step 4: Run** `claude plugin test` and `claude plugin validate .`. Expected: PASS, no errors.
- [ ] **Step 5: Commit** `feat(lessons-learned): /lessons command`.

---

### Task 11: Detector eval

Model: sonnet · Effort: medium · Depends on: Task 10
Files: `lessons-learned/eval/cases.json`, `lessons-learned/hooks/lessons-learned.mjs`, `lessons-learned/tests/eval.test.ts`, `lessons-learned/docs/design.md` (§9 item 5 wording)

Amendment to spec §9.5: the eval runs as `/lessons eval` inside Claude Code (same `$.model.complete` path and credentials as real capture) instead of `npm run eval`, which would need a separate API key.

- [ ] **Step 1: Write `eval/cases.json`** — 30 cases `{ id, previousReply, userMessage, expect: "correction" | "none" }`: 15 corrections (preferences, conventions, environment facts, skipped process steps; 3 in Slovenian) and 15 look-alikes including `B`, `yes`, `use the other file`, `actually make it blue`, `thanks, perfect`, `now add tests`, `why did you do that?` (question, not correction), a pasted error log.
- [ ] **Step 2: Write failing test** `eval reports false positives` — stubbed model answering `correction: true` for every case → output contains `False positives: 15/15` and lists the ids; all-false stub → `Detected: 0/15`.
- [ ] **Step 3: Implement** `/lessons eval`: reads `${$.plugin.root}/eval/cases.json`, runs cases sequentially with the configured model, prints `Detected: n/15 · False positives: m/15` plus the false-positive and missed ids.
- [ ] **Step 4: Run** `claude plugin test`. Expected: PASS.
- [ ] **Step 5: Run the real eval** (PowerShell, Git Bash rewrites `/cmd`): `claude -p "/lessons eval"` with the plugin loaded via `--plugin-dir`. Expected: `False positives: 0/15`. If not, tune `DETECTOR_SYSTEM` wording only (spec §5.2 allows wording, not meaning), rerun Task 4 tests, repeat. Record the final score in design.md §11.
- [ ] **Step 6: Commit** `feat(lessons-learned): detector eval`.

---

### Task 12: READMEs and local install check

Model: sonnet · Effort: medium · Depends on: Task 11
Files: `Mods/README.md`, `lessons-learned/README.md`

- [ ] **Step 1: Write `lessons-learned/README.md`:** what it does (lesson → rule), install (`claude plugin marketplace add Sunkanxx/Mods`, `claude plugin install lessons-learned@sunkanxx-mods`), the files it creates and the `CLAUDE.md` block, the setup choices (commit vs keep out of git, and why it matters in team repos), `/lessons` reference, `/config` options, **Privacy** (spec §7 last paragraph, verbatim meaning), the tested Claude Code version (`claude --version` output), `/lessons eval` for contributors, licence.
- [ ] **Step 2: Write `Mods/README.md`:** one paragraph on the marketplace, the add command, a table of mods (one row: lessons-learned).
- [ ] **Step 3: Validate** `claude plugin validate .` in `Mods/` and `lessons-learned/`; `claude plugin test`. Expected: no errors, all PASS.
- [ ] **Step 4: USER local install check:** `claude plugin marketplace add <path-to-your-clone>`, `claude plugin install lessons-learned@sunkanxx-mods`, restart, then in a scratch git repo: setup ask appears; make and repeat a correction; confirm the lesson, then the promotion; restart and check `rules-learned.md` is loaded (ask Claude to list its learned rules). Report anything off.
- [ ] **Step 5: Commit** `docs(lessons-learned): READMEs`.

---

### Task 13: Whole-branch review

Model: opus · Effort: high · Depends on: Task 12
Files: none (review only; fixes go back to the owning task's files)

- [ ] **Step 1:** Review the whole repo against `design.md` and this plan's Global Constraints and Review Focus: standalone (grep for personal names, private project names and other plugins' names — expected no hits), every `$` call in the entry module, no awaited model call in `prompt.submit`, cleaning applied on every write path (save, edit-as-Other, review), no file written outside the two scope bases plus `.gitignore`.
- [ ] **Step 2:** Run `claude plugin validate .` and `claude plugin test`. Expected: clean.
- [ ] **Step 3:** Report findings; fix confirmed ones in a `fix(lessons-learned): …` commit.

---

## Spec amendments made by this plan

- §5.5 / §8 "temp file + rename": the mod API has `$.fs.write` but no rename or delete, so writes are **re-read just before writing, then one `$.fs.write` of the whole file**. The race window remains milliseconds; no temp file is left behind.
- §5.2 "subagent turns are ignored": capture runs only for `origin.kind === "composer"` (the user's own Enter at the terminal). Prompts from Remote Control, channels or plugins are not captured; recall still runs for them.
- §9.5: eval runs as `/lessons eval` (Task 11).
- §5.4 "reset on compaction and `/clear`": implemented as reset on `session.compact` and whenever `$.session.id()` changes.
