# last-call

Long work in Claude Code shouldn't hit the usage limit mid-step. last-call has the model stop at a clean point and write down where it is. It then waits for the window to reset, keeping the prompt cache warm when that is cheaper than reloading it, and continues the work afterwards.

Terminal only.

## What it does

- **Watches** the 5-hour and 7-day usage windows in the status line: fill, burn rate, time to the stop, and the reset time.
- **Wraps up** at 90% of either window, or earlier when the burn rate puts the stop less than 10 minutes away. The model is told to finish or shelve the current step and, if work remains, to write a handoff note from a fixed template (Task, Done, Next step, Remaining, State not in files, Open questions).
- **Stops** at 95%. Every tool is refused except writing the handoff note; if the model keeps calling tools, the turn is ended.
- **Pauses** until the reset (plus 2 minutes). While it waits, it can keep the cache warm: about every 55 minutes it re-sends the conversation's last request, on the same model, with a one-word question. The API serves that from the cache, which keeps it alive. Pings run only when they cost less than reloading the context once:
  - a cache read is 0.1× of input, against 2× for a 1-hour cache write;
  - a few hours' wait passes; a long 7-day wait does not.
  - If a ping finds the cache already expired, keep-alive switches itself off.
- **Resumes** automatically after the reset, with a prompt to read the handoff note, check it against the repository, continue, and delete it.
  - If the cache has expired, you are asked: compact first, resume with the full context, or not now.
  - With nobody there, the `coldResumeDefault` setting applies after 10 minutes (compact by default).
- **Asks** before sending a prompt you type during the pause: send with the guard off until the reset, send this one only, or don't send.

Notifications fire on wrap-up, stop, pause, resume, and keep-alive problems.

**It continues on its own.** After the reset the work resumes with nobody at the terminal, under the session's permission mode. That is the point of the mod. Turn `autoResume` off if you want to give the go-ahead yourself.

## Commands

| Command | What it does |
|---|---|
| `/last-call` | Status: fills, burn rate, thresholds, pause and keep-alive state |
| `/last-call go` | Resume now (before the reset, this also turns the guard off until the reset) |
| `/last-call override` | Turn the guard off until the reset |
| `/last-call rearm` | Turn it back on |
| `/last-call ping` | Send one keep-alive now and show how much the cache served |

`go`, `override`, `rearm` and `ping` only run when you type them, so the model can't lift its own stop.

## Settings

In `/config`, or under `pluginConfigs["last-call"].options` in settings.json:

| Setting | Default | |
|---|---|---|
| `autoResume` | `true` | Off: wait for `/last-call go` or your next prompt |
| `wrapAtPercent` / `stopAtPercent` | `90` / `95` | 5-hour wrap-up and stop |
| `sevenDayWrapAtPercent` / `sevenDayStopPercent` | `90` / `95` | 7-day wrap-up and stop |
| `wrapLeadMinutes` | `10` | Also wrap up when the stop is projected this close |
| `keepAlive` | `true` | Keep the cache warm while paused |
| `keepAliveMinutes` | `55` | Minutes between pings (5–59) |
| `keepAliveSessions` | `all` | `one`: only one session on this machine pings at a time |
| `handoffPath` | `.claude/last-call/handoff.md` | Must stay inside the project |
| `handoffGitIgnored` | `true` | Adds the note to `.git/info/exclude` (no tracked file changes) |
| `coldResumeDefault` | `compact` | `compact`, `full` or `wait`, when nobody answers |
| `coldResumeTimeoutMinutes` | `10` | How long the cold-resume question waits (1–120) |

## Limits

- Usage readings arrive with API responses. Usage from other sessions, devices or claude.ai shows up at the next response.
- The pause lives in the running session. Quitting Claude Code during the pause ends it.
- Compacting before a cold resume saves less than it may sound: compaction itself sends the whole conversation once (about 1× of input, against about 2× for a full cache reload).
- The resume only starts by itself from a handoff note this session saw written, unchanged since. A note that changed during the pause, or one already in the repository, is not acted on without you.
- If the mod itself fails, it lets the work through. The stop is not guaranteed in that case.
- API-key users have no usage windows, so the mod stays idle.

## Install

```
/plugin install last-call --marketplace Sunkanxx/Mods
```
