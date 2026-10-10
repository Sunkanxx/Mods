export type WindowKind = "five_hour" | "seven_day";
export type Sample = { t: number; p: number };
export type WindowState = { percent: number; resetsAt: number | null; samples: Sample[] };
export type Phase = "normal" | "wrapping" | "stopping" | "paused" | "ready";
export type KeepAliveState = "off" | "on" | "cold" | "failed";
export type Handoff = { path: string; writtenAt: number; hash: string };

export type GuardState = {
  phase: Phase;
  binding: WindowKind | null;
  windows: { five_hour: WindowState | null; seven_day: WindowState | null };
  contextTokens: number | null;
  resumeAt: number | null;
  pausedAt: number | null;
  lastCacheTouch: number | null;
  keepAlive: KeepAliveState;
  keepAliveNote: string | null;
  pings: number;
  lastPingAt: number | null;
  handoff: Handoff | null;
  handoffTarget: string | null;
  excludeDone: boolean;
  denials: number;
  overrideUntil: number | null;
  returnToPause: boolean;
  resumeStarted: boolean;
  cwd: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'last-call': { guard: GuardState };
  }
}
