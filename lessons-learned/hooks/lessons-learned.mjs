// lessons-learned: confirms each correction, recalls the lesson when it is
// relevant again, and promotes a repeated correction to a rule.
//
// The engine reads on(...) and $.noun.method(...) from this source: they stay spelled
// out, and every function that takes $ lives at the top level. Every failure (file,
// model, parse) degrades to "do nothing" and is logged only to the debug log.

import {
  parseEntries, serializeEntries, emptyFile, FILE_HEADERS,
  addEntry, removeEntry, replaceEntry, findEntry, entriesOf, nextId, bumpSeen, cleanBody,
} from "./lib/entries.mjs";
import { hasBlock, insertBlock, addIgnoreLines, pickClaudeMd } from "./lib/claude-md.mjs";
import { joinPath, configDirFrom, scopeFiles, selfAndParents } from "./lib/paths.mjs";
import { DETECTOR_SYSTEM, shouldSkip, buildDetectorPrompt, parseDetectorReply } from "./lib/detector.mjs";
import { matchLessons, formatBlock, RECALL_LEAD, RULES_LEAD, rememberPath } from "./lib/recall.mjs";
import { HEADER, dialogFor, interpret, onDismiss, capDialog, interpretCap, offerable } from "./lib/confirm.mjs";

export const KEY_QUEUE = "queue";
export const KEY_REVIEW = "review";
export const optOutKey = (root) => `optOut:${root}`;

const SETUP_QUESTION =
  "Set up lessons-learned for this project? It adds two files next to CLAUDE.md and one import line.";
const YES_COMMIT = "Yes, commit them";
const YES_IGNORE = "Yes, keep out of git";
const NOT_HERE = "Not here";
const GLOBAL_IMPORT = "rules-learned.md";

const DETECTOR_MAX_TOKENS = 400;
const DETECTION_WAIT_MS = 5000;
const ALREADY_OPEN = "A lesson dialog is already open.";
// withAsk's answer while another dialog of this mod is open; ask's answer for a closed dialog.
const BUSY = Symbol("busy");
const DISMISSED = Symbol("dismissed");

// Set by register(); later hooks read it.
let cfg = { model: "haiku", ruleCap: 20, maxRecall: 3 };

// Session-only state (spec §4.4). paused: capture is off (/lessons pause).
// pendingDetection: the detector call of the latest prompt, resolving to its queued item (or
// null) once the item is in the queue. asking: one of this mod's dialogs is open, or a turn-end
// confirmation is waiting for its detection (see withAsk).
let paused = false;
let pendingDetection = null;
let asking = false;
export let promotedThisSession = [];
// Recall state: file paths the session touched lately, and the lessons already attached.
let recentPaths = [];
let recalled = { sessionId: "", ids: new Set() };

const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob"]);

// Store lists are read, changed and written one change at a time.
let listChain = Promise.resolve();

// Test hook: tests set the pause flag of their own module instance directly.
export function setPaused(value) {
  paused = !!value;
}

export function register(on, options) {
  cfg = {
    model: options?.model || "haiku",
    ruleCap: Number(options?.ruleCap) || 20,
    maxRecall: Number(options?.maxRecall) || 3,
  };
  pendingDetection = null;
  asking = false;
  promotedThisSession = [];
  recentPaths = [];
  recalled = { sessionId: "", ids: new Set() };
  listChain = Promise.resolve();

  on("prompt.submit", async ($, e, next) => {
    try {
      await startCapture($, e);
    } catch (err) {
      debug($, `capture failed: ${err?.message ?? err}`);
    }
    // Recall adds no wait beyond the file reads; a failure sends the prompt on without blocks.
    let blocks = [];
    try {
      blocks = await recallContext($, e);
    } catch (err) {
      debug($, `recall failed: ${err?.message ?? err}`);
    }
    return next(blocks.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...blocks] });
  }).catch(($, e, next) => {
    // The hook threw or overran its time: the prompt still enters, untouched.
    debug($, `prompt hook failed (${next.error?.kind}): ${next.error?.message ?? ""}`);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    try {
      trackPath(e);
    } catch (err) {
      debug($, `path tracking failed: ${err?.message ?? err}`);
    }
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    const out = await next(e);
    // Only a compaction of the main conversation that went through drops what was attached.
    if (!e.agentId && e.trigger !== "precompute" && !out?.skip) {
      recalled = { sessionId: recalled.sessionId, ids: new Set() };
    }
    return out;
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    // Not awaited here, as with the setup dialog: an open dialog must not hold the engine.
    // An interrupted turn keeps the queue for the next answered one (spec §8).
    if (e.reason === "answer" && !e.agentId) $.clock.after(0, () => void confirmLater($));
    return done;
  });

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    try {
      await $.command.register({
        name: "lessons",
        description: "Learned lessons and rules: list, review, promote, demote, delete, setup, pause, resume, eval",
        argumentHint: "[review|promote <id>|demote <id>|delete <id>|setup|pause|resume|eval]",
      });
    } catch (err) {
      debug($, `command not registered: ${err?.message ?? err}`);
    }
    try {
      await ensureGlobal($);
    } catch (err) {
      debug($, `global setup failed: ${err?.message ?? err}`);
    }
    // Not awaited here: the engine holds the first prompt until session.start resolves,
    // and a dialog the user leaves open must not do that.
    $.clock.after(0, () => void offerProjectSetupLater($));
    return started;
  });

  on("command.run", { command: "lessons" }, async ($, e) => {
    try {
      return { text: await runCommand($, String(e.args ?? "")) };
    } catch (err) {
      debug($, `command failed: ${err?.message ?? err}`);
      return { text: "lessons-learned could not do that. See the debug log." };
    }
  });
}

async function offerProjectSetupLater($) {
  try {
    // Another dialog of this mod is open: the setup question comes again at the next start.
    if ((await offerProjectSetup($, { force: false })) === BUSY) debug($, "setup question deferred: a dialog is open");
  } catch (err) {
    debug($, `project setup failed: ${err?.message ?? err}`);
  }
}

function debug($, text) {
  $.ui.log(`lessons-learned: ${text}`, { to: "debug" });
}

// One dialog of this mod at a time, across turn ends, /lessons and project setup: runs fn
// holding the flag, or answers BUSY without running it when another holds it.
async function withAsk(fn) {
  if (asking) return BUSY;
  asking = true;
  try {
    return await fn();
  } finally {
    asking = false;
  }
}

// Asks with the mod's header; DISMISSED when the dialog is closed or nobody can answer.
async function ask($, question, options, what) {
  try {
    return await $.ui.ask(question, { options, header: HEADER });
  } catch (err) {
    debug($, `${what} not answered: ${err?.message ?? err}`);
    return DISMISSED;
  }
}

// The text of a file, or null when it does not exist. Rejects when it cannot be read.
async function readText($, path) {
  if (!(await $.fs.exists(path))) return null;
  return await $.fs.read(path);
}

export async function context($) {
  // Dates are UTC by design.
  const now = await $.clock.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const configDir = configDirFrom({
    CLAUDE_CONFIG_DIR: await $.env.get("CLAUDE_CONFIG_DIR"),
    USERPROFILE: await $.env.get("USERPROFILE"),
    HOME: await $.env.get("HOME"),
  });
  const repo = await $.session.repo();
  const repoRoot = repo ? await workingTreeRoot($, repo.root) : null;
  let project = null;
  if (repoRoot) {
    const rootMd = joinPath(repoRoot, "CLAUDE.md");
    const dotMd = joinPath(repoRoot, ".claude", "CLAUDE.md");
    const pick = pickClaudeMd(await $.fs.exists(rootMd), await $.fs.exists(dotMd));
    const claudeMd = pick.rel === "CLAUDE.md" ? rootMd : dotMd;
    let setUp = false;
    try {
      setUp = hasBlock(await readText($, claudeMd));
    } catch (err) {
      debug($, `cannot read ${claudeMd}: ${err?.message ?? err}`);
    }
    project = { claudeMd, importPath: pick.importPath, setUp };
  }
  return { today, configDir, repoRoot, project };
}

// The git root of the session's own working tree (spec §4.1): the nearest folder at or above
// the working directory that holds `.git` (a folder, or a file in a worktree). session.repo()
// names the main checkout even in a worktree, so it is only the fallback.
async function workingTreeRoot($, mainRoot) {
  try {
    for (const dir of selfAndParents(await $.session.cwd())) {
      if (await $.fs.exists(joinPath(dir, ".git"))) return dir;
    }
  } catch (err) {
    debug($, `working tree root not found: ${err?.message ?? err}`);
  }
  return mainRoot;
}

export async function readScope($, scope) {
  try {
    const ctx = await context($);
    const base = scope === "global" ? ctx.configDir : ctx.project?.setUp ? ctx.repoRoot : null;
    if (!base) return null;
    const paths = scopeFiles(base);
    const lessons = parseEntries((await readText($, paths.lessons)) ?? serializeEntries(emptyFile("lessons")));
    const rules = parseEntries((await readText($, paths.rules)) ?? serializeEntries(emptyFile("rules")));
    return { lessons, rules, paths };
  } catch (err) {
    debug($, `cannot read ${scope} scope: ${err?.message ?? err}`);
    return null;
  }
}

// Re-reads just before the single whole-file write, so a parallel session's change survives.
export async function updateFile($, path, kind, mutate) {
  const text = await readText($, path);
  const file = text === null ? emptyFile(kind) : parseEntries(text);
  await $.fs.write(path, serializeEntries(mutate(file)));
}

// Creates the lessons and rules files of a scope when they are missing.
async function ensureFiles($, base) {
  const paths = scopeFiles(base);
  if (!(await $.fs.exists(paths.lessons))) await $.fs.write(paths.lessons, FILE_HEADERS.lessons + "\n");
  if (!(await $.fs.exists(paths.rules))) await $.fs.write(paths.rules, FILE_HEADERS.rules + "\n");
}

// Skipped when nobody can answer (a -p run), as project setup is (spec §8).
export async function ensureGlobal($) {
  if ((await $.session.surfaces()).length === 0) return;
  const { configDir } = await context($);
  if (!configDir) return;
  await ensureFiles($, configDir);
  const claudeMd = joinPath(configDir, "CLAUDE.md");
  const text = await readText($, claudeMd);
  if (!hasBlock(text)) await $.fs.write(claudeMd, insertBlock(text, GLOBAL_IMPORT));
}

// Resolves to BUSY, without asking, when another dialog of this mod is open.
export async function offerProjectSetup($, { force }) {
  const { repoRoot, project } = await context($);
  if (!repoRoot || !project) return;
  if ((await $.session.surfaces()).length === 0) return;
  if (!force && (await $.store.get(optOutKey(repoRoot)))) return;
  if (project.setUp) {
    await ensureFiles($, repoRoot);
    return;
  }
  const answer = await withAsk(() => ask($, SETUP_QUESTION, [YES_COMMIT, YES_IGNORE, NOT_HERE], "setup question"));
  if (answer === BUSY) return BUSY;
  if (answer === NOT_HERE) {
    await $.store.set(optOutKey(repoRoot), true);
    return;
  }
  if (answer !== YES_COMMIT && answer !== YES_IGNORE) return;
  await ensureFiles($, repoRoot);
  if (answer === YES_IGNORE) {
    const gitignore = joinPath(repoRoot, ".gitignore");
    await $.fs.write(gitignore, addIgnoreLines(await readText($, gitignore)));
  }
  // The block goes last: with it present the project counts as set up.
  await $.fs.write(project.claudeMd, insertBlock(await readText($, project.claudeMd), project.importPath));
  await $.store.delete(optOutKey(repoRoot));
}

// ---------- capture (spec §5.2) ----------

// The text of the latest assistant message that has any, or null.
function lastReply(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && typeof m.text === "string" && m.text.trim() !== "") return m.text;
  }
  return null;
}

// Reads what belongs to this submission, then starts the detector in the background:
// the prompt never waits for the model (or for the lesson files the detector is shown).
export async function startCapture($, e) {
  // A skipped prompt leaves no older prompt's detection behind as this turn's.
  pendingDetection = null;
  const prompt = String(e?.text ?? "");
  const base = { prompt, paused, originKind: e?.origin?.kind, hasPreviousReply: true, hasSurfaces: true };
  if (shouldSkip(base)) return;
  const hasSurfaces = (await $.session.surfaces()).length > 0;
  const previousReply = hasSurfaces ? lastReply(await $.session.messages()) : null;
  if (shouldSkip({ ...base, hasSurfaces, hasPreviousReply: previousReply !== null })) return;
  const key = `${await $.session.id()}:${await $.session.turns()}`;
  pendingDetection = detect($, { prompt, previousReply, key });
}

// Every entry of both scopes, as the detector sees them; a scope that cannot be read adds none.
async function existingEntries($) {
  const existing = [];
  for (const scope of ["global", "project"]) {
    const s = await readScope($, scope);
    if (!s) continue;
    for (const [kind, file] of [["lesson", s.lessons], ["rule", s.rules]]) {
      for (const { id, title, tags } of entriesOf(file)) existing.push({ id, title, tags, kind });
    }
  }
  return existing;
}

// One detector request, the same for capture and for `/lessons eval`; resolves to the reply text.
async function askDetector($, { previousReply, userMessage, existing, projectSetUp }) {
  const reply = await $.model.complete({
    model: cfg.model,
    system: DETECTOR_SYSTEM,
    prompt: buildDetectorPrompt({ previousReply, userMessage, existing, projectSetUp }),
    maxTokens: DETECTOR_MAX_TOKENS,
  });
  return typeof reply === "string" ? reply : reply?.text;
}

// The detector call, parsed and queued. Never rejects: any failure is "no correction".
async function detect($, { prompt, previousReply, key }) {
  try {
    const ctx = await context($);
    const projectSetUp = !!ctx.project?.setUp;
    const existing = await existingEntries($);
    const known = new Map(existing.map((x) => [x.id, x.kind]));
    const detection = parseDetectorReply(
      await askDetector($, { previousReply, userMessage: prompt, existing, projectSetUp }),
      { known, projectSetUp },
    );
    if (!detection) return null;
    // A repeat of a P- entry belongs to this repo whatever scope the detector gave: offered
    // in another repo it would act on that repo's unrelated P- entry.
    const project = detection.scope === "project" || !!detection.repeatOf?.startsWith("P-");
    const item = {
      key,
      detection: project ? { ...detection, scope: "project" } : detection,
      repoRoot: project ? ctx.repoRoot : null,
      dismissed: 0,
      createdAt: ctx.today,
    };
    let queued = null;
    await updateList($, KEY_QUEUE, (queue) => {
      queued = withUniqueKey(item, queue);
      return [...queue, queued];
    });
    return queued;
  } catch (err) {
    debug($, `detector failed: ${err?.message ?? err}`);
    return null;
  }
}

// Two prompts can share a turn count (one typed while a turn runs): keep keys apart.
function withUniqueKey(item, queue) {
  let key = item.key;
  for (let n = 2; queue.some((i) => i.key === key); n++) key = `${item.key}:${n}`;
  return key === item.key ? item : { ...item, key };
}

// ---------- recall (spec §5.4) ----------

// Remembers the path a file tool is about to touch; never alters the call.
function trackPath(e) {
  if (!PATH_TOOLS.has(e?.tool)) return;
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof e[key] === "string" && e[key] !== "") recentPaths = rememberPath(recentPaths, e[key]);
  }
}

// The context blocks for this prompt: rules promoted since the last prompt, then the
// lessons whose tags match the prompt and the recent paths (each lesson once per session).
export async function recallContext($, e) {
  const sessionId = String(await $.session.id());
  if (recalled.sessionId !== sessionId) recalled = { sessionId, ids: new Set() };
  const blocks = [];
  if (promotedThisSession.length > 0) {
    blocks.push(formatBlock(RULES_LEAD, promotedThisSession));
    promotedThisSession = [];
  }
  const lessons = [];
  for (const scope of ["global", "project"]) {
    const s = await readScope($, scope);
    if (s) lessons.push(...entriesOf(s.lessons));
  }
  const haystack = [String(e?.text ?? ""), ...recentPaths].join(" ");
  const matched = matchLessons(lessons, haystack, { max: cfg.maxRecall, exclude: recalled.ids });
  for (const l of matched) recalled.ids.add(l.id);
  if (matched.length > 0) blocks.push(formatBlock(RECALL_LEAD, matched));
  return blocks;
}

// ---------- queue and review lists in $.store (spec §4.4) ----------

function isItem(i) {
  const d = i?.detection;
  return typeof i?.key === "string" && typeof i.dismissed === "number" &&
    typeof d?.title === "string" && typeof d.body === "string" && Array.isArray(d.tags);
}

async function readList($, key) {
  const value = await $.store.get(key);
  return Array.isArray(value) ? value.filter(isItem) : [];
}

// One change at a time: a detection landing while a dialog is open is not overwritten.
function updateList($, key, mutate) {
  const run = listChain.then(() => changeList($, key, mutate));
  listChain = run.catch(() => {});
  return run;
}

async function changeList($, key, mutate) {
  await $.store.set(key, mutate(await readList($, key)));
}

// ---------- confirm (spec §5.3) ----------

async function confirmLater($) {
  try {
    await runConfirm($);
  } catch (err) {
    debug($, `confirmation failed: ${err?.message ?? err}`);
  }
}

// Offers the oldest item this session can take, waiting up to 5 s for this turn's detection
// (a later one stays queued for the next turn end). One dialog at a time (withAsk).
export async function runConfirm($) {
  await withAsk(async () => {
    const pending = pendingDetection;
    pendingDetection = null;
    if (pending) await Promise.race([pending, $.clock.sleep(DETECTION_WAIT_MS)]);
    // Nobody can answer (claude -p): an ask would reject and count as a dismissal.
    if ((await $.session.surfaces()).length === 0) return;
    const ctx = await context($);
    const item = (await readList($, KEY_QUEUE)).find((i) => offerable(i, ctx.repoRoot));
    if (item) await confirmItem($, item, ctx, KEY_QUEUE);
  });
}

// Asks about one stored item and applies the answer. True when answered (the item leaves its
// list); a dismissal counts against a queued item and leaves a review item where it is.
// The caller holds the dialog flag.
async function confirmItem($, queued, ctx, listKey) {
  const projectAvailable = !!ctx.project?.setUp;
  // The project is no longer set up: the lesson can only go to the global scope (spec §8).
  const scoped = queued.detection.scope === "project" && !projectAvailable
    ? { ...queued, detection: { ...queued.detection, scope: "global" } }
    : queued;
  const { target, kind } = await repeatTarget($, scoped.detection);
  const item = kind === scoped.detection.repeatKind
    ? scoped
    : { ...scoped, detection: { ...scoped.detection, repeatKind: kind } };
  const dialog = dialogFor(item, { projectAvailable, target });
  const answer = await ask($, dialog.question, dialog.options, "confirmation");
  if (answer === DISMISSED) {
    if (listKey === KEY_QUEUE) await dismiss($, queued);
    return false;
  }
  await updateList($, listKey, (list) => list.filter((i) => i.key !== queued.key));
  if (await applyAction($, item, interpret(answer, item, dialog))) return true;
  // The cap dialog was dismissed: the correction goes back, its dismiss count unchanged.
  await updateList($, listKey, (list) => [queued, ...list]);
  return false;
}

// Dismissed once: offered again at the next turn end. Twice: moved to the review list.
async function dismiss($, item) {
  const { item: next, toReview } = onDismiss(item);
  if (!toReview) {
    await updateList($, KEY_QUEUE, (queue) => queue.map((i) => (i.key === item.key ? next : i)));
    return;
  }
  await updateList($, KEY_REVIEW, (review) => [...review, next]);
  await updateList($, KEY_QUEUE, (queue) => queue.filter((i) => i.key !== item.key));
}

const scopeOfId = (id) => (id.startsWith("P-") ? "project" : "global");

// The entry with this id as its scope's files are now, and the file holding it ("lessons" or
// "rules"), looked for in `first` before the other one; null when it is gone. A detection is
// a while old: its target may have been promoted or demoted since.
async function locate($, id, first) {
  const s = await readScope($, scopeOfId(id));
  if (!s) return null;
  for (const where of first === "rules" ? ["rules", "lessons"] : ["lessons", "rules"]) {
    const entry = findEntry(s[where], id);
    if (entry) return { entry, where };
  }
  return null;
}

// A repeat's target now, and its kind ("lesson" or "rule"), which the dialog follows.
async function repeatTarget($, d) {
  const found = d.repeatOf ? await locate($, d.repeatOf, d.repeatKind === "rule" ? "rules" : "lessons") : null;
  if (!found) return { target: null, kind: d.repeatKind };
  return { target: found.entry, kind: found.where === "rules" ? "rule" : "lesson" };
}

// Applies an answer. False only when a dialog it opened (the cap dialog) was dismissed:
// nothing is written and the caller keeps the item.
export async function applyAction($, item, action) {
  const d = item.detection;
  if (action.type === "skip") return true;
  if (action.type === "promote" || action.type === "note") {
    // Read now: a lesson promoted meanwhile is noted, never saved again as a new lesson.
    const where = (await locate($, action.id, action.type === "note" ? "rules" : "lessons"))?.where;
    if (action.type === "promote" && where === "lessons") {
      return (await promote($, scopeOfId(action.id), action.id, { holdsAsk: true })) !== "dismissed";
    }
    if (where) await noteEntry($, action.id, where);
    else await saveLesson($, d.scope, d, d.body);
    return true;
  }
  // save: text typed under Other replaces the body, cleaned like the detector's.
  const body = typeof action.body === "string" ? cleanBody(action.body) : d.body;
  if (body) await saveLesson($, action.scope, d, body);
  return true;
}

async function saveLesson($, scope, d, body) {
  const s = await readScope($, scope);
  if (!s) {
    debug($, `cannot save to the ${scope} scope`);
    return;
  }
  const { today } = await context($);
  // The id is taken from the files as they are at the write, across lessons and rules.
  await updateFile($, s.paths.lessons, "lessons", (f) =>
    addEntry(f, { id: nextId(scope, [f, s.rules]), title: d.title, tags: d.tags, seen: 1, first: today, last: today, body }));
}

// Seen +1 and last = today on the entry in `which` ("lessons" or "rules") of its scope.
async function noteEntry($, id, which) {
  const s = await readScope($, scopeOfId(id));
  if (!s) return;
  const { today } = await context($);
  await updateFile($, s.paths[which], which, (f) => {
    const entry = findEntry(f, id);
    return entry ? replaceEntry(f, bumpSeen(entry, today)) : f;
  });
}

function upsert(file, entry) {
  return findEntry(file, entry.id) ? replaceEntry(file, entry) : addEntry(file, entry);
}

// Moves a lesson to the rules of its scope, seen +1. With the scope at ruleCap, asks which
// rule goes back to lessons first. Resolves to "promoted", or why nothing was written:
// "missing", "cancelled", "dismissed", or "busy" (another dialog is open; only when the
// caller does not already hold the dialog flag, holdsAsk).
export async function promote($, scope, id, { holdsAsk = false } = {}) {
  let s = await readScope($, scope);
  if (!s || !findEntry(s.lessons, id)) return "missing";
  const rules = entriesOf(s.rules);
  let demoteId = null;
  if (rules.length >= cfg.ruleCap) {
    const cap = capDialog(scope, rules);
    const askCap = () => ask($, cap.question, cap.options, "promotion");
    const answer = holdsAsk ? await askCap() : await withAsk(askCap);
    if (answer === BUSY) return "busy";
    if (answer === DISMISSED) return "dismissed";
    demoteId = interpretCap(answer, rules, cap.candidates);
    if (!demoteId) return "cancelled";
    // The dialog may have been open a while: continue from the files as they are now.
    s = await readScope($, scope);
    if (!s) return "missing";
  }
  const lesson = findEntry(s.lessons, id);
  if (!lesson) return "missing";
  const demoted = demoteId ? findEntry(s.rules, demoteId) : null;
  const { today } = await context($);
  const promoted = bumpSeen(lesson, today);
  // Each write adds before the next removes: a failed write leaves an entry twice, never lost.
  if (demoted) await updateFile($, s.paths.lessons, "lessons", (f) => upsert(f, demoted));
  await updateFile($, s.paths.rules, "rules", (f) => upsert(demoted ? removeEntry(f, demoted.id).file : f, promoted));
  await updateFile($, s.paths.lessons, "lessons", (f) => removeEntry(f, id).file);
  promotedThisSession.push(promoted);
  return "promoted";
}

// ---------- /lessons (spec §5.6) ----------

const USAGE = "Usage: /lessons [review | promote <id> | demote <id> | delete <id> | setup | pause | resume | eval]";

async function runCommand($, args) {
  const [, verb = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
  const word = verb.toLowerCase();
  const id = rest.trim().toUpperCase();
  if (word === "") return await listText($);
  if (word === "pause" || word === "resume") {
    paused = word === "pause";
    return paused ? "Capture paused for this session." : "Capture resumed.";
  }
  if (word === "review") return await reviewText($);
  if (word === "setup") return await setupText($);
  if (word === "eval") return await evalText($);
  if (word === "promote" || word === "demote" || word === "delete") {
    if (id === "") return USAGE;
    return await changeEntry($, word, id);
  }
  return USAGE;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const entryLine = (e) => `${e.id} · ${e.title} · seen ${e.seen}`;

async function listText($) {
  const rules = [];
  const lessons = [];
  const counts = [];
  for (const scope of ["global", "project"]) {
    const s = await readScope($, scope);
    if (!s) continue;
    const r = entriesOf(s.rules);
    const l = entriesOf(s.lessons);
    rules.push(...r);
    lessons.push(...l);
    counts.push(`${scope === "global" ? "Global" : "Project"}: ${plural(r.length, "rule")}, ${plural(l.length, "lesson")}`);
  }
  // Only what /lessons review would offer here.
  const { repoRoot } = await context($);
  const toReview = (await readList($, KEY_REVIEW)).filter((i) => offerable(i, repoRoot)).length;
  if (toReview > 0) counts.push(`${toReview} to review`);
  const lines = [counts.length > 0 ? counts.join(" · ") : "Nothing saved yet."];
  if (rules.length > 0) lines.push("", "Rules", ...rules.map(entryLine));
  if (lessons.length > 0) lines.push("", "Lessons", ...lessons.map(entryLine));
  return lines.join("\n");
}

// Walks the review list: one dialog per item, the same as at a turn end.
async function reviewText($) {
  const text = await withAsk(async () => {
    const ctx = await context($);
    const items = (await readList($, KEY_REVIEW)).filter((i) => offerable(i, ctx.repoRoot));
    if (items.length === 0) return "Nothing to review.";
    if ((await $.session.surfaces()).length === 0) return "No dialog can be shown in this run.";
    let answered = 0;
    for (const item of items) {
      if (!(await confirmItem($, item, ctx, KEY_REVIEW))) break;
      answered++;
    }
    const left = items.length - answered;
    return `Reviewed ${plural(answered, "item")}${left > 0 ? `, ${left} left` : ""}.`;
  });
  return text === BUSY ? ALREADY_OPEN : text;
}

// Detector eval (spec §9.5): every case through the real detector request, one after the other.
async function evalText($) {
  let cases;
  try {
    cases = JSON.parse(await $.fs.read(`${$.plugin.root}/eval/cases.json`));
  } catch (err) {
    debug($, `eval cases not read: ${err?.message ?? err}`);
    return "The eval cases could not be read.";
  }
  const falsePositives = [];
  const missed = [];
  const errors = [];
  for (const c of cases) {
    let parsed;
    try {
      const text = await askDetector($, { previousReply: c.previousReply, userMessage: c.userMessage, existing: [], projectSetUp: false });
      if (typeof text !== "string") throw new Error("no reply");
      parsed = parseDetectorReply(text, { known: new Map(), projectSetUp: false });
    } catch (err) {
      debug($, `eval case ${c.id} failed: ${err?.message ?? err}`);
      errors.push(c.id);
      continue;
    }
    if (parsed && c.expect === "none") falsePositives.push(c.id);
    if (!parsed && c.expect === "correction") missed.push(c.id);
  }
  const corrections = cases.filter((c) => c.expect === "correction");
  const lookAlikes = cases.length - corrections.length;
  const found = corrections.length - missed.length - corrections.filter((c) => errors.includes(c.id)).length;
  const lines = [`Detected: ${found}/${corrections.length} · False positives: ${falsePositives.length}/${lookAlikes}`];
  if (falsePositives.length > 0) lines.push(`False positives: ${falsePositives.join(", ")}`);
  if (missed.length > 0) lines.push(`Missed: ${missed.join(", ")}`);
  if (errors.length > 0) lines.push(`Errors: ${errors.join(", ")}`);
  return lines.join("\n");
}

async function setupText($) {
  const { repoRoot } = await context($);
  if (!repoRoot) return "Not in a git repository.";
  if ((await offerProjectSetup($, { force: true })) === BUSY) return ALREADY_OPEN;
  return (await context($)).project?.setUp ? "Lessons are set up for this project." : "This project is not set up.";
}

// promote, demote and delete find the id in either scope's files.
async function changeEntry($, verb, id) {
  const s = await readScope($, scopeOfId(id));
  const lesson = s ? findEntry(s.lessons, id) : null;
  const rule = s ? findEntry(s.rules, id) : null;
  if (!lesson && !rule) return `No entry ${id}.`;
  const scope = scopeOfId(id);
  if (verb === "promote") {
    if (!lesson) return `${id} is already a rule.`;
    const status = await promote($, scope, id);
    if (status === "busy") return ALREADY_OPEN;
    return status === "promoted" ? `Promoted ${id} to a rule.` : `${id} was not promoted.`;
  }
  if (verb === "demote") {
    if (!rule) return `${id} is already a lesson.`;
    await updateFile($, s.paths.lessons, "lessons", (f) => upsert(f, rule));
    await updateFile($, s.paths.rules, "rules", (f) => removeEntry(f, id).file);
    return `Demoted ${id} to a lesson.`;
  }
  const entry = lesson ?? rule;
  const answer = await withAsk(() => ask($, `Delete ${id} "${entry.title}"?`, ["Delete", "Keep"], "delete"));
  if (answer === BUSY) return ALREADY_OPEN;
  if (answer !== "Delete") return `Kept ${id}.`;
  const [path, kind] = lesson ? [s.paths.lessons, "lessons"] : [s.paths.rules, "rules"];
  await updateFile($, path, kind, (f) => removeEntry(f, id).file);
  return `Deleted ${id}.`;
}
