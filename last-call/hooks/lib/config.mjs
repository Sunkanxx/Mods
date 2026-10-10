// last-call's settings: the manifest's userConfig values, defaults filled in and
// each held to a range the rest of the mod can rely on.

export const DEFAULTS = {
  autoResume: true,
  wrapAtPercent: 90,
  stopAtPercent: 95,
  sevenDayWrapAtPercent: 90,
  sevenDayStopPercent: 95,
  wrapLeadMinutes: 10,
  keepAlive: true,
  keepAliveMinutes: 55,
  keepAliveSessions: "all",
  handoffPath: ".claude/last-call/handoff.md",
  handoffGitIgnored: true,
  coldResumeDefault: "compact",
  coldResumeTimeoutMinutes: 10,
};

const clamp = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);

export function configFrom(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const stopAt = clamp(o.stopAtPercent, 1, 100, DEFAULTS.stopAtPercent);
  const sevenStop = clamp(o.sevenDayStopPercent, 1, 100, DEFAULTS.sevenDayStopPercent);
  return {
    autoResume: flag(o.autoResume, DEFAULTS.autoResume),
    // A wrap-up threshold above its stop would never be seen.
    wrapAtPercent: clamp(o.wrapAtPercent, 1, stopAt, Math.min(DEFAULTS.wrapAtPercent, stopAt)),
    stopAtPercent: stopAt,
    sevenDayWrapAtPercent: clamp(o.sevenDayWrapAtPercent, 1, sevenStop, Math.min(DEFAULTS.sevenDayWrapAtPercent, sevenStop)),
    sevenDayStopPercent: sevenStop,
    wrapLeadMinutes: clamp(o.wrapLeadMinutes, 0, 120, DEFAULTS.wrapLeadMinutes),
    keepAlive: flag(o.keepAlive, DEFAULTS.keepAlive),
    // A ping has to land inside the cache's 60-minute lifetime to refresh it.
    keepAliveMinutes: clamp(o.keepAliveMinutes, 5, 59, DEFAULTS.keepAliveMinutes),
    keepAliveSessions: oneOf(o.keepAliveSessions, ["all", "one"], DEFAULTS.keepAliveSessions),
    handoffPath: typeof o.handoffPath === "string" && o.handoffPath.trim() ? o.handoffPath.trim() : DEFAULTS.handoffPath,
    handoffGitIgnored: flag(o.handoffGitIgnored, DEFAULTS.handoffGitIgnored),
    coldResumeDefault: oneOf(o.coldResumeDefault, ["compact", "full", "wait"], DEFAULTS.coldResumeDefault),
    coldResumeTimeoutMinutes: clamp(o.coldResumeTimeoutMinutes, 1, 120, DEFAULTS.coldResumeTimeoutMinutes),
  };
}

// The thresholds of one window, by its kind.
export function limitsOf(cfg, kind) {
  return kind === "seven_day"
    ? { wrapAt: cfg.sevenDayWrapAtPercent, stopAt: cfg.sevenDayStopPercent }
    : { wrapAt: cfg.wrapAtPercent, stopAt: cfg.stopAtPercent };
}
