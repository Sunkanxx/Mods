# lessons-learned 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far fewer "Save it?" dialogs: a detector that must name the mistake, and no dialogs while working (a silent queue, a status line count, one question at session start).

**Architecture:** The detector library (`hooks/lib/detector.mjs`) gains a required `mistake` field and a stricter system prompt. The hooks module (`hooks/lessons-learned.mjs`) stops asking at `turn.complete` unless `askAt = turn end`, caps the queue at 10, keeps a status line count, and asks one question at session start after project setup. The 0.1.x `review` list is folded into `queue`.

**Tech Stack:** Claude Code mod API (hooks module, `.mjs`), tests with `claude plugin test` (`claude-code/testing`), no other dependencies.

**Spec:** `lessons-learned/docs/design.md` (§5.2, §5.3, §5.6, §6, §7, §8, §9.5, §12).

## Global Constraints

- Run every command from `lessons-learned/`. Tests: `claude plugin test`. Manifest/source check: `claude plugin validate .`.
- Status line text exactly `lessons: N to review` (N ≥ 1); cleared with `$.ui.status(undefined)` at 0.
- Session-start question exactly: `lessons-learned has N possible lessons from earlier corrections. Review them now?` (`N possible lesson` singular for 1), options `Review now` · `Later` · `Discard all`, header `Lesson`.
- Dialog prefix exactly `You corrected: <mistake> — ` when the item has a `mistake`.
- `mistake`: cleaned with `cleanBody`, then cut to 160 characters (code points, `…` appended when cut, like `truncate` in `confirm.mjs`).
- Queue cap 10, newest kept. `askAt` options `session start` (default), `never`, `turn end`.
- Store keys: `queue` (unchanged), `review` (read once for migration, then deleted), `offeredSession` (new).
- Never write `mistake` to a lessons or rules file.

## Review Focus

1. A module reload in the same session (`/reload-plugins`) must not ask the session-start question twice → Task 3 test `reload in the same session does not ask again`.
2. Items tied to another repo must not be counted, asked about, or discarded here → Task 2 test `status counts only items this session can take`, Task 3 test `Discard all leaves another repo's items`.
3. A user upgrading from 0.1.x has a `review` list and queue items without `mistake` → Task 3 tests `0.1.x review items move into the queue` and Task 1 test `an item without mistake has no prefix`.
4. Project setup and the session-start question in the same session start must not open two dialogs at once → Task 3 test `setup question first, review question after it`.
5. `claude -p` (no surfaces) must not ask and must not record `offeredSession` → Task 3 test `no surfaces: no question, nothing recorded`.

---

### Task 1: Stricter detector

**Files:**
- Modify: `hooks/lib/detector.mjs` (`DETECTOR_SYSTEM`, `parseDetectorReply`)
- Modify: `hooks/lib/confirm.mjs` (`dialogFor`)
- Modify: `eval/cases.json` (new look-alikes N16–N21)
- Test: `tests/detector.test.ts`, `tests/confirm.test.ts`; update `tests/capture.test.ts` (`detected()` gains `mistake`), `tests/commands.test.ts` and any other scripted detector reply

**Interfaces:**
- Produces: `parseDetectorReply(raw, ctx)` returns `{ mistake: string, title, body, tags, scope, repeatOf, repeatKind }` or `null`; `MISTAKE_MAX = 160` exported from `detector.mjs`. `dialogFor(item, ctx)` unchanged signature; `item.detection.mistake` optional.

- [ ] **Step 1: Write failing tests** in `tests/detector.test.ts`:
  - `a reply without mistake is no correction`: `parseDetectorReply(JSON.stringify({correction:true,title:"T",body:"B.",tags:["a b"],scope:"global",repeatOf:null}), ctx)` → `null`; same with `mistake: "  "` → `null`.
  - `mistake is cleaned and cut`: a mistake with a newline and `@evil.md` comes back on one line with `＠evil.md`; a 300-char mistake comes back as 160 chars + `…` (161 code points).
  - `the prompt names the new rules`: `DETECTOR_SYSTEM` contains `name the mistake`, `When unsure`, `feature requests`, `"mistake"`.
  - In `tests/confirm.test.ts`: `dialog starts with the mistake` (`dialogFor` with `mistake: "ran it in Git Bash"` → question starts `You corrected: ran it in Git Bash — Lesson (`), for all three kinds; `an item without mistake has no prefix` (question starts `Lesson (`).
- [ ] **Step 2: Run** `claude plugin test` → the new tests FAIL.
- [ ] **Step 3: Implement.** `DETECTOR_SYSTEM` gets the spec §5.2 wording (counts-only-if-you-can-name-it paragraph, the longer "doesn't count" list, "When unsure", the `mistake` instruction, `mistake` in the JSON shape). `parseDetectorReply` rejects a missing/blank `mistake`, cleans it with `cleanBody` and cuts it to `MISTAKE_MAX`. `dialogFor` prefixes `You corrected: ${d.mistake} — ` to every question when `d.mistake` is a non-empty string.
- [ ] **Step 4: Update scripted replies**: `detected()` in `tests/capture.test.ts` and every other test reply with `correction: true` gains `mistake: "Ran it in Git Bash."` (expected question strings gain the prefix). Add eval look-alikes to `eval/cases.json`, `expect: "none"`: N16 one-off copy edit ("remove the dashes from the English download button text"), N17 a feature request about a settings screen ("i would want options users choose with the keyboard, defaults filled in"), N18 a complaint about a plugin firing too often, N19 "Delete the merged branches locally and on GitHub", N20 "Run the tests so we have a baseline", N21 "ok, now do the same for the other mod". Keep `tests/eval.test.ts` unchanged (it builds its own cases).
- [ ] **Step 5: Run** `claude plugin test` → all PASS.
- [ ] **Step 6: Review and refactor** the diff (names, comments match the file's style, no duplication between `truncate` copies — export one if both files need it), re-run tests.
- [ ] **Step 7: Commit** `feat(lessons-learned): detector must name the mistake`.

### Task 2: Quiet queue — askAt, cap, status line

**Files:**
- Modify: `.claude-plugin/plugin.json` (`askAt` field)
- Modify: `hooks/lessons-learned.mjs` (`register` cfg, `turn.complete` hook, `detect`, `runConfirm`, `confirmItem`, `dismiss`, new `refreshStatus`)
- Modify: `hooks/lib/confirm.mjs` (`onDismiss` returns the item only)
- Modify: `tests/world.ts` (records `$.ui.status`)
- Test: `tests/capture.test.ts`, `tests/confirm.test.ts`

**Interfaces:**
- Produces: `cfg.askAt: "session start" | "never" | "turn end"`; `export const QUEUE_CAP = 10`; `export const statusText = (n: number) => string | undefined` (in `confirm.mjs`, pure); `async function refreshStatus($)` in the hooks module; `onDismiss(item) → item` (dismissed + 1); `world()` returns `statuses: (string | undefined)[]`.

- [ ] **Step 1: Test harness.** `tests/world.ts`: `on("ui.status", (_$, e) => ({ value: void seen.statuses.push(e.text) }))`, `statuses` in `seen`, `ui.status` on the stand-in `seen.$`.
- [ ] **Step 2: Write failing tests** (`tests/capture.test.ts`):
  - `default: no dialog at turn end` — a correction turn with default options: `seen.asks` empty, queue length 1, last status `lessons: 1 to review`.
  - `never: no dialog at turn end` (`askAt: "never"`), same expectations.
  - `the queue keeps the newest 10` — store starts with 10 queued items (keys q1..q10), one correction turn → queue length 10, `q1` gone, newest last.
  - `status counts only items this session can take` — store with one project item for `C:\\other` and one global item → after a turn, last status `lessons: 2 to review` (the new + the global), not 3.
  - `turn end mode skips items dismissed twice` (`askAt: "turn end"`, store item `dismissed: 2`, no detection) → no ask.
  - `statusText`: `statusText(0)` → `undefined`, `statusText(3)` → `"lessons: 3 to review"` (`tests/confirm.test.ts`).
  - Every existing test that expects a dialog at a turn end gets `{ options: { askAt: "turn end" } }`; the dismiss tests now expect the item to stay in `queue` with `dismissed: 2` and no `review` key.
- [ ] **Step 3: Run** `claude plugin test` → new tests FAIL.
- [ ] **Step 4: Implement.** `plugin.json`: `askAt` string field, title `When to ask`, description "When to ask about detected corrections: at session start, never (status line and /lessons review only), or at every turn end.", options as above, default `session start`. `register`: `askAt` from options, anything else → `session start`. `turn.complete` schedules `confirmLater` only when `cfg.askAt === "turn end"`. `detect` appends then keeps the last `QUEUE_CAP`, then `refreshStatus`. `runConfirm` skips items with `dismissed >= 2`. `dismiss` writes `onDismiss(item)` back into `queue`, never `review`. `refreshStatus` counts `offerable` queue items for `context($).repoRoot` and calls `$.ui.status(statusText(n))`; called after `detect` queues, after `confirmItem` changes the list, and from Task 3's session-start step. Failures go to `debug` only.
- [ ] **Step 5: Run** `claude plugin test` → all PASS; `claude plugin validate .` passes.
- [ ] **Step 6: Review and refactor**, re-run tests.
- [ ] **Step 7: Commit** `feat(lessons-learned): no dialogs at turn end by default; queue cap and status line`.

### Task 3: Session-start question, review migration, /lessons review

**Files:**
- Modify: `hooks/lessons-learned.mjs` (`session.start` deferred step, new `migrateReview`, `offerReview`, shared `walkItems`, `reviewText`, `listText`)
- Modify: `hooks/lib/confirm.mjs` (`reviewQuestion(n)`, `REVIEW_NOW`/`LATER`/`DISCARD_ALL`)
- Test: new `tests/review.test.ts`; update `tests/commands.test.ts` (review now walks `queue`)

**Interfaces:**
- Consumes: `refreshStatus`, `QUEUE_CAP`, `cfg.askAt` (Task 2).
- Produces: `export const KEY_OFFERED = "offeredSession"`; `reviewQuestion(n: number) → { question, options, header }` in `confirm.mjs`; `async function walkItems($, ctx, items) → number` (answered count; stops at the first dismissal); `migrateReview($)`, `offerReview($)` in the hooks module.

- [ ] **Step 1: Write failing tests** (`tests/review.test.ts`, session started with `$.session.start(...)` then `await seen.clock.advance(0)`):
  - `asks once at session start when items wait` — 2 global items queued → one ask equal to `reviewQuestion(2)`; `offeredSession` = `"s1"`.
  - `nothing waiting: no question`.
  - `Review now walks the items` — answers `Review now`, `Save`, `Skip` → first saved to `lessons-learned.md`, queue empty, last status `undefined`.
  - `a dismissal stops the walk` — answers `Review now`, then a rejection → exactly 2 asks (no dialog for the second item); both items still queued, the first with `dismissed: 1`, the second with `dismissed: 0`.
  - `Later keeps them` / `a dismissed question keeps them` — queue unchanged, `offeredSession` set.
  - `Discard all leaves another repo's items` — one global + one `C:\\other` project item → only the other-repo item remains; no file written.
  - `reload in the same session does not ask again` — store `offeredSession: "s1"` → no ask; with `sessionId: "s2"` → asks.
  - `askAt never / turn end: no session-start question`.
  - `no surfaces: no question, nothing recorded` (`surfaces: []`) → no ask, no `offeredSession`.
  - `setup question first, review question after it` — repo not set up, 1 global item queued, answers `Not here`, `Later` → asks in that order.
  - `0.1.x review items move into the queue` — store `review: [itemA]`, `queue: [itemB]` → `queue` = `[itemB, itemA]`, no `review` key, question says 2.
  - `/lessons review walks the queue` and `/lessons counts waiting items` (`commands.test.ts`: `1 to review` from `queue`).
- [ ] **Step 2: Run** `claude plugin test` → new tests FAIL.
- [ ] **Step 3: Implement.** `session.start`'s deferred step becomes one function: project setup (as now), then `migrateReview` (append `review` items to `queue`, keep the last `QUEUE_CAP`, delete `review`), `refreshStatus`, then `offerReview` when `askAt = session start`. `offerReview`: return when no surfaces, when `offeredSession` equals `$.session.id()`, or when no offerable items; else store `offeredSession`, ask `reviewQuestion(n)` inside `withAsk` (busy → do nothing), then `Review now` → `walkItems`; `Discard all` → remove those items' keys from `queue`; anything else → keep. `walkItems` is the loop now in `reviewText`, over `queue`; `reviewText` and `offerReview` share it. `listText` counts offerable `queue` items as `N to review`. `refreshStatus` after every branch.
- [ ] **Step 4: Run** `claude plugin test` → all PASS; `claude plugin validate .` passes.
- [ ] **Step 5: Review and refactor**, re-run tests.
- [ ] **Step 6: Commit** `feat(lessons-learned): one review question at session start`.

### Task 4: Docs, version, verification

**Files:**
- Modify: `.claude-plugin/plugin.json` (version `0.2.0`), `README.md` (how it asks, `askAt` row, `/lessons review`), `docs/design.md` (status line already says 0.2.0; fix anything the build changed)

- [ ] **Step 1:** README: replace the turn-end dialog description with the session-start flow and status line; add `askAt` to the options table (choices, default); `/lessons review` row says "waiting items".
- [ ] **Step 2:** Version `0.2.0`.
- [ ] **Step 3: Verify** `claude plugin test` (all pass), `claude plugin validate .` (passes).
- [ ] **Step 4: Eval** — run the detector eval on the shipped `eval/cases.json` with `haiku` (as in design §11.4: a throwaway harness or `/lessons eval` under `--plugin-dir`); expected `False positives: 0/21` and corrections still detected; record the result in design §11 as item 5. Tune `DETECTOR_SYSTEM` wording (not meaning) if a look-alike is flagged.
- [ ] **Step 5: Commit** `docs(lessons-learned): 0.2.0 README, version, eval result`.
