# Asked to find a file, the AI searches and never makes a new one

- Date (UTC): 2026-11-11 01:43
- Branch: `fix/find-never-creates`
- Status: done
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

Built as planned: `FIND_FILE_RULE` in `server/src/chat/prompt.ts`, one line after "To create a new file, call write
directly" in the tool rules, so every chat with those rules gets it (Claude Code, Codex, the API engine, rooms, shared
and confidential chats). It is 123 tokens on Claude's tokenizer (a one-message call with and without it). Tests:
`tests/unit/b-prompt-find-file.test.ts` (its words, every kind of chat, once and after the create line) and a Claude and
Codex case in `tests/unit/b-chat.test.ts` "instructions". Not in the sub-agents' instructions (they cannot ask the
person and save only what their task says), and a Claude session started before the update keeps its first
instructions until a new session starts, like every other line of the tool rules.

The wording changed twice during the runs. The first said "in its place": the AI found the draft and still wrote
another next to it, and for a bare name ("트리나 일본어 소개서") it made a deck. The final one says a file asked for,
even by name only, is the existing one, and applies other words, both languages and folder names to names and
contents.

Measured with the real AI (Claude Code, knowledge graph off in Admin on both servers, the 2,238-file test folder, one
new chat per question, files the AI wrote deleted after every question), before = origin/dev c11f0c89d, after = this
branch. The ten ids that failed, three times each (mp02 six times): right 15/33 before, 27/33 after; a new file,
draft, deck or copy made 16 times before, 2 after (both cr12: it named the existing English draft first, then wrote a
Korean one in the person's own folder); asked back without the file 7 before, 5 after; web search 2 before, 0 after.
Median time 56 s before, 39 s after; median input tokens 270k before, 192k after. Fifteen other ids once each: 15/15
right on both, no file made. Left: cr06 still asked back in 2 of 3 (its glob matched file names only, so the folder
외주 was not seen, and it searched contents in Korean only for an English PDF); mp02 (a bank-book photo named
IMG_2031.jpg) was found 3 of 6 times after against 5 of 6 before: after about 25 opened images the AI listed what it
had seen and asked whether to open the remaining 80 photos, where before it kept opening them (once 81 calls and 1.5M
tokens, then not found).
