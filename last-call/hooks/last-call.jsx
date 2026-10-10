// last-call: stops work at a clean point before the usage limit, keeps the
// prompt cache warm while it waits for the reset, and continues afterwards.
//
// The engine reads on(...) and $.noun.method(...) from this source: they stay
// spelled out, and every function that takes $ lives at the top level. A hook
// that fails lets the work through: the mod never blocks work on its own error.

import { atom, read, update } from "claude-code";
import { configFrom, DEFAULTS } from "./lib/config.mjs";
import { KINDS, windowOf, nextWindow } from "./lib/readings.mjs";
import { initialState, nextPhase, rolledKinds, resumeTime } from "./lib/phases.mjs";
import { isPingDue, cacheWasWarm, isWarmAt, keepAliveDecision, lockIsOurs, MIN_PING_GAP_MS } from "./lib/keepalive.mjs";
import {
  wrapNote, stopNote, denyText, pausedDenyText, resumePrompt, statusText, report, windowLabel, pct, fmtWhen, fmtDuration,
  PING_PROMPT, ASK_SEND_OFF, ASK_SEND_ONCE, ASK_DONT, pausedQuestion,
  COLD_COMPACT, COLD_FULL, COLD_OPTIONS, coldQuestion, compactInstructions,
} from "./lib/texts.mjs";
import { normalize, targetFrom, isTarget, isInside, parentsOf, excludeLine, hasLine } from "./lib/handoff.mjs";

const guard = atom({ plugin: "last-call", key: "guard" }, initialState());

const COMMAND = "last-call";
const TICK_MS = 60_000;
// Tool calls refused after the stop before the mod ends the turn itself.
const MAX_DENIALS = 4;
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const USER_ORIGINS = new Set(["composer", "bridge"]);
const DIALOG = "last-call-ask";
// $.store keys, shared by every session on this machine.
const SHORT_LIVED_KEY = "cacheShortLived";
const LOCK_KEY = "pingLock";
const MINUTE = 60_000;

// Set by register(); later hooks read it.
let cfg = configFrom();
let tick = null;
// The running main-loop turn, so a stop can end it.
let turnId = null;
// One keep-alive at a time; the open cold-resume dialog, if any.
let pinging = false;
let dialog = null;

export const register = (on, options) => {
  cfg = configFrom(options);

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Usage limit guard: status, go (resume now), override (guard off until the reset), rearm, ping (test the keep-alive)",
      argumentHint: "[go|override|rearm|ping]",
    });
    const target = await resolveTarget($);
    // A reload drops an open dialog with the old module: let the tick ask again.
    await update($, guard, (s) => ({ ...s, cwd: e.cwd, handoffTarget: target, resumeStarted: s.phase === "paused" ? false : s.resumeStarted }));
    // One tick carries every timed step, so a hot reload re-arms by itself.
    tick?.cancel();
    tick = $.clock.every(TICK_MS, () => void onTick($));
    await refreshStatus($);
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    if (e.changed.includes("rateLimits") || e.changed.includes("context")) await onReading($, e);
    return next(e);
  });

  on("turn.start", ($, e, next) => {
    turnId = e.turnId;
    return next(e);
  });

  // The stop: while stopping, only writing the handoff note goes through.
  on("tool.call", async ($, e, next) => {
    const s = await read($, guard);
    const isNote = WRITE_TOOLS.has(e.tool) && isTarget(s.handoffTarget, e.file_path);
    // Checked again at the write: a symlink planted since the start would
    // otherwise turn the one allowed write into a write elsewhere.
    const isSafeNote = isNote && s.phase === "stopping" && (await isSafeTarget($, await $.session.root(), s.handoffTarget));
    // While paused no turn should run: one that starts anyway (a background
    // task's notification, say) gets no tools, so the reserve stays for pings.
    // AskUserQuestion stays open: the mod's own question during the pause is one.
    if (s.phase === "paused" && e.tool !== "AskUserQuestion") return { deny: pausedDenyText(s, await $.clock.now()) };
    if (s.phase !== "stopping" || (isSafeNote && !s.handoff)) {
      const ran = await next(e);
      if (isNote && ran.deny === undefined && ran.isError !== true) await recordHandoff($, s.handoffTarget);
      return ran;
    }
    const after = await update($, guard, (x) => ({ ...x, denials: x.denials + 1 }));
    if (after.denials >= MAX_DENIALS) void endTurn($);
    return { deny: denyText(s, s.handoffTarget ?? "(unavailable)") };
  }).catch(($, e, next) => next(e));

  // The turn that wrapped up has ended: pause until the reset.
  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId) return done;
    turnId = null;
    const s = await read($, guard);
    if (s.phase === "wrapping" || s.phase === "stopping" || s.returnToPause) {
      await onReading($, await $.session.usage());
      await enterPause($);
    }
    return done;
  });

  // A prompt the person typed during the pause: ask before sending it.
  on("prompt.submit", async ($, e, next) => {
    if (!USER_ORIGINS.has(e.origin?.kind ?? "composer")) return next(e);
    const s = await read($, guard);
    if (s.phase === "ready") {
      // Past the reset: the person's prompt is the go-ahead.
      await update($, guard, (x) => ({ ...x, ...cleared() }));
      await refreshStatus($);
      return next(e);
    }
    if (s.phase !== "paused") return next(e);
    let answer = ASK_DONT;
    try {
      answer = await $.ui.ask(pausedQuestion(s, await $.clock.now()), { header: "last-call", options: [ASK_SEND_OFF, ASK_SEND_ONCE, ASK_DONT] });
    } catch {
      // Dismissed: the prompt is not sent.
    }
    if (answer === ASK_SEND_OFF) {
      const until = resetOf(s) ?? (await $.clock.now()) + 5 * 60 * MINUTE;
      await update($, guard, (x) => ({ ...x, ...cleared(), overrideUntil: until }));
      await refreshStatus($);
      return next(e);
    }
    if (answer === ASK_SEND_ONCE) {
      await update($, guard, (x) => ({ ...x, phase: "normal", returnToPause: true }));
      await refreshStatus($);
      return next(e);
    }
    // "Don't send", a dismissal, or anything typed under "Other".
    void $.prompt.fill({ text: e.text }).catch(() => {});
    return { drop: "last-call: paused for the usage limit; the prompt is back in the box" };
  }).catch(($, e, next) => next(e));

  // The cold-resume dialog: drawn in a pane the mod opens and closes itself.
  on("ui.render", { component: "Pane", requestId: DIALOG }, async ($, e, next) => {
    if (!dialog) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const ask = dialog;
    return (
      <Box flexDirection="column">
        <Text>{ask.question}</Text>
        {ask.options.map((o, i) => (
          <Button key={o.key} hotkey={String(i + 1)} variant={i === 0 ? "primary" : undefined} onPress={() => ask.settle(o.key)}>
            {o.label}
          </Button>
        ))}
      </Box>
    );
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === DIALOG && e.origin.kind === "person") dialog?.settle(null);
    return next(e);
  }).catch(($, e, next) => next(e));

  on("command.run", { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "") return { text: report(await read($, guard), cfg, await $.clock.now()) };
    if (!["go", "override", "rearm", "ping"].includes(arg)) return { text: "Usage: /last-call [go | override | rearm | ping]" };
    // Only the person may lift or move the guard, never the model.
    if (!USER_ORIGINS.has(e.origin?.kind)) return { text: `last-call: /last-call ${arg} only runs when you type it.` };
    if (arg === "go") return { text: await goNow($) };
    if (arg === "override") return { text: await override($) };
    if (arg === "rearm") return { text: await rearm($) };
    return { text: await ping($, true) };
  });
};

// A reading of the usage windows: session.measure's input or $.session.usage().
async function onReading($, usage) {
  const now = await $.clock.now();
  const readings = Object.fromEntries(KINDS.map((k) => [k, windowOf(usage.rateLimits, k)]));
  const before = await read($, guard);
  const after = await update($, guard, (s) => {
    const rolled = rolledKinds(s.windows, readings);
    const windows = Object.fromEntries(KINDS.map((k) => [k, nextWindow(s.windows[k], readings[k], now)]));
    let x = { ...s, windows, contextTokens: usage.context?.tokens ?? s.contextTokens };
    if (x.overrideUntil && now >= x.overrideUntil) x = { ...x, overrideUntil: null };
    if (rolled.includes(s.binding) && (s.phase === "wrapping" || s.phase === "stopping")) x = { ...x, denials: 0 };
    return { ...x, ...nextPhase(x, cfg, now, rolled) };
  });
  if (after.phase !== before.phase) await announce($, before.phase, after, now);
  await refreshStatus($);
}

// Tells the model and the person that the phase changed.
async function announce($, from, s, now) {
  const where = s.binding ? `${windowLabel(s.binding)} usage at ${pct(s.windows[s.binding].percent)}` : "";
  if (s.phase === "wrapping" || s.phase === "stopping") await ensureExcluded($);
  if (s.phase === "wrapping") {
    await appendNote($, wrapNote(s, cfg, now, handoffPathOf(s)));
    await tell($, `${where}: wrapping up at the next clean point.`);
  } else if (s.phase === "stopping") {
    await appendNote($, stopNote(s, cfg, handoffPathOf(s)));
    await tell($, `${where}: limit reached, stopping after the handoff note.`);
  } else if (s.phase === "normal" && (from === "wrapping" || from === "stopping")) {
    await tell($, "The usage window reset; carrying on.");
  }
}

async function appendNote($, text) {
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
}

// A toast now, and a notification for someone away from the terminal.
async function tell($, text) {
  $.ui.toast(`last-call: ${text}`);
  await $.ui.notify(text, { title: "last-call" });
}

function handoffPathOf(s) {
  return s.handoffTarget ?? "(no valid handoff path: check the handoffPath setting)";
}

// The note's absolute path, checked: inside the project, its existing parent's
// real path inside the project's real path, and the note itself no symlink.
// An invalid setting falls back to the default; null when neither is safe.
async function resolveTarget($) {
  const root = await $.session.root();
  for (const setting of [cfg.handoffPath, DEFAULTS.handoffPath]) {
    const target = targetFrom(root, setting);
    if (target && (await isSafeTarget($, root, target))) {
      if (setting !== cfg.handoffPath) $.ui.toast(`last-call: handoffPath "${cfg.handoffPath}" leaves the project; using ${DEFAULTS.handoffPath}`);
      return target;
    }
  }
  $.ui.toast("last-call: no safe handoff path; the stop will refuse every tool");
  return null;
}

async function isSafeTarget($, root, target) {
  try {
    const realRoot = normalize((await $.fs.stat(root, { resolve: true })).realPath ?? root);
    if (await $.fs.exists(target)) {
      const own = await $.fs.stat(target, { resolve: true });
      return own.kind === "file" && !own.isLink && isInside(realRoot, normalize(own.realPath ?? target));
    }
    for (const dir of parentsOf(target)) {
      if (!(await $.fs.exists(dir))) continue;
      const st = await $.fs.stat(dir, { resolve: true });
      const real = normalize(st.realPath ?? dir);
      return st.kind === "dir" && (real === realRoot || isInside(realRoot, real));
    }
  } catch {
    // An unreadable path is no safe path.
  }
  return false;
}

// The note was written: remember it, and what it held, for the resume's check.
async function recordHandoff($, target) {
  const now = await $.clock.now();
  const hash = await hashFile($, target);
  await update($, guard, (x) => ({ ...x, handoff: hash ? { path: target, writtenAt: now, hash } : null }));
}

async function hashFile($, path) {
  try {
    const text = await $.fs.read(path);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// Adds the note to the repository's local exclude file once, when asked to.
async function ensureExcluded($) {
  const s = await read($, guard);
  if (!cfg.handoffGitIgnored || s.excludeDone || !s.handoffTarget) return;
  await update($, guard, (x) => ({ ...x, excludeDone: true }));
  try {
    const top = await $.process.run(["git", "rev-parse", "--show-toplevel"]);
    const where = await $.process.run(["git", "rev-parse", "--git-path", "info/exclude"]);
    if (top.exitCode !== 0 || where.exitCode !== 0) return;
    const line = excludeLine(top.stdout.trim(), s.handoffTarget);
    // --git-path answers relative to the working directory unless absolute.
    const raw = where.stdout.trim();
    const file = raw && normalize(raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : `${await $.session.cwd()}/${raw}`);
    if (!line || !file) return;
    const text = (await $.fs.exists(file)) ? await $.fs.read(file) : "";
    if (hasLine(text, line)) return;
    await $.fs.write(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# last-call handoff note\n${line}\n`);
  } catch {
    // Not a repository, or no git: nothing to ignore.
  }
}

// Ends the running turn after the model kept calling tools past the stop.
async function endTurn($) {
  if (!turnId) return;
  try {
    await $.turn.abort({ turnId });
    $.ui.toast("last-call: ended the turn at the usage limit");
  } catch {
    // The turn ended on its own meanwhile.
  }
}

// The pause's state cleared: back to normal work.
function cleared() {
  return {
    phase: "normal", resumeAt: null, pausedAt: null, keepAlive: "off", keepAliveNote: null, pings: 0, lastPingAt: null,
    denials: 0, returnToPause: false, resumeStarted: false, handoff: null,
  };
}

function resetOf(s) {
  return s.binding ? s.windows[s.binding]?.resetsAt ?? null : null;
}

// The wrap-up turn ended (or a "send this one only" turn): wait for the reset.
async function enterPause($) {
  const now = await $.clock.now();
  const s = await read($, guard);
  // A "send this one only" turn whose window reset meanwhile has nothing to wait for.
  if (s.returnToPause && s.phase === "normal" && (!s.resumeAt || s.resumeAt <= now)) {
    await update($, guard, (x) => ({ ...x, ...cleared() }));
    return;
  }
  const isShortLived = (await $.store.get(SHORT_LIVED_KEY)) === true;
  const after = await update($, guard, (x) => {
    const resumeAt = x.returnToPause && x.resumeAt ? x.resumeAt : resumeTime(x);
    const decision = keepAliveDecision(cfg, resumeAt ? resumeAt - now : null, isShortLived);
    return {
      ...x, phase: "paused", resumeAt, pausedAt: now, lastCacheTouch: now, keepAlive: decision.keepAlive,
      keepAliveNote: decision.note, pings: 0, lastPingAt: null, denials: 0, returnToPause: false, resumeStarted: false,
    };
  });
  const when = after.resumeAt ? ` until ${fmtWhen(after.resumeAt, now)} (${fmtDuration(after.resumeAt - now)})` : "";
  await tell($, `Paused${when}. Keep-alive: ${after.keepAlive === "on" ? after.keepAliveNote : `off, ${after.keepAliveNote}`}.`);
  await refreshStatus($);
}

async function onTick($) {
  const now = await $.clock.now();
  const s = await read($, guard);
  if (s.overrideUntil && now >= s.overrideUntil) await update($, guard, (x) => ({ ...x, overrideUntil: null }));
  if (s.phase === "paused" && s.resumeAt && now >= s.resumeAt && !s.resumeStarted) await resume($, false);
  else if (isPingDue(s, cfg, now)) await ping($, false);
  await refreshStatus($);
}

// One keep-alive: the main thread's last request again with a tiny question, so
// the API serves the cached conversation and so refreshes it.
async function ping($, isAsked) {
  if (pinging) return "A ping is already running.";
  pinging = true;
  try {
    const now = await $.clock.now();
    if (!isAsked && cfg.keepAliveSessions === "one" && !(await takeLock($, now))) return "";
    await update($, guard, (x) => ({ ...x, lastPingAt: now }));
    const r = await $.model.fork({ prompt: PING_PROMPT });
    if (!r.isAnswered && r.reason === "nothing-to-fork") return "Nothing to keep warm yet: the session has no response.";
    if (!r.isAnswered && r.reason === "api-error") {
      await update($, guard, (x) => ({ ...x, keepAlive: x.keepAlive === "on" ? "failed" : x.keepAlive, keepAliveNote: `ping failed: HTTP ${r.status} ${r.error}` }));
      if (!isAsked) await tell($, `Keep-alive stopped: the ping failed (HTTP ${r.status}).`);
      return `Ping failed: HTTP ${r.status} (${r.error}).`;
    }
    const warm = cacheWasWarm(r.usage);
    const served = r.usage.cache_read_input_tokens;
    const wrote = r.usage.cache_creation_input_tokens;
    if (warm === false) {
      // The cache had lapsed between pings: it lives under an hour here, so
      // pinging cannot pay. Remember that for later pauses.
      await $.store.set(SHORT_LIVED_KEY, true);
      await update($, guard, (x) => ({
        ...x, lastCacheTouch: now, pings: x.pings + 1,
        keepAlive: x.phase === "paused" ? "cold" : x.keepAlive,
        keepAliveNote: "the cache had expired before the ping, so it lives under an hour here; keep-alive stopped",
      }));
      if (!isAsked) await tell($, "Keep-alive stopped: the cache had already expired.");
      return `Ping found the cache cold (${served} tokens read, ${wrote} written). Keep-alive stays off until a ping finds it warm.`;
    }
    if (warm === true) await $.store.delete(SHORT_LIVED_KEY);
    await update($, guard, (x) => ({ ...x, lastCacheTouch: now, pings: x.pings + 1 }));
    return isAsked ? `Ping answered: ${served} tokens read from the cache, ${wrote} written.` : "";
  } finally {
    pinging = false;
    await refreshStatus($);
  }
}

// keepAliveSessions = one: take the machine-wide ping lock, or leave it. $.store
// has no compare-and-set, so a rare race lets two sessions ping; that costs one
// extra ping and nothing else.
async function takeLock($, now) {
  const me = await $.session.id();
  if (!lockIsOurs(await $.store.get(LOCK_KEY), me, now)) return false;
  await $.store.set(LOCK_KEY, { sessionId: me, until: now + cfg.keepAliveMinutes * MINUTE + MIN_PING_GAP_MS });
  const held = await $.store.get(LOCK_KEY);
  return held?.sessionId === me;
}

// The window reset, or the person said go: continue the work, or wait.
async function resume($, isAsked) {
  const now = await $.clock.now();
  // No pings from here on: the resume decides about the cache itself.
  await update($, guard, (x) => ({ ...x, resumeStarted: true, keepAlive: "off" }));
  const s = await read($, guard);
  if (!s.handoff) {
    await update($, guard, (x) => ({ ...x, ...cleared() }));
    if (!isAsked) await tell($, "The usage window has reset; there was no unfinished work to resume.");
    return "Nothing to resume: no handoff note was written. The guard is armed again.";
  }
  if (!(await isNoteIntact($, s))) {
    await update($, guard, (x) => ({ ...x, phase: "ready", keepAlive: "off" }));
    await tell($, "The window has reset, but the handoff note changed or is gone since it was written. Not resuming by itself: check it, then /last-call go.");
    if (!isAsked) return "";
    await update($, guard, (x) => ({ ...x, handoff: null }));
    return "The handoff note changed since it was written, so it is not trusted. Type your next prompt to continue.";
  }
  if (!isAsked && !cfg.autoResume) {
    await update($, guard, (x) => ({ ...x, phase: "ready", keepAlive: "off" }));
    await tell($, "The usage window has reset. /last-call go resumes the work.");
    return "";
  }
  const isWarm = isWarmAt(s, now, (await $.store.get(SHORT_LIVED_KEY)) === true);
  let choice = COLD_FULL;
  if (!isWarm) {
    choice = await askCold($, s, isAsked);
    // The person may have moved on while the question was open (override, a prompt).
    const current = await read($, guard);
    if (current.phase !== "paused" && current.phase !== "ready") return "";
    if (choice !== COLD_COMPACT && choice !== COLD_FULL) {
      await update($, guard, (x) => ({ ...x, phase: "ready", keepAlive: "off" }));
      await refreshStatus($);
      return "Staying paused. /last-call go resumes.";
    }
  }
  await update($, guard, (x) => ({ ...x, ...cleared() }));
  await refreshStatus($);
  // From a timer of its own: a command's hook may not wait on a new turn.
  $.clock.after(0, () => void continueWork($, s.handoff.path, choice === COLD_COMPACT));
  return choice === COLD_COMPACT ? "Compacting, then resuming from the handoff note." : "Resuming from the handoff note.";
}

async function continueWork($, path, isCompact) {
  if (isCompact) {
    try {
      await $.session.compact({ instructions: compactInstructions(path) });
    } catch {
      // A failed compaction leaves the full context; resume with it.
    }
  }
  await $.prompt.submit({ text: resumePrompt(path) });
  await tell($, "The usage window has reset; resuming the work.");
}

// The note this session saw written: still there, unchanged, no symlink.
async function isNoteIntact($, s) {
  if (!s.handoff || s.handoff.path !== s.handoffTarget) return false;
  if (!(await isSafeTarget($, await $.session.root(), s.handoff.path))) return false;
  if (!(await $.fs.exists(s.handoff.path))) return false;
  return (await hashFile($, s.handoff.path)) === s.handoff.hash;
}

// The cold-resume question, answered by the person or, after the timeout, by
// the coldResumeDefault setting. Asked by /last-call go, it waits for an answer.
async function askCold($, s, isAsked) {
  const timeoutMs = isAsked || cfg.coldResumeDefault === "wait" ? null : cfg.coldResumeTimeoutMinutes * MINUTE;
  const answer = await askDialog($, "last-call: resume", coldQuestion(s, cfg), COLD_OPTIONS, timeoutMs);
  if (answer === "timeout" || (answer === "unplaced" && !isAsked)) return cfg.coldResumeDefault;
  return answer;
}

// A dialog in a pane: resolves the pressed option's key, null when dismissed,
// "timeout" when timeoutMs passed, "unplaced" when no surface could show it.
function askDialog($, title, question, options, timeoutMs) {
  dialog?.settle(null);
  return new Promise((resolve) => {
    let timer = null;
    const settle = (key) => {
      if (dialog?.settle !== settle) return;
      dialog = null;
      timer?.cancel();
      void $.ui.close({ id: DIALOG }).catch(() => {});
      resolve(key);
    };
    dialog = { question, options, settle };
    void $.ui.open({ id: DIALOG, title, focus: true, closeOnEscape: true, holdToasts: true })
      .then((opened) => {
        if (!opened.isPlaced) settle("unplaced");
        else if (timeoutMs) timer = $.clock.after(timeoutMs, () => settle("timeout"));
      })
      .catch(() => settle("unplaced"));
  });
}

async function goNow($) {
  const s = await read($, guard);
  if (s.phase !== "paused" && s.phase !== "ready") return "Not paused; nothing to resume.";
  // Before the reset the limit still holds: lift the guard until then.
  const now = await $.clock.now();
  const reset = resetOf(s);
  if (reset && reset > now) await update($, guard, (x) => ({ ...x, overrideUntil: reset }));
  return resume($, true);
}

async function override($) {
  const now = await $.clock.now();
  const s = await read($, guard);
  const reset = resetOf(s) ?? s.windows.five_hour?.resetsAt;
  const until = reset && reset > now ? reset : now + 5 * 60 * MINUTE;
  await update($, guard, (x) => ({ ...x, ...cleared(), binding: null, overrideUntil: until }));
  dialog?.settle(null);
  await refreshStatus($);
  return `Guard off until ${fmtWhen(until, now)}. /last-call rearm turns it back on.`;
}

async function rearm($) {
  await update($, guard, (x) => ({ ...x, overrideUntil: null }));
  await onReading($, await $.session.usage());
  return `Guard armed.\n${report(await read($, guard), cfg, await $.clock.now())}`;
}

async function refreshStatus($) {
  const s = await read($, guard);
  $.ui.status(statusText(s, cfg, await $.clock.now()));
}
