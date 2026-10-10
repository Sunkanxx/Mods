// last-call's readings: the usage windows as the API reports them, their recent
// history, the burn rate and the projected time to a threshold.
// Pure functions of plain values; nothing here takes $.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const KINDS = ["five_hour", "seven_day"];

const SAMPLE_KEEP_MS = HOUR;
const RATE_SPAN_MS = 20 * MINUTE;
const MIN_SPAN_MS = 3 * MINUTE;
// How far the reset must jump, or the fill fall, to count as a new window.
const ROLL_RESET_JUMP_MS = HOUR;
const ROLL_FILL_DROP = 5;

// One window of a reading's rateLimits: { percent, resetsAt (ms) }, or null.
export function windowOf(rateLimits, kind) {
  const w = (rateLimits ?? []).find((r) => r.kind === kind);
  if (!w || !Number.isFinite(w.percentUsed)) return null;
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return { percent: w.percentUsed, resetsAt: Number.isFinite(at) ? at : null };
}

// Whether the window rolled over between two readings.
export function hasRolled(before, after) {
  if (!before || !after) return false;
  if (before.resetsAt && after.resetsAt && after.resetsAt - before.resetsAt > ROLL_RESET_JUMP_MS) return true;
  return after.percent + ROLL_FILL_DROP < before.percent;
}

// The window's history with a new reading added; a fall starts it over.
export function addSample(samples, t, percent) {
  const last = samples[samples.length - 1];
  if (last && percent < last.p) return [{ t, p: percent }];
  if (last && last.p === percent && t - last.t < MINUTE) return samples;
  return [...samples.filter((s) => t - s.t <= SAMPLE_KEEP_MS), { t, p: percent }];
}

// Percent per minute over recent history; undefined until there is enough.
export function burnRate(samples, now) {
  const recent = samples.filter((s) => now - s.t <= RATE_SPAN_MS);
  if (recent.length < 2) return undefined;
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (last.t - first.t < MIN_SPAN_MS) return undefined;
  return Math.max(0, ((last.p - first.p) / (last.t - first.t)) * MINUTE);
}

// Minutes until the fill reaches target at this rate; undefined when not climbing.
export function minutesTo(percent, target, rate) {
  if (rate === undefined || rate <= 0) return undefined;
  return Math.max(0, (target - percent) / rate);
}

// A window's state after a reading: the new figures and the sample history.
export function nextWindow(before, reading, now) {
  if (!reading) return before;
  const samples = before && !hasRolled(before, reading) ? before.samples : [];
  return { percent: reading.percent, resetsAt: reading.resetsAt, samples: addSample(samples, now, reading.percent) };
}
