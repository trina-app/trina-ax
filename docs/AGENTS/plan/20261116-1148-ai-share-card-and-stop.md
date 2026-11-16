# One card for a share, and stop sharing through the AI

- Date (UTC): 2026-11-16 11:48
- Branch: `feat/ai-share-card-and-stop`
- Status: done
- Where: Team AX core (`server/src/chat`, `server/src/files`, `shared/src/api`, `web/src/components/chat`). Why: chat,
  permissions and files belong to the core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new AI tool, a new step field and one additive migration.

## Goal

Hands-on tests of 2026-11-16 (QA tab "Manual AI tests", MAN-011, MAN-012, MAN-017) failed on sharing: the AI could not
stop a share ("I can't take that access away"), and what it did share came back as long prose with links and folder
paths. The owner's rule: "You decide who sees what you made, and you can change your mind any time."

After this change:

- "Stop sharing Quote.pdf with Jun" works in a chat. It only narrows access, so it runs at once when the person's own
  message named the file and the person, and its card has **Undo**.
- A file's owner can always stop their own share, also while the team's member-sharing switch is off or after they lost
  edit access (the Share dialog's ✕ and the AI). Adding people stays gated as today.
- One card: the confirmation card turns into the result where it is. The result is made from a server record
  (`Step.shared`), never from the AI's words: a past-tense headline, the file and its place in words, the people with
  "Can view", one button (**Manage access** after a share, **Undo** after a stop). A refusal or a partial result is the
  same card, with a slot for a next-step button.
- The AI answers in one short sentence and does not repeat links, names or places.

## Scope

In:

1. `stop_sharing` tool (a new file `server/src/chat/stop-sharing.ts`), off wherever `share_with_person` is off, and in
   scheduled runs. Audited with via `ai`.
2. `FileShares.change`: a removal-only call by the file's owner passes with the switch off or without edit access.
   `FileShares.view` says `canStop`; the dialog shows ✕ for it.
3. `Step.shared` (shared/src/api/share-card.ts): link ids, names, place words, owner (when not the asker), who, level,
   added or removed, who was told, who can still open it after a stop and through what, a refusal's reason, `next`.
4. `ask_user` request field `share` (server cards only): the confirm card's file rows and people.
5. Web: `ActionCard` frame, `ShareCard` (confirm, result, refusal), the post_to_room result in the same frame with its
   View link. The card reads the live state as the viewer (`POST /api/files/shares/cards`) for its button.
6. Per viewer: in a chat other people see, only the asker gets `Step.shared` (ChatStore.viewSteps).
7. A person whose access was stopped sees "<name> stopped sharing this file" on the link page (migration
   `358_c_file_share_stops.sql`).
8. Prompt and tool results: one short sentence once the card exists.

Out: folder sharing, edit rights, the "who can open this" tool and the next-step buttons' actions (another builder
fills the slot), `shared_with_me` and `looking_at`.

## Steps

1. Service: owner stop, `canStop`, stop records, residual access.
2. Shared types, the migration, the endpoint for a card's live state.
3. Tools: record on `share_with_person`, new `stop_sharing`.
4. Web: frame, cards, dialog ✕, link page line, languages.
5. Tests: unit (server, web), Playwright, hands-on with the dummy or real AI, screenshots.

## Decisions

`docs/decisions/20261116-ai-share-card-and-stop.md`: an owner can always stop their own share; stopping through the AI
needs no card when the person named the file and the person; the result card comes from the server record.

## Risks

- Migration number 358 (component C range): other branches of this plan may pick the same number.
- `shared/src/tools.ts`, `server/src/chat/prompt.ts`, `server/src/chat/i18n.ts`, `server/src/chat/tools.ts` are edited
  by other branches of the plan too: additions only, in one place each.
- Six languages for every new line.
- A step record holds names: it must never reach another viewer of a shared chat, a room post, an export or search.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests of files/chat, web unit tests of the cards,
a Playwright spec, hands-on reruns of MAN-011, MAN-012 and MAN-017.

## Result

Built as planned, on `feat/ai-share-card-and-stop` (no pull request yet: the branch holds two open batches).

- `stop_sharing` (server/src/chat/stop-sharing.ts), the owner's stop in `FileShares.change`, `canStop`, `stillOpens`,
  `cards`, migration 358 and the link page's "<name> stopped sharing this file".
- `Step.shared` and `AskUserRequest.share` (shared/src/api/share-card.ts); `share_with_person` writes the record and
  returns no links.
- Web: `ActionCard`, `ShareCard` (confirm rows, result, refusal, `registerShareNext`), `PostedCard`, the dialog's ✕
  for the owner.

Differences from the plan:

- A stop sends no Activity notice. The person taken off reads who stopped it on the file's link page.
- A refusal's button is a slot (`registerShareNext`); the buttons' actions come with another branch.
- The step row of a post keeps its own View as well as the card's.
- Several files: the card lists the files only after **Manage access** is pressed (each row opens its own dialog).

Checked with the real AI on a private copy of the QA team (MAN-011, MAN-012, MAN-017) and with the scripted AI.
