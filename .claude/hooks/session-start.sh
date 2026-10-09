#!/bin/bash
# Cloud-session setup. The mod has no package dependencies: tests run with
# `claude plugin test` and checks with `claude plugin validate`, both built
# into the Claude Code CLI. This hook confirms the CLI is there and that the
# plugin and marketplace manifests load, so problems show at session start.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

if ! command -v claude >/dev/null 2>&1; then
  echo "session-start: claude CLI not found; 'claude plugin test' and 'claude plugin validate' won't work" >&2
  exit 0
fi

claude plugin validate . >/dev/null || echo "session-start: marketplace validation failed (run 'claude plugin validate .')" >&2
claude plugin validate lessons-learned >/dev/null || echo "session-start: plugin validation failed (run 'claude plugin validate lessons-learned')" >&2
