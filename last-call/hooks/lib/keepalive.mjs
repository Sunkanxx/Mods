// last-call's keep-alive: whether pinging pays, when a ping is due, and whether
// the cache is still warm. Pure functions of plain values; nothing here takes $.

import { MINUTE, HOUR } from "./readings.mjs";

// The cache's lifetime the mod plans around (Claude Code writes 1-hour entries;
// a ping that finds the cache cold proves otherwise and keep-alive stops).
export const CACHE_TTL_MS = HOUR;
// A cache read costs 0.1x of plain input; a 1-hour cache write 2x.
export const CACHE_READ_COST = 0.1;
export const CACHE_WRITE_COST = 2.0;
// Never two pings closer than this, whatever the tick does.
export const MIN_PING_GAP_MS = 5 * MINUTE;
// Below this many tokens the cache may hold nothing, so a ping proves nothing.
const MIN_CACHEABLE_TOKENS = 4096;

// The trade for a wait: N pings at a cache read each, or one cache write.
export function keepAlivePlan(waitMs, intervalMs) {
  const pings = waitMs <= CACHE_TTL_MS ? 0 : Math.ceil((waitMs - CACHE_TTL_MS) / intervalMs);
  const pingCost = pings * CACHE_READ_COST;
  return { pings, pingCost, isWorth: pings > 0 && pingCost < CACHE_WRITE_COST };
}

// The most pings one pause may send: the plan's count and one to spare.
export function maxPings(state, cfg) {
  if (!state.resumeAt || !state.pausedAt) return 0;
  return Math.ceil((state.resumeAt - state.pausedAt) / (cfg.keepAliveMinutes * MINUTE)) + 1;
}

// A ping is due when the cache would otherwise lapse before the resume.
export function isPingDue(state, cfg, now) {
  if (state.phase !== "paused" || state.keepAlive !== "on" || !state.lastCacheTouch) return false;
  if (state.resumeAt && state.lastCacheTouch + CACHE_TTL_MS >= state.resumeAt) return false;
  if (state.lastPingAt && now - state.lastPingAt < MIN_PING_GAP_MS) return false;
  if (state.pings >= maxPings(state, cfg)) return false;
  return now - state.lastCacheTouch >= cfg.keepAliveMinutes * MINUTE;
}

// What a ping's usage says of the cache: true warm, false cold, undefined unknown.
export function cacheWasWarm(usage) {
  const total = usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens;
  if (total < MIN_CACHEABLE_TOKENS) return undefined;
  return usage.cache_read_input_tokens >= total / 2;
}

// Whether the cache still holds the conversation at the resume.
export function isWarmAt(state, now, isShortLived) {
  if (!state.lastCacheTouch) return false;
  return now - state.lastCacheTouch < (isShortLived ? 5 * MINUTE : CACHE_TTL_MS);
}

// The pause's keep-alive decision: { keepAlive, note }.
export function keepAliveDecision(cfg, waitMs, isShortLived) {
  if (!cfg.keepAlive) return { keepAlive: "off", note: "turned off in settings" };
  if (isShortLived) return { keepAlive: "off", note: "an earlier ping found the cache expired; /last-call ping re-tests it" };
  if (waitMs === null) return { keepAlive: "off", note: "reset time unknown" };
  const plan = keepAlivePlan(waitMs, cfg.keepAliveMinutes * MINUTE);
  if (plan.pings === 0) return { keepAlive: "off", note: "the cache outlives the wait" };
  if (!plan.isWorth) return { keepAlive: "off", note: `${plan.pings} pings would cost more than reloading the context once` };
  return { keepAlive: "on", note: `${plan.pings} ping${plan.pings === 1 ? "" : "s"} planned (~${plan.pingCost.toFixed(1)}x context vs ${CACHE_WRITE_COST}x to reload)` };
}

// The ping lock for keepAliveSessions = one: free, or held by this session.
export function lockIsOurs(lock, sessionId, now) {
  return !lock || lock.sessionId === sessionId || lock.until <= now;
}
