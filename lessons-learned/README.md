# lessons-learned

A Claude Code mod that makes your corrections stick. It notices when you correct Claude, asks you to confirm the point, and saves it as a **lesson**. When a later prompt touches the same topic, the lesson is attached to it. If you make the same correction again, the lesson is promoted to a **rule** that is loaded in every session.

## How it works

1. **Detect.** After each prompt, a short background model call decides whether your message corrects Claude in a way that should carry over to later work (a preference, a convention, a fact about your tools, a skipped process step). One-off steering such as "use the other file", answers to Claude's questions and changes of requirements do not count. This adds no wait to your prompt.
2. **Confirm.** At the end of the turn a dialog shows the exact text. Nothing is saved without your choice, and you can edit the text in the dialog's "Other" field.
3. **Recall.** A saved lesson is attached to later prompts whose words (or recently touched file paths) match its tags. At most 3 per prompt, and each lesson at most once per session.
4. **Promote.** If the same correction comes up again, the dialog offers to promote the lesson to a rule. Rules live in a file that `CLAUDE.md` imports, so they load at the start of every session. If a rule is broken again, you can note it; its `seen` count then shows which rules are not working.

## Install

```
claude plugin marketplace add Sunkanxx/Mods
claude plugin install lessons-learned@sunkanxx-mods
```

Restart Claude Code. On first start the mod creates its global files. In a git repository it asks once whether to set up the project too.

## Files it creates

| Scope | Lessons | Rules | Import block added to |
|---|---|---|---|
| Global | `~/.claude/lessons-learned.md` | `~/.claude/rules-learned.md` | `~/.claude/CLAUDE.md` |
| Project | `<repo>/lessons-learned.md` | `<repo>/rules-learned.md` | `<repo>/CLAUDE.md`, or `<repo>/.claude/CLAUDE.md` if that is the one that exists |

`<repo>` is the git root of the session's working directory. The block is inserted once, found again by its markers, and `CLAUDE.md` is created if none exists:

```md
<!-- lessons-learned:start -->
## Learned rules
@rules-learned.md
Past corrections that aren't rules yet are in `lessons-learned.md`; relevant ones are attached to your prompt automatically.
<!-- lessons-learned:end -->
```

`lessons-learned.md` is deliberately not imported: lessons are recalled by relevance, not always loaded. When `CLAUDE.md` lives in `.claude/`, the import is written as a path relative to that file.

Entries look like this, in both files:

```md
## P-012 · Use PowerShell for `claude -p` slash commands
tags: powershell, slash-command, claude-p · seen: 1 · first: 2026-10-07 · last: 2026-10-07
Git Bash rewrites `/cmd` into a path, so run slash commands in `claude -p` from PowerShell.
```

Ids are `G-NNN` (global) or `P-NNN` (project) and stay the same when an entry is promoted or demoted. The files are plain markdown; you can edit them by hand.

## Project setup

The first session in a git repository asks whether to set it up. The choices:

| Choice | Effect |
|---|---|
| Yes, commit them | Adds the two files and the import block; you commit them like any other file. |
| Yes, keep out of git | Same, but both files are added to `.gitignore`. |
| Not here | Nothing is added. Remembered per repository. |

**In a team repository, think before choosing "commit".** `CLAUDE.md` imports `rules-learned.md`, so every rule you confirm becomes an instruction for your teammates' Claude sessions too. If the rules are personal, choose "keep out of git".

Outside a git repository only the global scope is used. `/lessons setup` asks again, also after "Not here".

## `/lessons`

| Command | Does |
|---|---|
| `/lessons` | Counts per scope and pending reviews, then every rule and lesson (id, title, seen). |
| `/lessons review` | Goes through items you dismissed twice, with the same dialogs as at turn end. |
| `/lessons promote <id>` | Moves a lesson to the rules file of its scope. If the scope is at its rule cap, asks which rule to demote. |
| `/lessons demote <id>` | Moves a rule back to the lessons file. |
| `/lessons delete <id>` | Asks for confirmation, then removes the entry. |
| `/lessons setup` | Runs project setup again. |
| `/lessons pause` | Stops capture for this session. Recall keeps working. |
| `/lessons resume` | Restarts capture. |
| `/lessons eval` | Runs the detector against the bundled test cases (see Contributing). |

If you close a dialog without answering, the item is offered again at the next turn end; dismissed twice, it moves to `/lessons review`. Corrections you have not answered yet are kept between sessions.

## Options

Set in `/config`. Defaults apply until you save a value.

| Option | Default | Meaning |
|---|---|---|
| `model` | `haiku` | Model alias or id for the detector. |
| `ruleCap` | `20` | Most rules kept per scope before you are asked to demote one. |
| `maxRecall` | `3` | Most lessons attached to one prompt. |

## Privacy

For each prompt (except slash commands, and only when a dialog can be shown), the detector sends three things to the configured model: your prompt, the last part of Claude's previous reply (about 6,000 characters), and the titles and tags of the existing lessons and rules. The call goes through your own Claude Code credentials. Nothing is sent anywhere else, and the mod has no server of its own.

Entries are stored as plain files on your machine. Project files are **committed by default** (see Project setup); choose "keep out of git" if that is not what you want. The detector is told to leave out secrets and personal data, and you see and can edit every lesson before it is saved.

Because rules are loaded as instructions, the mod limits what can be written: an `@` followed by text, markdown headings and the block markers are neutralised in every entry, the detector's reply is validated as strict JSON, and recalled lessons are framed as lessons you confirmed.

## Requirements

Claude Code with mod support. Tested with Claude Code 2.1.295 (the output of `claude --version`); other versions have not been tested. Works on Windows, macOS and Linux.

## Limitations

- Prompts typed through Remote Control or channels are not captured, because no dialog can be shown there. In `claude -p` runs the mod only recalls.
- It is not yet known whether two plugins that ask a question at the same turn end get both dialogs, one, or an error; a dialog that does not appear counts as a dismissal and is offered again at the next turn end.
- Recall is keyword based: a lesson is attached when at least 2 of its tags (or one multi-word tag) appear in your prompt or the paths of recently touched files.
- Lessons and rules are context for Claude, not enforcement; nothing blocks a tool call.

## Contributing

Run these in the `lessons-learned/` folder:

```
claude plugin test
claude plugin validate .
```

`/lessons eval` runs about 30 labelled cases (corrections and look-alikes) through the real detector, using your own credentials and costing a few cents. It prints how many corrections were detected and how many look-alikes were wrongly flagged; the target is zero false positives. Run it after changing the detector prompt, and add cases to `eval/cases.json`.

## Licence

MIT. See [LICENSE](LICENSE).
