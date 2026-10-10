# Mods

A Claude Code plugin marketplace (`sunkanxx-mods`) with small, standalone mods. Each mod lives in its own folder, has its own README, and can be installed on its own.

Add the marketplace:

```
claude plugin marketplace add Sunkanxx/Mods
```

| Mod | What it does | Install |
|---|---|---|
| [lessons-learned](lessons-learned/README.md) | Learns from your corrections, recalls them when relevant, and turns repeated ones into rules. | `claude plugin install lessons-learned@sunkanxx-mods` |
| [last-call](last-call/README.md) | Stops work at a clean point before the usage limit, keeps the cache warm while waiting, and continues after the reset. | `claude plugin install last-call@sunkanxx-mods` |

## Licence

MIT. See the licence file in each mod's folder.
