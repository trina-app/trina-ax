# The "save where more people can see" card in plain words

- Date (UTC): 2026-11-21 18:45
- Branch: `fix/widening-card-wording`
- Status: in progress
- Where: server/src/chat (card words), shared/src/api/ws.ts + web/src/components/chat/AskCard.tsx (a tooltip on the place). Why: the card's words are the server's (docs/REPOSITORY-RULES.md)
- Version impact: patch (the same card, when it shows and what its buttons do unchanged; only its words)

## Goal

The owner (2026-11-22, a project chat with 2 people) saw "Please check / Save to Projects › 테스트 프로젝트 ›
트리숲_소개자료 › … › svg_output › 06_contact.svg (2 people)? 1 of them can't see where it came from. It came from a
place someone else opened in this chat." and asked what it is asking. The card should ask one plain question and give
one plain reason.

## Scope

In: the wider-audience card (`askWidening`, kind `save_wider`):
- question first, with the place as a short name ("06_contact.svg in 테스트 프로젝트": the file and its project, group,
  "My files", someone's folder or the top folder), the full place on hover (a new optional `placeTip` on the
  `ask_user` request, shown by AskCard as a `title`);
- one reason line: "Trina made it from <source>, which 1 of them can't open." A source the person answering cannot see
  is never named: "a place only some of them can open" (all hidden: "Trina made it from a place 1 of them can't open.");
- a shorter Always allow note for this card only (`cardAlwaysNoteSaveWider`);
- six languages, tests that assert the old words.

Out: when the card shows, its facts, its buttons and Always allow kinds (docs/decisions/20261117-save-card-plain.md,
20261116-folder-share-widening.md); the skill card's `skillWiden` line; the room card's own lines.

## Steps

1. New i18n keys in server/src/chat/i18n.ts; `askWidening` builds the new question; `widenSources` also returns the
   plain labels.
2. `placeTip` in shared/src/api/ws.ts and AskCard.
3. Update tests (b-ai-save-place, b-skill-save-one-card, b-chat-rooms, plural-counts, b-shared-chat-trash), changes/
   note, decision file.
4. typecheck, check:prepush, unit + related e2e; before/after screenshots 1440/390 ko/en from a local mock.

## Decisions

docs/decisions/20261122-widening-card-wording.md (supersedes only the card words of 20261117-save-card-plain.md).

## Risks

Leaking a hidden source's name: the hidden check (`seesSource`) is unchanged and still decides each label. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (the files above), web unit tests, the AskCard e2e.

## Result

