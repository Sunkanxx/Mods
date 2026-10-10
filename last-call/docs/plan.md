# last-call: implementation plan

Status: plan only. Nothing is built. Source: `docs/spec.md`. API facts are from the mod API of Claude Code 2.1.296 (`claude-code.d.ts`).

This version is the reviewed one. §5 lists what the review changed, and §6 is the security review, whose fixes are folded into the steps (marked **[S#]**).

## 1. Layout

The layout follows `lessons-learned`: an `.mjs` hooks module, with pure logic in `hooks/lib/`.

```
last-call/
  .claude-plugin/plugin.json     manifest, userConfig (spec §11), "types"
  hooks/hooks.json               { "modules": ["./last-call.mjs"] }
  hooks/last-call.mjs            hooks and every function that takes $
  hooks/lib/config.mjs           settings: defaults, bounds, validation
  hooks/lib/readings.mjs         windows, samples, burn rate, projection
  hooks/lib/phases.mjs           phase machine, binding window, resume time
  hooks/lib/keepalive.mjs        cost check, cache-warm check, ping due
  hooks/lib/handoff.mjs          path checks, template, exclude line
  hooks/lib/texts.mjs            notes to the model, dialogs, status line, /last-call report
  types/index.d.ts               PluginState contract (session state)
  README.md, LICENSE, tsconfig.json
```

The marketplace gets one entry in `.claude-plugin/marketplace.json`, plus a row in the root README.

## 2. State

**Session state** (`$.state`, key `last-call.guard`). It survives a hot reload and drives the status line.
- `phase`
- `binding`: `five_hour` or `seven_day`
- `windows`: per kind, `{ percent, resetsAt, samples[] }`
- `contextTokens`
- `resumeAt`, `pausedAt`, `lastCacheTouch`
- `keepAlive` (`off` / `on` / `cold` / `failed`), `pings`
- `handoff`: `{ path, writtenAt, hash }` or null. This is the note this session saw written. **[S2]**
- `denials`, `overrideUntil`
- `returnToPause`: set by "Send this one only".
- `cwd`

**Cross-session** (`$.store`):
- `cacheShortLived`: true after a ping found the cache cold.
- `pingLock`: `{ sessionId, until }`, used when `keepAliveSessions = one`.

**Module variables**, rebuilt on load: `cfg`, the running `turnId`, timer handles, the open dialog's id.

## 3. Steps

Each step lists what to build and the check that shows it is done.

### Step 1: Skeleton and settings
- Manifest with every setting from spec §11, hooks.json, an empty `register`, and the contract.
- `lib/config.mjs` bounds every value:
  - percents are 1–100, and wrap ≤ stop;
  - `keepAliveMinutes` is 5–59;
  - `coldResumeTimeoutMinutes` is 1–120;
  - enums fall back to their default.
- Done when `claude plugin validate` passes.

### Step 2: Readings and projection (`lib/readings.mjs`)
- `windowOf(rateLimits, kind)`
- `addSample` (drop samples older than 60 min; reset on a fall in the fill)
- `burnRate` (slope over 20 min, at least 3 min of history)
- `minutesTo(percent, stop, rate)`
- `hasRolled(before, after)`: the reset jumps by more than 1 h, or the fill drops by more than 5 points.

### Step 3: Phases (`lib/phases.mjs`)
- `nextPhase(state, cfg, now)` evaluates both windows. It picks the binding window as the one at the more advanced phase; on a tie, the one with the earlier projected stop.
- `paused` and `ready` are never left by a reading.
- `wrapping` and `stopping` are left only when the binding window rolls over.
- An override in force makes the phase `normal`.
- `resumeTime` = binding reset + 2 min.

### Step 4: Hooks: watch and announce (`last-call.mjs`)
- `session.start`:
  - register `/last-call`;
  - store `cwd`;
  - start a 60 s `$.clock.every` tick;
  - after a hot reload, re-arm from state. The tick alone carries the timing, so there is nothing else to re-arm.
- `session.measure` (on `rateLimits` or `context`): update the state, compute the phase. On a change, append the wrap-up or stop note (`$.session.append`, user, hidden), and send a toast and a notify.
- The wrap-up note holds the template and the exact resolved handoff path.
- The status line is refreshed on every reading and every tick.

### Step 5: Stop (`tool.call`)
- The stop applies to every tool, subagents included. While stopping, it refuses everything except Write/Edit whose `file_path`, once resolved, **equals** the handoff path. That means an exact match on the resolved path, not an `endsWith`. **[S1]**
- A successful write records `handoff = { path, writtenAt, hash of content }`. For an Edit, the hash is taken from a re-read of the file.
- Writes to the handoff path made while wrapping are recorded the same way.
- After the note is saved, every call is refused with "end your turn".
- After 4 refusals the mod calls `$.turn.abort({ turnId })` (the `turnId` comes from `turn.start`).
- `.catch` answers `next(e)`. A failure in the mod lets work through, so availability wins over enforcement (see S7).

### Step 6: Handoff note (`lib/handoff.mjs`)
- **Resolving `handoffPath`** **[S1]**:
  - resolve it against the project root (`$.session.root()`, or `cwd`);
  - `$.fs.stat(..., { resolve: true })` on the parent directory;
  - reject the path if its `realPath` lies outside the project root, or if the note itself is a symlink;
  - an invalid setting falls back to the default and notifies once.
- **Git ignore**, with `handoffGitIgnored` on, the first time a wrap-up happens:
  - find the exclude file with `$.process.run(["git", "rev-parse", "--git-path", "info/exclude"])`. This works in worktrees, where `.git` is a file (we hit this while writing the spec);
  - not a git repo: skip;
  - read the file, and append the line only if it is missing. The line is the note's path relative to the repo root, anchored with a leading `/`, with glob characters escaped. A path containing a newline is rejected. **[S4]**

### Step 7: Pause and keep-alive (`lib/keepalive.mjs`)
- `turn.complete`, main loop only: if the phase is wrapping or stopping, take a fresh reading (`$.session.usage()`) and enter `paused`.
- If the person sent a prompt with "Send this one only" (`returnToPause`), the end of that turn returns to `paused` with the old `resumeAt`.
- Cost check: `pings = ceil((wait − 60 min) / interval)`; keep-alive is worth it when `pings × 0.1 < 2.0`, and is off when `cacheShortLived` is set.
- The tick:
  - pings when `now − lastCacheTouch ≥ interval` and the cache would lapse before the resume;
  - a ping is `$.model.fork({ prompt: PING })`;
  - `cache_read` below 50% of the input means the cache was cold: set `cacheShortLived` and stop keep-alive;
  - an API error stops keep-alive and notifies.
- **Hard limits** **[S5]**:
  - at most `ceil(wait / interval) + 1` pings per pause;
  - never two pings less than 5 minutes apart;
  - only one ping in flight at a time.
- `keepAliveSessions = one`: before pinging, read `pingLock`. If it is free or expired, write `{ sessionId, until: now + interval + 5 min }`, read it back, and ping only if the lock is still this session's.
  - `$.store` has no compare-and-set, so two sessions can still both win. The only result is one extra ping, which is accepted (S6).
- **Cache warm at resume:** `now − lastCacheTouch < 60 min`, and `cacheShortLived` is not set (if it is set, the check is `< 5 min`).

### Step 8: Prompt typed during the pause (`prompt.submit`)
- Only for user origins (`composer`, `bridge`). The mod's own resume prompt has a plugin origin and passes untouched.
- `paused`: a dialog with the three options from spec §8. It uses the same pane dialog as Step 9.
  - **Send, guard off:** set `overrideUntil` = the binding reset, end the pause, then `next(e)`.
  - **Send this one only:** set `returnToPause`, set the phase to `normal`, then `next(e)`. The thresholds stay in force, so at 95%+ this turn stops again. The dialog text says so.
  - **Don't send**, or a dismissed dialog: answer `{ drop }` and put the text back with `$.prompt.fill`. **[S8]**
- `ready`: the prompt is the go-ahead, so clear the pause and pass it on.

### Step 9: Resume
- At `resumeAt` the tick decides:
  1. **No handoff note in state, or the note fails its check:** notify and stay `ready`; do not auto-resume. **[S2]**
  2. **autoResume off:** go to `ready` and notify.
  3. **Cache warm:** `$.prompt.submit(resume text)`.
  4. **Cache cold:** the cold-resume dialog.
- **The handoff note's check** **[S2]**: the file exists at the recorded path, its content hash matches the one recorded, and it is not a symlink.
- **The dialog is a pane, not `$.ui.ask`**, because `$.ui.ask` cannot be closed by the mod and has no timeout:
  - opened with `$.ui.open({ id, focus: true, closeOnEscape: true, holdToasts: true })`;
  - drawn by a `ui.render` hook on `Pane` with three Buttons;
  - closed by `$.ui.close` when answered or when `coldResumeTimeoutMinutes` passes, after which `coldResumeDefault` applies;
  - a press after it closed is ignored.
- **Compact** = `$.session.compact({ instructions: "Keep the handoff note path <path> and its next step." })`, then submit.
- **The resume text** frames the note as the model's own notes from before the pause. It tells the model to verify against the repository before acting, and to delete the note after picking it up. **[S2]**
- `/last-call go` reaches the same function, through `$.clock.after(0)`, because a `command.run` hook may not submit a prompt itself.

### Step 10: Commands
- `/last-call`: report
- `go`
- `override`
- `rearm`
- `ping`

`go`, `override` and `rearm` are refused unless `e.origin.kind` is `composer` or `bridge`, so the model cannot lift its own stop. **[S10]**

### Step 11: README, marketplace entry, manual check
- Load the mod with hot reload.
- In a real session:
  - `/last-call` shows readings;
  - `/last-call ping` shows the cache served;
  - the wrap-up and stop notes read correctly. Set `wrapAtPercent` just above the current fill to see them without going near the limit.
- No automated tests (spec §12).

## 4. Order and size

Steps 1–4 are the watch-only core (status line). Steps 5–7 add the stop and pause. Steps 8–9 add the dialogs and resume. Steps 10–11 finish it.

Steps 1–4 are worth a first manual check before going on.

## 5. Review: what changed from the first draft

| # | Problem in the draft | Correction |
|---|---|---|
| R1 | The cold-resume dialog used `$.ui.ask` "raced against a timeout". `$.ui.ask` cannot be closed by the mod, so the dialog would stay open after the default ran, and a late answer would act a second time. | A pane dialog the mod opens and closes (Step 9). |
| R2 | The exclude line was written to `<cwd>/.git/info/exclude` with `$.fs.write`. That fails in worktrees, where `.git` is a file. `fs.write` also replaces the whole file. | `git rev-parse --git-path`, then read and append (Step 6). |
| R3 | "Cache warm" was used at resume but never defined. | Defined from `lastCacheTouch` and `cacheShortLived` (Step 7). |
| R4 | "Send this one only" set an `allowOnce` that suppressed the stop. That contradicts spec §8 ("the guard stays on"). | `returnToPause`: thresholds apply, and the pause resumes after that turn (Steps 7–8). |
| R5 | The `pingLock` was treated as a real lock. `$.store` has no compare-and-set. | Write, read back, accept a rare double ping (Step 7). |
| R6 | No bounds on settings: a 0% stop or a 1-minute ping interval would break the mod. | `lib/config.mjs` (Step 1). |
| R7 | Spec §9 calls "compact first" the cheaper reload. Compaction itself sends the whole transcript once, uncached, so it costs about 1× the context against about 2× for a 1-hour cache write. It is cheaper, and later turns get smaller, but not dramatically. | Keep the option. The dialog says "smaller reload" rather than promising a large saving. **Spec wording to update.** |
| R8 | Handoff matched by `endsWith`, so any path ending in `.claude/last-call/handoff.md` passed the stop. | Exact match on the resolved path (Step 5, S1). |
| R9 | No limit on pings if the tick logic misfires. | Hard limits (Step 7, S5). |

## 6. Security review

Scope: what the mod can be made to do, by the model, by repository content, or by a mistake in its own logic. It runs inside Claude Code with the user's permissions. It writes one file and one git exclude line, runs `git`, sends model requests (pings, compaction), and submits prompts while the person may be away.

| # | Risk | Severity | Mitigation in the plan |
|---|---|---|---|
| S1 | **The handoff path as a write hole.** During the stop the guard allows exactly one write target. If `handoffPath` pointed outside the project (`~/.bashrc`, an absolute path, `..`, a symlink), the stop would let the model write there, and the wrap-up note would tell it to. An `endsWith` match would also let a look-alike path through. | High | The path is resolved and must stay inside the project root. Symlinks are rejected. The tool call must match the resolved path exactly (Steps 5–6). |
| S2 | **The handoff note as a persistent prompt injection.** The resume sends the model to read a file and act on it, possibly with nobody watching. A note planted in the repository (a cloned repo shipping `.claude/last-call/handoff.md`), or changed during the pause by another process, would be executed unattended. | High | Auto-resume only from a note this session saw written, with a matching hash and no symlink. Otherwise the mod goes to `ready` and waits for the person. The resume text frames the note as the model's own notes and tells it to verify them against the repository. The note is git-ignored by default and deleted after resume (Steps 5, 9). |
| S3 | **Unattended continuation.** Auto-resume runs hours later under the session's permission mode. In `bypassPermissions` or `auto` mode, it continues editing and running commands with nobody present. | Medium, accepted | Decided: this is the purpose of the mod. Auto-resume is kept in every permission mode. The mod does not raise permissions; it submits one prompt like a typed one. Notifications fire on resume. The README states this plainly, and `autoResume` can be turned off. |
| S4 | **Writing the git exclude file.** A crafted path could inject extra lines (a newline) or patterns (`!`, `#`, globs) into `info/exclude`. | Low | Newlines are rejected, glob characters are escaped, the line is anchored with `/`, and the file is append-only. `git` runs by argv with no shell, and with repo hooks off (API guarantee) (Step 6). |
| S5 | **Runaway cost.** A logic error could ping every tick, or loop compact and resume, burning usage. That is the very thing the mod exists to protect. | Medium | A per-pause ping cap, a minimum spacing, one ping in flight, and a single resume per pause (Step 7). |
| S6 | **Cross-session lock race.** Two sessions can both take `pingLock`. | Low | The only effect is an extra ping. Accepted. |
| S7 | **Fail-open guard.** If a `tool.call` hook throws, work continues past the stop, and the 5% reserve is not guaranteed. | Low (cost, not safety) | Deliberate: a broken mod must not block the person's work. The failure lands in the debug log. Documented in the README. |
| S8 | **Ambiguous dialog answers.** `$.ui.ask` returns free text typed under "Other". A loose comparison could read it as "Send". | Low | Own pane dialog with fixed buttons. Anything other than an explicit button, including a dismissal, is "Don't send" (Step 8). |
| S9 | **What the mod sends to the model.** Notes contain only numbers, times and the resolved path, with no transcript content and no external input. Pings and compaction send the existing transcript to the same provider and model the session already uses. | None new | None needed. Pings must not use a different model (that would also break the cache). |
| S10 | **The model turning its own guard off.** If the model can run `/last-call override` or `go` (through a command tool), it could lift the stop. During wrap-up it could also edit settings files to change the thresholds. | Medium | `go`, `override` and `rearm` require a user origin (Step 10). Settings edits during wrap-up are not blocked: the model could already edit any file before the stop, and doing so would be visible in the transcript. Noted as accepted. |
| S11 | **Data written by the mod.** The handoff note may contain summaries of private work. | Low | It stays in the project, git-ignored by default, and is deleted after resume. The mod sends nothing anywhere else and has no network access of its own. |

No open questions.

## 7. Implementation notes (what differs from the plan)

- **Hooks module is `last-call.jsx`, not `.mjs`:** the cold-resume dialog draws a pane, and JSX keeps that readable. The pure logic stays in `hooks/lib/*.mjs`.
- **The prompt-during-pause question uses `$.ui.ask`, not the pane dialog.**
  - A hook may not wait on its own promise past its time budget, but a `$` call in flight does not count against it. `$.ui.ask` is such a call.
  - That question needs no timeout.
  - An exact label match is required, and anything else means "Don't send", so S8 still holds.
- **The pane dialog is used only for the cold resume**, which runs from the tick rather than inside a hook, and needs the timeout.
- **A reload while the cold dialog is open** drops the dialog. `session.start` clears `resumeStarted`, so the tick asks again.

## 8. Security review of the implementation

Done after all steps, against the code.

| # | Finding | Fix |
|---|---|---|
| F1 | **A turn could run during the pause.** A background task's notification is not a user prompt, so it passed the pause untouched, and its turn could use tools and spend the keep-alive reserve. | While paused, every tool except AskUserQuestion is refused with "paused, end your turn". The mod's own question during the pause is an AskUserQuestion call. |
| F2 | **Control characters in `handoffPath`.** The path is quoted into the notes the model reads, so a setting with a newline could smuggle extra lines in. | Paths with control characters are rejected; the default path is used instead. |
| F3 | **An unhandled rejection.** `$.prompt.fill` failing after "Don't send" was unhandled. | Caught. |
| F4 | **The note's safety at write time.** It was checked only at session start, so a symlink planted later could redirect the one allowed write. | Re-checked at the write during the stop, and again before any resume (already in the plan as S1/S2). Confirmed in the code. |
| F5 | **Git and the exclude file.** `git` runs by argv with no shell. The exclude line is anchored, escaped and free of newlines, and the file is only appended to. `--path-format=absolute` was dropped for older gits; a relative answer is resolved against the session's directory. | None needed beyond that. |

Checked and found fine:
- **Commands:** `go`, `override`, `rearm` and `ping` refuse unless typed (`composer` or `bridge` origin).
- **Pings:** capped per pause, at least 5 minutes apart, one in flight.
- **Resume:** one per pause (`resumeStarted`). It runs only from the recorded note, with the same hash, inside the project, and not a symlink.
- **Dialog:** a late or out-of-date answer is ignored.
- **Network:** the mod has none of its own. Pings and compaction go to the session's own model.
