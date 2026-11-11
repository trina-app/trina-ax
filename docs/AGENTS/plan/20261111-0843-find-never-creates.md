# Asked to find a file, the AI searches and never makes a new one

- Date (UTC): 2026-11-11 01:43
- Branch: `fix/find-never-creates`
- Status: in progress
- Where: trina-ax core (`server/src/chat/prompt.ts`, its unit tests). Why: the in-app AI's instructions are core (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch, a few sentences more in the AI's instructions; no API, data or screen change

## Goal

In a find-files test on 2026-11-11 (a 2,204-file made-up team folder, Claude Code, one new chat per question), the AI
sometimes answered a request for an existing file with a new one: with the knowledge graph off, 7 of 159 answers wrote a
file instead (a new expense report template in `shared/Templates` while `shared/경영지원/양식/old/지출결의서_양식.xls`
exists, a new contract, a new storyboard, new icon drafts). Others asked the person where the file is before searching
well (a whiteboard photo, an approval request, a bank-book photo), and one searched the web for a team file and copied a
logo into a new shared folder.

After this change, when someone asks for an existing file (to find, open, send or show it, or by just naming it), the AI
searches names, other words and contents and opens likely files first; it never makes a new file in its place unless
asked; when nothing matches it says so and lists the closest files; only then does it ask where the file is. It does not
search the web for a team file.

## Scope

In:
- One short rule in the instructions' tool rules (`turnPromptSections` base lines), under about 120 tokens, as its own
  constant and its own line, away from the knowledge graph lines that another branch removes.
- It reaches every chat that gets these instructions: Claude Code and Codex (and the API engine), team chat rooms,
  shared project chats and confidential chats (they keep the `rules` section).
- Unit tests: the rule is in the instructions for Claude and Codex, and in a room, a shared chat and a confidential chat.
- A changelog note in `changes/find-never-creates.md`.

Out: the knowledge graph (removed in its own branch); sub-agents (they cannot ask the person and save only what their
task says; the main AI decides); new tools or a search by file name on the server.

## Steps

1. Measure before: a local server from origin/dev with the knowledge graph off, the benchmark runner
   (`scripts/bench/find-hard/run-hard.ts`, branch `test/kg-find-hard`) on the 2,238-file folder: the ten ids that failed
   (cr04, cr06, cr07, cr12, ow07, ow16, nf02, nx08, ms04, mp02) three times each, and 15 other ids once.
2. The rule in `server/src/chat/prompt.ts`; count its tokens.
3. Unit tests next to the existing instruction tests.
4. Measure after: the same runs on a server from this branch, knowledge graph off. Delete files the AI wrote after
   every question.
5. Checks, changelog note, plan result.

## Risks

No migration, no permission change. The rule must not stop the AI from making a new file when the person asks for one
("write a contract like the last one"), and must not make every answer slower: it searches only when a file is asked
for. Tokens: the instructions grow by under about 120 tokens per new session.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the chat and prompt unit tests in `tests/unit`, and the
before/after runs with the real AI above. No web change, so no web tests.

## Result

Filled in at the end.
