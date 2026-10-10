// last-call's words: the notes the model reads, the status line, notifications
// and the /last-call report. Pure functions of plain values; nothing here takes $.

import { limitsOf } from "./config.mjs";
import { MINUTE, burnRate, minutesTo } from "./readings.mjs";

const LABEL = { five_hour: "5-hour", seven_day: "7-day" };
const SHORT = { five_hour: "5h", seven_day: "7d" };

export const pct = (p) => `${Math.round(p * 10) / 10}%`;

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// A reset time: the clock when it is within a day, else the date as well.
export function fmtWhen(ms, now) {
  if (ms - now < 20 * 60 * MINUTE) return fmtClock(ms);
  const d = new Date(ms);
  return `${d.toISOString().slice(5, 10)} ${fmtClock(ms)}`;
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return m % 60 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${h}h`;
}

export const windowLabel = (kind) => LABEL[kind] ?? kind;

function etaOf(win, cfg, kind, now) {
  return minutesTo(win.percent, limitsOf(cfg, kind).stopAt, burnRate(win.samples, now));
}

// The wrap-up note: where things stand, what to do, and the handoff template.
export function wrapNote(state, cfg, now, handoffPath) {
  const kind = state.binding;
  const win = state.windows[kind];
  const { stopAt } = limitsOf(cfg, kind);
  const eta = etaOf(win, cfg, kind, now);
  const when = eta !== undefined ? ` (projected to reach ${stopAt}% in ~${Math.max(1, Math.round(eta))} min)` : "";
  const reset = win.resetsAt ? ` The window resets at ${fmtWhen(win.resetsAt, now)}.` : "";
  return [
    `[last-call] The ${windowLabel(kind)} usage limit is at ${pct(win.percent)}${when}.${reset}`,
    "Find the nearest clean stopping point: finish or safely shelve the current step, and do not start new sub-tasks or subagents.",
    `If work remains, write a handoff note to ${handoffPath} with the Write tool, using this template:`,
    "",
    handoffTemplate(kind, win.percent, now),
    "",
    "Then end your turn with a one-line summary.",
    `At ${stopAt}% every tool except writing that note is refused. The session then pauses and continues from the note after the reset.`,
  ].join("\n");
}

export function stopNote(state, cfg, handoffPath) {
  const kind = state.binding;
  const win = state.windows[kind];
  return [
    `[last-call] The ${windowLabel(kind)} usage limit is at ${pct(win.percent)}, past the ${limitsOf(cfg, kind).stopAt}% stop. Stop working now.`,
    `If work remains and the handoff note is not written yet, write it to ${handoffPath} (Write tool, template as given before), then end your turn with a one-line summary. Every other tool call is refused.`,
  ].join("\n");
}

export function handoffTemplate(kind, percent, now) {
  return [
    `# Handoff (last-call, ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC, ${windowLabel(kind)} at ${pct(percent)})`,
    "",
    "## Task",
    "The original request, in one or two lines.",
    "",
    "## Done",
    "- What is finished, and where (files, commits).",
    "",
    "## Next step",
    "The exact next action, specific enough to start without re-reading the conversation.",
    "",
    "## Remaining",
    "- Steps after the next one, in order.",
    "",
    "## State not in files",
    "- Decisions made, assumptions, commands running, things tried that failed.",
    "",
    "## Open questions",
    "- Anything that needs the person.",
  ].join("\n");
}

export function denyText(state, handoffPath) {
  return state.handoff
    ? "last-call: the usage limit is reached and the handoff note is saved. End your turn now with a one-line summary."
    : `last-call: the usage limit is reached. The only tool allowed is writing the handoff note to ${handoffPath}. Write it if work remains, then end your turn.`;
}

export function pausedDenyText(state, now) {
  const until = state.resumeAt ? ` until ${fmtWhen(state.resumeAt, now)}` : "";
  return `last-call: the session is paused for the usage limit${until}, and no tools run during the pause. End your turn now; the work continues after the reset.`;
}

// The resume prompt: the note is the model's own notes, to check before acting.
export function resumePrompt(handoffPath) {
  return [
    "last-call: the usage window has reset, so the work can continue.",
    `Read your handoff note at ${handoffPath}. It holds your own notes from before the pause.`,
    "Check them against the repository's current state before acting on them, continue from the next step, and delete the note once you have picked it up.",
  ].join(" ");
}

export function statusText(state, cfg, now) {
  const { phase, windows } = state;
  const seven = windows.seven_day && windows.seven_day.percent >= 80 && state.binding !== "seven_day" ? ` · 7d ${pct(windows.seven_day.percent)}` : "";
  if (phase === "paused") {
    const when = state.resumeAt ? `until ${fmtWhen(state.resumeAt, now)} (${fmtDuration(state.resumeAt - now)})` : "reset time unknown";
    const ka = state.keepAlive === "on" ? ` · keep-alive ${state.pings} ping${state.pings === 1 ? "" : "s"}` : "";
    return `⏸ last-call paused ${when}${ka}${seven}`;
  }
  if (phase === "ready") return "▶ last-call: the window has reset · /last-call go to resume";

  const kind = state.binding ?? (windows.five_hour ? "five_hour" : "seven_day");
  const win = windows[kind];
  if (!win) return undefined;
  const head = `${SHORT[kind]} ${pct(win.percent)}`;
  if (state.overrideUntil && now < state.overrideUntil) return `${head} · guard off until ${fmtWhen(state.overrideUntil, now)}${seven}`;
  const { stopAt } = limitsOf(cfg, kind);
  if (phase === "stopping") return `⛔ ${head} · stopping: handoff only${seven}`;
  const rate = burnRate(win.samples, now);
  const eta = minutesTo(win.percent, stopAt, rate);
  const etaText = eta !== undefined ? ` · ${stopAt}% in ~${fmtDuration(eta * MINUTE)}` : "";
  if (phase === "wrapping") return `⚠ ${head} · wrapping up${etaText}${seven}`;
  const burn = rate !== undefined ? ` · ${pct(rate * 10)}/10m` : "";
  const reset = win.resetsAt ? ` · resets ${fmtWhen(win.resetsAt, now)}` : "";
  return `${head}${burn}${etaText}${reset}${seven}`;
}

export const PING_PROMPT = "last-call keep-alive ping: this only keeps the prompt cache warm. Reply with the single word: ok";

export const ASK_SEND_OFF = "Send, guard off until the reset";
export const ASK_SEND_ONCE = "Send this one only";
export const ASK_DONT = "Don't send";

export function pausedQuestion(state, now) {
  const kind = state.binding;
  const win = kind ? state.windows[kind] : null;
  const until = state.resumeAt ? ` until ${fmtWhen(state.resumeAt, now)}` : "";
  const fill = win ? ` (${windowLabel(kind)} usage at ${pct(win.percent)})` : "";
  return `last-call has paused for the usage limit${until}${fill}. Send this prompt anyway? With "${ASK_SEND_ONCE}" the guard stays on, so the turn may stop again at once.`;
}

export const COLD_COMPACT = "compact";
export const COLD_FULL = "full";
export const COLD_LATER = "later";

export function coldQuestion(state, cfg) {
  const tokens = state.contextTokens ? ` (~${Math.round(state.contextTokens / 1000)}k tokens)` : "";
  const fallback = cfg.coldResumeDefault === "wait"
    ? "Without an answer it stays paused."
    : `Without an answer in ${cfg.coldResumeTimeoutMinutes} min: ${cfg.coldResumeDefault === "compact" ? "compact, then resume" : "resume with the full context"}.`;
  return [
    `The usage window has reset. The prompt cache has expired, so resuming reloads the full context${tokens}.`,
    "Compacting first makes that reload smaller; the handoff note keeps what matters.",
    fallback,
  ].join(" ");
}

export const COLD_OPTIONS = [
  { key: COLD_COMPACT, label: "Compact first, then resume" },
  { key: COLD_FULL, label: "Resume with the full context" },
  { key: COLD_LATER, label: "Not now (/last-call go resumes)" },
];

export function compactInstructions(handoffPath) {
  return `Keep the path of the handoff note (${handoffPath}), the task, and its next step.`;
}

export function report(state, cfg, now) {
  const lines = [`last-call: ${state.phase}${state.binding ? ` (${windowLabel(state.binding)} window)` : ""}`];
  for (const kind of ["five_hour", "seven_day"]) {
    const win = state.windows[kind];
    if (!win) {
      lines.push(`${windowLabel(kind)}: no reading yet (one arrives with the next response)`);
      continue;
    }
    const { stopAt } = limitsOf(cfg, kind);
    const rate = burnRate(win.samples, now);
    const eta = minutesTo(win.percent, stopAt, rate);
    const burn = rate !== undefined ? `, ${pct(rate * 10)} per 10 min${eta !== undefined ? `, ${stopAt}% in ~${fmtDuration(eta * MINUTE)}` : ""}` : "";
    const reset = win.resetsAt ? `, resets ${fmtWhen(win.resetsAt, now)} (in ${fmtDuration(win.resetsAt - now)})` : "";
    lines.push(`${windowLabel(kind)}: ${pct(win.percent)}${burn}${reset}`);
  }
  lines.push(`Thresholds: 5-hour wrap-up ${cfg.wrapAtPercent}%, stop ${cfg.stopAtPercent}%; 7-day wrap-up ${cfg.sevenDayWrapAtPercent}%, stop ${cfg.sevenDayStopPercent}%; or ${cfg.wrapLeadMinutes} min before a projected stop`);
  lines.push(`Resume: ${cfg.autoResume ? "automatic" : "on /last-call go"}; cold cache: ${cfg.coldResumeDefault} after ${cfg.coldResumeTimeoutMinutes} min`);
  lines.push(`Keep-alive: ${cfg.keepAlive ? `every ${cfg.keepAliveMinutes} min while paused, ${cfg.keepAliveSessions === "one" ? "one session at a time" : "every session"}` : "off"}`);
  if (state.phase === "paused") {
    lines.push(state.resumeAt ? `Paused until ${fmtWhen(state.resumeAt, now)} (in ${fmtDuration(state.resumeAt - now)})` : "Paused; the reset time is unknown: /last-call go resumes");
    lines.push(`This pause: keep-alive ${state.keepAlive}${state.keepAliveNote ? ` (${state.keepAliveNote})` : ""}, ${state.pings} ping${state.pings === 1 ? "" : "s"} sent`);
  }
  lines.push(`Handoff note: ${state.handoffTarget ?? "no safe path (check the handoffPath setting)"}${state.handoff ? " (written)" : ""}`);
  if (state.overrideUntil && now < state.overrideUntil) lines.push(`Guard off until ${fmtWhen(state.overrideUntil, now)} (/last-call rearm turns it back on)`);
  return lines.join("\n");
}
