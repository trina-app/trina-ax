# Run code where Claude Code would: skill scripts, sub-agents, old teams' dev environment

- Date (UTC): 2026-11-18 10:43
- Branch: `fix/limits-run-code`
- Status: done
- Where: Team AX core (server/src/chat, server/src/devenv, web admin). Why: chat, skills and the Linux run base are core (docs/REPOSITORY-RULES.md)
- Version impact: minor, new behaviour for the AI and a new one-time notice for admins

## Goal

QA TC-4911 (limits audit #11, #18, #16). Claude Code runs a skill's scripts and its sub-agents have a shell. Here:

1. The prompt said "This runtime cannot execute bundled scripts" even when the person has the dev environment
   (`box_shell`).
2. Sub-agents never got `box_shell` (PARENT_ONLY_TOOLS) and stopped after 50 rounds.
3. Teams that had people before migration 236 (2026-11-06) got an explicit "off" row. Their admins were never told the
   dev environment exists.

## Scope

In:
- With `box_shell` in the turn, the skills section and the skill block say how to run a skill's bundled scripts with
  `box_shell` (same fence, folders and network as any command). Without it, the old line stays. Which skills are listed
  does not change (known origins only, as today).
- Sub-agents (general-purpose, not Explore) get `box_shell` when the main AI has it, through the same tool and the same
  view (shared chat fence included). A sub-agent cannot answer a card: request_sites and a login command after others'
  changes are refused with "put it in your report"; jobs and dev servers stay with the main AI (their notice, Preview
  button and results are the main AI's). Its waiting state is not patched onto a step (the FIFO of patchToolStep stays
  the main AI's).
- Sub-agent round cap = the main answer's cap (Admin › Team settings answerStepLimit, read at the turn's start), not 50.
- Old teams: the server says `offer: true` (GET /api/admin/dev-env) while the setting row is still the one migration 236
  wrote. Admin › Home and the Dev environment card show a one-time plain notice with the switch (Team settings). Closed
  or followed: never again for that admin (prefs). Nothing turns on by itself.

Out: srt socket paths in shared chats (PR #1277). Real-AI check on Linux (srt is Linux only).

## Steps

1. prompt.ts: skill script lines by `box_shell`.
2. subagents.ts / turn.ts / devenv/tool.ts / chat/tools.ts: sub-agent box_shell and round cap.
3. devenv/setting.ts `oldTeamOffer`, route field, shared schema, prefs key, web notice, i18n (en first, all locales).
4. Unit tests, decision file, changes note.

## Decisions

docs/decisions/20261118-run-code-skills-subagents.md

## Risks

Sub-agent runs share the turn's site sets and first-call notes; they cannot raise cards. No migration.

## Tests

Unit: prompt lines, agent definitions, box_shell refusals for a sub-agent, offer detection. `bun run check:prepush`.

## Result

Built as planned. Tests: tests/unit/dev-env-subagent.test.ts (new), subagents.test.ts, b-answer-step-limit.test.ts,
web/test/unit/dev-env-offer.test.tsx. No real-AI run on Linux (srt is Linux only; this Mac cannot run it).
