# Claude Code sends the thinking summary (AP-033 follow-up)

- Date (UTC): 2026-11-20 06:23
- Branch: `ap033-thinking-display`
- Status: in progress
- Where: server (Claude engine launch). Why: the engine never asks the model for readable thinking text.
- Version impact: patch. A fix to AP-033 (#101): the Thinking step showed no text with Claude Opus 5.5.

## Goal

After #101 the server keeps the thinking text on the Thinking step. On qa.trina.app the step still had no text. Cause:
Claude Opus 5.5 (Claude Code's `opus`) returns thinking with `display: "omitted"` by default, so every
`thinking_delta` is empty. Claude Code 2.1.305 in `-p --output-format stream-json` mode sends no `display`, and its
`showThinkingSummaries` setting applies only in interactive mode. Only the hidden flag `--thinking-display summarized`
asks for the readable summary.

## Scope

In: `buildClaudeLaunch` adds `--thinking-display summarized` when the engine knows the flag. The server finds that out
once per engine binary, in the background, like `--effort` (an unknown flag fails the turn).
Out: effort, budget, a per-message toggle (owner decision, unchanged). Codex (its reasoning text already comes).

## Steps

1. `claudeKnowsThinkingDisplay(bin)`: runs `bin -p --thinking-display x` (fails at argument parsing, before any
   network call); the flag is known when the error lists "summarized" as an allowed choice.
2. Share the cache of `claudeKnowsEffort` (one helper for both probes).
3. Unit tests: the probe (known, unknown option, failure), the launch arguments.
4. Decision file update: a new file that extends 20261120-ap033-thinking-text.md.

## Decisions

`docs/decisions/20261120-ap033-thinking-display.md`.

## Risks

- Cost: none. The display changes only what is shown; the model thinks and bills the same.
- The first turn after a server start has no flag yet (background probe), as with `--effort`.

## Tests

`bun run typecheck`, `bun run check:docs`, the engine unit tests.

## Result

Filled in at the end.
