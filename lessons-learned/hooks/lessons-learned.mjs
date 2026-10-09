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
import { joinPath, configDirFrom, scopeFiles } from "./lib/paths.mjs";
import { DETECTOR_SYSTEM, shouldSkip, buildDetectorPrompt, parseDetectorReply } from "./lib/detector.mjs";
import { matchLessons, formatBlock, RECALL_LEAD, RULES_LEAD, rememberPath } from "./lib/recall.mjs";
import { dialogFor, interpret, onDismiss, capDialog, interpretCap, offerable } from "./lib/confirm.mjs";

export const KEY_GLOBAL_DONE = "globalSetupDone";
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
const DIALOG_HEADER = "Lesson";

// Set by register(); later hooks read it.
let cfg = { model: "haiku", ruleCap: 20, maxRecall: 3 };

// Session-only state (spec §4.4). paused: capture is off (/lessons pause).
// pendingDetection: the detector call of the latest prompt, resolving to its queued item (or
// null) once the item is in the queue. asking: a confirmation dialog is open, or waiting.
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
    recalled = { sessionId: recalled.sessionId, ids: new Set() };
    return next(e);
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
        description: "Learned lessons and rules: list, review, promote, demote, delete, setup, pause, resume",
        argumentHint: "[review|promote <id>|demote <id>|delete <id>|setup|pause|resume]",
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
    await offerProjectSetup($, { force: false });
  } catch (err) {
    debug($, `project setup failed: ${err?.message ?? err}`);
  }
}

function debug($, text) {
  $.ui.log(`lessons-learned: ${text}`, { to: "debug" });
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
  const repoRoot = (await $.session.repo())?.root ?? null;
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

export async function ensureGlobal($) {
  const { configDir } = await context($);
  if (!configDir) return;
  await ensureFiles($, configDir);
  const claudeMd = joinPath(configDir, "CLAUDE.md");
  const text = await readText($, claudeMd);
  if (!hasBlock(text)) await $.fs.write(claudeMd, insertBlock(text, GLOBAL_IMPORT));
  await $.store.set(KEY_GLOBAL_DONE, true);
}

export async function offerProjectSetup($, { force }) {
  const { repoRoot, project } = await context($);
  if (!repoRoot || !project) return;
  if ((await $.session.surfaces()).length === 0) return;
  if (!force && (await $.store.get(optOutKey(repoRoot)))) return;
  if (project.setUp) {
    await ensureFiles($, repoRoot);
    return;
  }
  let answer;
  try {
    answer = await $.ui.ask(SETUP_QUESTION, [YES_COMMIT, YES_IGNORE, NOT_HERE]);
  } catch (err) {
    debug($, `setup question not answered: ${err?.message ?? err}`);
    return;
  }
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

// The detector call, parsed and queued. Never rejects: any failure is "no correction".
async function detect($, { prompt, previousReply, key }) {
  try {
    const ctx = await context($);
    const projectSetUp = !!ctx.project?.setUp;
    const existing = await existingEntries($);
    const known = new Map(existing.map((x) => [x.id, x.kind]));
    const reply = await $.model.complete({
      model: cfg.model,
      system: DETECTOR_SYSTEM,
      prompt: buildDetectorPrompt({ previousReply, userMessage: prompt, existing, projectSetUp }),
      maxTokens: DETECTOR_MAX_TOKENS,
    });
    const detection = parseDetectorReply(typeof reply === "string" ? reply : reply?.text, { known, projectSetUp });
    if (!detection) return null;
    const item = {
      key,
      detection,
      repoRoot: detection.scope === "project" ? ctx.repoRoot : null,
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
// (a later one stays queued for the next turn end). One dialog at a time.
export async function runConfirm($) {
  if (asking) return;
  asking = true;
  try {
    const pending = pendingDetection;
    pendingDetection = null;
    if (pending) await Promise.race([pending, $.clock.sleep(DETECTION_WAIT_MS)]);
    // Nobody can answer (claude -p): an ask would reject and count as a dismissal.
    if ((await $.session.surfaces()).length === 0) return;
    const ctx = await context($);
    const item = (await readList($, KEY_QUEUE)).find((i) => offerable(i, ctx.repoRoot));
    if (item) await confirmItem($, item, ctx, KEY_QUEUE);
  } finally {
    asking = false;
  }
}

// Asks about one stored item and applies the answer. True when answered (the item leaves its
// list); a dismissal counts against a queued item and leaves a review item where it is.
async function confirmItem($, queued, ctx, listKey) {
  const projectAvailable = !!ctx.project?.setUp;
  // The project is no longer set up: the lesson can only go to the global scope (spec §8).
  const item = queued.detection.scope === "project" && !projectAvailable
    ? { ...queued, detection: { ...queued.detection, scope: "global" } }
    : queued;
  const d = item.detection;
  const target = d.repeatOf ? await lookUp($, d.repeatOf, d.repeatKind === "rule" ? "rules" : "lessons") : null;
  const dialog = dialogFor(item, { projectAvailable, target });
  let answer;
  try {
    answer = await $.ui.ask(dialog.question, { options: dialog.options, header: dialog.header });
  } catch (err) {
    debug($, `confirmation not answered: ${err?.message ?? err}`);
    if (listKey === KEY_QUEUE) await dismiss($, queued);
    return false;
  }
  await updateList($, listKey, (list) => list.filter((i) => i.key !== queued.key));
  await applyAction($, item, interpret(answer, item, dialog));
  return true;
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

// The entry with this id in the lessons or rules file of its scope, read now; null if gone.
async function lookUp($, id, which) {
  const s = await readScope($, scopeOfId(id));
  return s ? findEntry(s[which], id) : null;
}

export async function applyAction($, item, action) {
  const d = item.detection;
  if (action.type === "skip") return;
  if (action.type === "promote") {
    if (await lookUp($, action.id, "lessons")) await promote($, scopeOfId(action.id), action.id);
    else await saveLesson($, d.scope, d, d.body);
    return;
  }
  if (action.type === "note") {
    if (await lookUp($, action.id, "rules")) await noteRule($, action.id);
    else await saveLesson($, d.scope, d, d.body);
    return;
  }
  // save: text typed under Other replaces the body, cleaned like the detector's.
  const body = typeof action.body === "string" ? cleanBody(action.body) : d.body;
  if (body) await saveLesson($, action.scope, d, body);
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

async function noteRule($, id) {
  const s = await readScope($, scopeOfId(id));
  if (!s) return;
  const { today } = await context($);
  await updateFile($, s.paths.rules, "rules", (f) => {
    const rule = findEntry(f, id);
    return rule ? replaceEntry(f, bumpSeen(rule, today)) : f;
  });
}

function upsert(file, entry) {
  return findEntry(file, entry.id) ? replaceEntry(file, entry) : addEntry(file, entry);
}

// Moves a lesson to the rules of its scope, seen +1. With the scope at ruleCap, asks which
// rule goes back to lessons first; cancelled, dismissed or gone: false, nothing written.
export async function promote($, scope, id) {
  let s = await readScope($, scope);
  if (!s || !findEntry(s.lessons, id)) return false;
  const rules = entriesOf(s.rules);
  let demoteId = null;
  if (rules.length >= cfg.ruleCap) {
    const cap = capDialog(scope, rules);
    let answer;
    try {
      answer = await $.ui.ask(cap.question, { options: cap.options, header: DIALOG_HEADER });
    } catch (err) {
      debug($, `promotion not confirmed: ${err?.message ?? err}`);
      return false;
    }
    demoteId = interpretCap(answer, rules, cap.candidates);
    if (!demoteId) return false;
    // The dialog may have been open a while: continue from the files as they are now.
    s = await readScope($, scope);
    if (!s) return false;
  }
  const lesson = findEntry(s.lessons, id);
  if (!lesson) return false;
  const demoted = demoteId ? findEntry(s.rules, demoteId) : null;
  const { today } = await context($);
  const promoted = bumpSeen(lesson, today);
  // Each write adds before the next removes: a failed write leaves an entry twice, never lost.
  if (demoted) await updateFile($, s.paths.lessons, "lessons", (f) => upsert(f, demoted));
  await updateFile($, s.paths.rules, "rules", (f) => upsert(demoted ? removeEntry(f, demoted.id).file : f, promoted));
  await updateFile($, s.paths.lessons, "lessons", (f) => removeEntry(f, id).file);
  promotedThisSession.push(promoted);
  return true;
}

// ---------- /lessons (spec §5.6) ----------

const USAGE = "Usage: /lessons [review | promote <id> | demote <id> | delete <id> | setup | pause | resume]";

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
  const toReview = (await readList($, KEY_REVIEW)).length;
  if (toReview > 0) counts.push(`${toReview} to review`);
  const lines = [counts.length > 0 ? counts.join(" · ") : "Nothing saved yet."];
  if (rules.length > 0) lines.push("", "Rules", ...rules.map(entryLine));
  if (lessons.length > 0) lines.push("", "Lessons", ...lessons.map(entryLine));
  return lines.join("\n");
}

// Walks the review list: one dialog per item, the same as at a turn end.
async function reviewText($) {
  if (asking) return "A lesson dialog is already open.";
  asking = true;
  try {
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
  } finally {
    asking = false;
  }
}

async function setupText($) {
  const { repoRoot } = await context($);
  if (!repoRoot) return "Not in a git repository.";
  await offerProjectSetup($, { force: true });
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
    return (await promote($, scope, id)) ? `Promoted ${id} to a rule.` : `${id} was not promoted.`;
  }
  if (verb === "demote") {
    if (!rule) return `${id} is already a lesson.`;
    await updateFile($, s.paths.lessons, "lessons", (f) => upsert(f, rule));
    await updateFile($, s.paths.rules, "rules", (f) => removeEntry(f, id).file);
    return `Demoted ${id} to a lesson.`;
  }
  const entry = lesson ?? rule;
  let answer;
  try {
    answer = await $.ui.ask(`Delete ${id} "${entry.title}"?`, { options: ["Delete", "Keep"], header: DIALOG_HEADER });
  } catch (err) {
    debug($, `delete not confirmed: ${err?.message ?? err}`);
    return `Kept ${id}.`;
  }
  if (answer !== "Delete") return `Kept ${id}.`;
  const [path, kind] = lesson ? [s.paths.lessons, "lessons"] : [s.paths.rules, "rules"];
  await updateFile($, path, kind, (f) => removeEntry(f, id).file);
  return `Deleted ${id}.`;
}
