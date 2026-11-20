# Claude Code asks for the readable thinking summary (--thinking-display summarized)

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (extends [20261120-ap033-thinking-text.md](20261120-ap033-thinking-text.md))
- Branch: ap033-thinking-display (AP-033 after #101: on qa.trina.app the Thinking step of a Claude answer still had no
  text)

Plan: [docs/AGENTS/plan/20261120-0623-ap033-thinking-display.md](../AGENTS/plan/20261120-0623-ap033-thinking-display.md).

- **Cause:** Claude Opus 5.5 (Claude Code's `opus`, the default) and the other current models return thinking with
  `display: "omitted"` by default: every `thinking_delta` has empty text. Claude Code 2.1.305 in `-p --output-format
  stream-json` mode sends no `display` of its own, and its `showThinkingSummaries` setting is read only in interactive
  mode (read from the 2.1.305 code). So #101 kept an empty text and the step stayed a plain row.
- **Rule:** `buildClaudeLaunch` adds `--thinking-display summarized` (a Claude Code flag that `--help` does not list) when
  the engine binary knows it. The server finds that out once per binary, in the background, like `--effort`
  (`claudeKnowsThinkingDisplay`): `bin -p --thinking-display x` is refused at argument parsing, before any network
  call, and a Claude Code with the flag lists its choices ("Allowed choices are summarized, omitted, highlights"). An
  older one says "unknown option" and gets no flag (an unknown flag would fail the turn). Until the answer comes (the
  first Claude turn after a server start) the flag is not sent.
- **Cost:** none. `display` changes only what the API returns; the model thinks and is billed the same. No effort or
  budget change, no per-message toggle (still a separate owner decision).
- **Who sees it:** unchanged from 20261120-ap033-thinking-text.md (redacted; in a shared chat only the runner).
- **Left out:** `highlights` (not in the API's documented values for every model); Codex (its reasoning text already
  comes).
- **Tests:** `tests/unit/b-onboarding-file-rank.test.ts` "--thinking-display summarized only for an engine that knows
  it". Checked by hand with the real Claude Code 2.1.305 binary: the probe says yes; a missing binary says no and is
  asked again.
- **Version impact:** patch (a fix to AP-033).
