// last-call's phases: normal → wrapping → stopping → paused → ready → normal.
// Pure functions of plain values; nothing here takes $.

import { limitsOf } from "./config.mjs";
import { KINDS, MINUTE, burnRate, minutesTo, hasRolled } from "./readings.mjs";

const RANK = { normal: 0, wrapping: 1, stopping: 2 };
const RESUME_GRACE_MS = 2 * MINUTE;

export function initialState() {
  return {
    phase: "normal",
    binding: null,
    windows: { five_hour: null, seven_day: null },
    contextTokens: null,
    resumeAt: null,
    pausedAt: null,
    lastCacheTouch: null,
    keepAlive: "off",
    keepAliveNote: null,
    pings: 0,
    lastPingAt: null,
    handoff: null,
    handoffTarget: null,
    excludeDone: false,
    denials: 0,
    overrideUntil: null,
    returnToPause: false,
    resumeStarted: false,
    cwd: null,
  };
}

// What one window alone asks for, and how soon it reaches its stop.
export function windowVerdict(win, cfg, kind, now) {
  if (!win) return { phase: "normal", eta: undefined };
  const { wrapAt, stopAt } = limitsOf(cfg, kind);
  const eta = minutesTo(win.percent, stopAt, burnRate(win.samples, now));
  if (win.percent >= stopAt) return { phase: "stopping", eta: 0 };
  if (win.percent >= wrapAt || (eta !== undefined && eta <= cfg.wrapLeadMinutes)) return { phase: "wrapping", eta };
  return { phase: "normal", eta };
}

// The phase and binding window after a reading. A pause is left only by its
// timer, a command or the person; wrapping and stopping only when the binding
// window rolled over (rolled: the kinds that rolled in this reading).
export function nextPhase(state, cfg, now, rolled = []) {
  if (state.phase === "paused" || state.phase === "ready") return { phase: state.phase, binding: state.binding };
  if (state.overrideUntil && now < state.overrideUntil) return { phase: "normal", binding: null };

  let best = { phase: "normal", binding: null, eta: Infinity };
  for (const kind of KINDS) {
    const v = windowVerdict(state.windows[kind], cfg, kind, now);
    const eta = v.eta ?? Infinity;
    if (RANK[v.phase] > RANK[best.phase] || (RANK[v.phase] === RANK[best.phase] && v.phase !== "normal" && eta < best.eta)) {
      best = { phase: v.phase, binding: kind, eta };
    }
  }

  // Sticky: the phase in force stays until its binding window rolls over.
  const held = state.binding && !rolled.includes(state.binding) ? state.phase : "normal";
  if (RANK[held] > RANK[best.phase]) return { phase: held, binding: state.binding };
  return { phase: best.phase, binding: best.binding };
}

export function rolledKinds(windowsBefore, readings) {
  return KINDS.filter((k) => hasRolled(windowsBefore[k], readings[k]));
}

// When to resume: just after the binding window's reset; null when unknown.
export function resumeTime(state) {
  const resetsAt = state.binding ? state.windows[state.binding]?.resetsAt : null;
  return resetsAt ? resetsAt + RESUME_GRACE_MS : null;
}
