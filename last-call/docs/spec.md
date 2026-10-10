# last-call: spec (draft)

Status: draft for discussion. Nothing is built.

## 1. Goal

Long work in Claude Code should not hit the 5-hour usage limit in the middle of a step. Near the limit, the mod has the model stop at a clean point and save where it is. It then waits for the window to reset, keeping the prompt cache warm if that is cheaper than reloading, and continues the work after the reset.

The 5-hour window is the focus. The 7-day window gets the same wrap-up and stop, with its own thresholds.

**Terminal only** (v1).

## 2. What the mod can rely on (mod API, Claude Code 2.1.296)

| Need | API |
|---|---|
| Fill and reset time of each window | `session.measure` event / `$.session.usage()`: `rateLimits[]` with `kind` (`five_hour`, `seven_day`), `percentUsed` (0–100, one decimal), `resetsAt` (ISO time) |
| Tell the model something mid-turn | `$.session.append` (hidden user note), or `context` on `prompt.submit` |
| Refuse tool calls | `tool.call` hook returning `{ deny }` |
| End a turn | `$.turn.abort({ turnId })` |
| Ask the person | `prompt.submit` hook + a dialog; `{ drop }` keeps a prompt from entering |
| Wait / run later | `$.clock.after`, `$.clock.every` |
| Start a turn by itself (resume) | `$.prompt.submit` |
| Keep-alive on the same model and prefix, without adding to the transcript | `$.model.fork({ prompt })`: re-sends the main thread's last request plus one message; its usage reports `cache_read_input_tokens` |
| Show state | `$.ui.status` (status line), `$.ui.toast`, `$.ui.notify` (terminal/desktop notification) |
| Shared between sessions on the machine | `$.store` (the mod's own JSON store) |
| Settings | manifest `userConfig` (shown in `/config`) |

Constraints:
- Readings come with API responses. When the session is idle, there are no new readings.
- Usage is per account. Other sessions, devices and claude.ai chat move the same fill.
- Timers do not survive a restart of the session.

## 3. Phases

```
normal ──► wrapping ──► stopping ──► paused ──► (ready) ──► normal
              │                        ▲
              └────────────────────────┘   (turn ends while wrapping)
```

| Phase | Entered when | Behaviour |
|---|---|---|
| normal | start; after resume | watch, show status |
| wrapping | either window reaches its wrap threshold, **or** its projected time to stop ≤ lead time | model told to finish at a clean point and write a handoff note |
| stopping | either window reaches its stop threshold | every tool refused except writing the handoff note |
| paused | the main turn ends while wrapping or stopping | wait for the reset; keep-alive if worth it |
| ready | reset passed but auto-resume is off | wait for the go-ahead |

The window that triggered the phase is the **binding window**. Its reset decides the resume time.

Wrapping and stopping are left early only when the binding window actually rolls over: the reset time jumps forward, or the fill drops.

## 4. Projection

- Keep (time, fill) samples from recent readings, for each window.
- Burn rate is the slope over the last ~20 minutes, and needs at least ~3 minutes of history.
- Projected time to stop = (stop − fill) / burn rate.
- Wrap-up starts at whichever comes first: fill ≥ wrap threshold, or projected time to the stop ≤ lead time.
- Status line example: `5h 87% · 1.8%/10m · 95% in ~22m · resets 14:20`. The 7-day fill is added once it passes 80%.

## 5. Wrap-up and stop

**Wrap-up note** (hidden from the person, read by the model): which window, its fill, the projection, the reset time, and these instructions:
- Finish or safely shelve the current step. Start no new sub-tasks or subagents.
- If work remains, write a handoff note: what is done, the exact next step, open questions, and any state that is not in files.
- End the turn with a one-line summary.

**Stop** (decided: refuse tools, end the turn only if ignored):
- `tool.call` refuses every tool, subagents included, except Write/Edit to the handoff note.
- After the note is saved, every tool is refused with "end your turn now."
- If the model makes N more calls after that (proposed 4), the mod ends the turn itself.

The last 5% of the 5-hour window is the reserve for keep-alive pings.

## 6. Handoff note (decided)

- **Location:** a setting. Default `.claude/last-call/handoff.md` in the project.
- **Git-ignored by default** (a setting). The mod adds the path to `.git/info/exclude`, so no tracked file such as `.gitignore` is changed. Turning the setting off leaves git alone.
- After a resume, the model is told to delete the note once it has picked it up.
- **Format** (proposed: a fixed template, free text inside each section). The wrap-up note hands the model this template:

```markdown
# Handoff (last-call, <date time>, <window> at <n>%)

## Task
The original request, in one or two lines.

## Done
- What is finished, and where (files, commits).

## Next step
The exact next action, specific enough to start without re-reading the conversation.

## Remaining
- Steps after the next one, in order.

## State not in files
- Decisions made, assumptions, commands running, things tried that failed.

## Open questions
- Anything that needs the person.
```

  Why a template: the resume reads this note, maybe with a cold cache or after a compact, so it has to stand on its own. Fixed headings make it hard for the model to skip "next step" or "state not in files", which are the parts most often lost.

## 7. Pause and keep-alive

- The pause starts when the main turn ends in wrapping or stopping.
- Resume time = the binding window's reset + a short grace (proposed 2 min).
- **Keep-alive ping:** `$.model.fork` with a one-word question, about every 55 minutes. It runs on the same model and prefix, so it is served from the cache and refreshes it. It adds nothing to the transcript.
- **Cost check:**
  - Pings needed = ⌈(wait − cache TTL) / interval⌉.
  - Ping only when pings × 0.1 (cache read) < 2.0 (one 1-hour cache write).
  - A few hours of waiting passes the check.
- **7-day window** (decided: only when its reset is close):
  - The same cost check applies.
  - The break-even is about 19 pings, roughly 17–18 hours of waiting at 55-minute intervals.
  - Past that, the mod does not ping. It stops with the handoff note and lets the context reload after the reset, because that is cheaper.
  - The mod still auto-resumes after the 7-day reset if autoResume is on.
  - Wrap-up for the 7-day window uses the same rule as the 5-hour one: 90%, or projected time to the stop ≤ lead time.
- **TTL check:** if a ping finds the cache cold (little `cache_read`), the TTL is shorter than one hour. Keep-alive stops and the mod remembers it for later pauses.
- **Ping failure:** on a 429 or other error, stop pinging and say so.

**Several sessions** (decided: setting, default all):
- `keepAliveSessions = all` (default): every paused session pings its own cache.
- `keepAliveSessions = one`: only one session on the machine pings at a time, chosen through a lock in `$.store`. The others reload their context after the reset.

## 8. Prompt typed during the pause (decided: ask)

When the person submits a prompt while paused, the mod asks first:

> Paused for the usage limit until 14:22 (5-hour window at 96%). Send anyway?
> - **Send, guard off until the reset**
> - **Send this one only**: the guard stays on, so it may stop again
> - **Don't send**: the prompt goes back in the box

While the window has reset but is waiting for a go-ahead (ready), the person's prompt is the go-ahead and is sent without asking.

## 9. Resume

- **autoResume on** (default): at the resume time, `$.prompt.submit`: "the window reset; read the handoff note, continue, delete the note."
- **autoResume off:** notify and wait for `/last-call go` (or any prompt).
- **No handoff note:** the work had finished, so only a notification is sent.

**Cold cache at resume** (decided: ask the person). The cache is cold when keep-alive was off, was skipped by the cost check (e.g. a long 7-day wait), or a ping found the cache expired. In that case, before resuming, the mod opens a dialog:

> The usage window reset. The prompt cache has expired, so resuming reloads the full context (~120k tokens).
> - **Compact first, then resume**: a smaller reload; the handoff note carries what matters
> - **Resume with the full context**: everything kept; costs a full cache write
> - **Not now**: stay paused; `/last-call go` resumes

With a warm cache, the mod resumes without asking.

What compacting saves: compaction itself sends the whole conversation once, uncached (about 1× the context's input price), against about 2× for writing the full context to the 1-hour cache. It is cheaper, and later turns are smaller, but the saving is moderate rather than large.

**Nobody answers** (decided: a setting). If the dialog gets no answer within `coldResumeTimeoutMinutes` (default 10), the mod applies `coldResumeDefault`:
- `compact` (default): compact, then resume.
- `full`: resume with the full context.
- `wait`: no timeout; stay paused until the person answers.

## 10. What the person sees (decided: status line + notifications)

**Status line**, always: fill, burn, projection, reset time, phase.

**Notifications** via toast and `$.ui.notify` for:
- wrap-up started (which window, %)
- stop reached
- paused until hh:mm
- resumed, or reset waiting for a go-ahead
- keep-alive stopped (cold cache or error)

## 11. Commands and settings

Commands:
- `/last-call`: status
- `go`: resume now
- `override`: turn the guard off until the reset
- `rearm`: turn it back on
- `ping`: send one keep-alive now and report how much the cache served

| Setting | Default |
|---|---|
| autoResume | true |
| wrapAtPercent (5h) | 90 |
| stopAtPercent (5h) | 95 |
| sevenDayWrapAtPercent | 90 |
| sevenDayStopPercent | 95 |
| wrapLeadMinutes | 10 |
| keepAlive | true |
| keepAliveMinutes | 55 (capped below 60) |
| keepAliveSessions | all (or one) |
| handoffPath | `.claude/last-call/handoff.md` |
| handoffGitIgnored | true |
| coldResumeDefault | compact (or full, wait) |
| coldResumeTimeoutMinutes | 10 |

## 12. Distribution

Published in the `sunkanxx-mods` marketplace next to `lessons-learned`, in its own folder `last-call/` with a README and licence.

No automated test suite is planned for v1.

## 13. Out of scope (v1)

- Desktop app, IDE extensions, mobile and cloud sessions (terminal only).
- API-key / pay-as-you-go users (no rate-limit windows; the mod stays idle).
- Surviving a restart of Claude Code during the pause.

## 14. Open questions

None at the moment.
