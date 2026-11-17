# A card the person allowed does not come back for the same action and target in that chat

- Date (UTC): 2026-11-16 21:11
- Branch: `fix/card-approved-once-per-chat`
- Status: done
- Where: server (component B chat gates, component C connection gate). Why: the AI flow check of 2026-11-17 counted
  repeated cards for the same action in one chat (see docs/REPOSITORY-RULES.md)
- Version impact: patch: fewer repeated cards, no new screen or setting (one table, migration 413)

## Goal

The real-AI flow check (tests/ai-scenarios, default mode, nobody picked Always allow) found the same card again and
again: FL-08 9 prompts (4 room-change cards in one answer, two for one stamp call), FL-12 4 prompts (a second "Create
draft" card for the same recipient, then a Send card for the draft just made). Once the person said yes on a card, the
same kind of action to the same target in the same chat should not ask again. Rule A's guard stays as it is.

## Scope

In:
- a per-chat store of the person's own card approvals (`chat_card_approvals`, `chat/card-approvals.ts`), 12 hours, the
  person's own turns in the app only, cleared with the chat's session;
- room-change card (after a room read): the same file (write, edit, make_file, edit_hwp, stamp_pdf's output);
- wider-audience save card: the same folder, same audience, sources it already named;
- connection write card: the same tool and connection, every recipient-like value one the approved call had, no new
  address in the text; a draft the person allowed, sent unchanged by its id;
- post_to_room: the same room or thread, the AI's text, no note, no files choice, no "cannot see" lines;
- stamp_pdf with an output after a room read: the room card and the wider-audience card are one card.

Out: share_with_person (each share is a new file to a person: a widening by itself); Always allow (unchanged); the
explicit-ask skip and Rule A's guard (unchanged).

## Steps

1. Unit tests that reproduce FL-08 (same file again, stamp's two cards) and FL-12 (draft, draft, send).
2. The store and the four gates.
3. Real-AI rerun of FL-08 and FL-12 in both modes.
4. Independent security review; must-fixes.
5. Decision note, changes fragment, QA rows, PR to dev.

## Decisions

docs/decisions/20261117-card-approved-once-per-chat.md

## Risks

A planted instruction in a chat with other people's words can repeat an action to a target the person allowed in that
chat (accepted, see the decision). Migration 413 (B's range). No UI change apart from one step line in six languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`; tests/unit/b-card-approved-once.test.ts,
c-card-approved-once-connector.test.ts and the room, post, connection and stamp tests under Bun 1.3.12.

## Result

PR #1168. Built as planned, plus the independent review's must-fixes (keyed recipient paths, share-like tools never
kept, drafts only from create-style tools and dropped on any write in any chat, instruction files never kept) and shared
chats left out. Real AI, default mode: FL-08 9 → 6 prompts, FL-12 4 → 2 (one run 3: an edited draft made without its
own card still asks before it is sent, by design).
