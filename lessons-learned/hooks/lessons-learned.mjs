// lessons-learned: confirms each correction, recalls the lesson when it is
// relevant again, and promotes a repeated correction to a rule.
//
// The engine reads on(...) and $.noun.method(...) from this source: they stay spelled
// out, and every function that takes $ lives at the top level. Every failure (file,
// model, parse) degrades to "do nothing" and is logged only to the debug log.

import {
  parseEntries, serializeEntries, emptyFile, FILE_HEADERS,
} from "./lib/entries.mjs";
import { hasBlock, insertBlock, addIgnoreLines, pickClaudeMd } from "./lib/claude-md.mjs";
import { joinPath, configDirFrom, scopeFiles } from "./lib/paths.mjs";

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

// Set by register(); later hooks read it.
let cfg = { model: "haiku", ruleCap: 20, maxRecall: 3 };

export function register(on, options) {
  cfg = {
    model: options?.model || "haiku",
    ruleCap: Number(options?.ruleCap) || 20,
    maxRecall: Number(options?.maxRecall) || 3,
  };

  on("session.start", async ($, e, next) => {
    const started = await next(e);
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
