# Words after a shared folder is listed or read name the shared file

- Date (UTC): 2026-11-17 05:46
- Branch: `fix/ai-wording-listed`
- Status: done
- Where: Trina-ax `server/src/chat/grant-reads.ts`. Why: the words of cards and refusals after other people's words are
  chat code in the core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, one reason: words on a card and in refusals change, no behaviour or gate changes

## Goal

QA TC-4482. After the AI only lists a folder someone shared with the person (or reads a file in it), the next card or
refusal said "messages from the user's team chat rooms". Nothing from a room came in. The words should say a file
someone shared with the person was read, as PR #1175 does for a file shared one by one.

## Scope

In: `readByGrant` (chat/grant-reads.ts) judges a place inside a folder someone shares without that share, so the words
(`grantOnly`, `seenWhy`, `othersSource`) see it as a grant read in later answers.
Out: every gate. A listing or read in a shared folder already marks the chat (rooms_seen, others_words); that stays.

## Steps

1. Failing tests in tests/unit/c-shared-folder-ai.test.ts: list only, then delete and an unanswered change; a read
   inside the folder; a room read alone and room plus listing keep the room words; the owner's own chat is no grant.
2. Fix `readByGrant`: a `user` source with a `share` is judged as the plain `user` place.
3. Changelog fragment.

## Decisions

none (applies the rule of #1175 to folder shares).

## Risks

Words only. `readByGrant` is read only by the word pickers (grantOnly, seenWhy, othersSource) and post_to_room's
place names. No migration.

## Tests

`bun run typecheck`, tests/unit/c-shared-folder-ai.test.ts, b-shared-with-me-tool, c-reader-counters, also under
Bun 1.3.12, `bun run check:prepush`.

## Result

The cause: the read scope keeps a place inside a shared folder as `{type:'user', id:<owner>, share:<id>}`, and
`viewersOf` counts that share's people as readers, so the receiver looked like someone who could open it anyway and
`readByGrant` said no once the turn's pending grant reads were cleared. Reads inside a shared folder had the same
problem, not only listings.
