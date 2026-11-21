# A save in a shared chat asks with save words, not read words

- Date (UTC): 2026-11-18 16:34
- Branch: `fix/shared-save-card-wording`
- Status: done
- Where: Trina-ax `server/src/chat/turn.ts`, `server/src/rooms/ai-tools.ts`, `server/src/chat/i18n.ts`. Why: the
  shared-chat read card lives in the core chat runtime (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a card's wording and when it shows; no API change

## Goal

QA TC-4968: in a chat shared with people, "save this into my personal folder" (`save_connector_file`, PR #1296) shows
the read card: "The AI wants to read your personal folder … Don't read / Always allow / Read and share". The call saves;
it reads nothing. The card misleads the asker.

## Cause

`TurnExec.sharedSources` counts every path a call names as a read, except the write arguments in `WRITE_TARGET_ARGS`,
which count only when something is there already.

1. `save_connector_file` is missing from `WRITE_TARGET_ARGS`, so its `save_as` always counts as a read, also for a new
   file.
2. A save into a folder that is there (`save_as: "users/<me>/"`, or an existing file) counts the folder as a read, and
   the card uses read words.

## Steps

1. Add `save_connector_file: ['save_as']` to `WRITE_TARGET_ARGS`. A new file in any folder raises no card, as for
   `save_url` and `make_file`.
2. `sharedSources` also says which places only a write argument named. When every place the card would name is one of
   those, the card is a save card: "The AI wants to save a file in {place}. … Save / Always allow / Don't save". It has
   its own "Always allow" kind `shared_save` and its own per-turn yes/no keys, so a yes to a save never lets a read of
   that place through.
3. A call that also reads a place (unzip a private zip, a private template) keeps the read card.
4. The refusal for the AI and the skipped step say "Not saved", and name no place.
5. A guard test: every save-type tool offered in shared chats (`save_url`, `save_connector_file`, `make_file`,
   `unzip_file`, and `save_chat_file` / `make_zip` once their PRs land) lists its target in `WRITE_TARGET_ARGS`.

## Decisions

`docs/decisions/20261118-shared-save-card-wording.md`: keep a card for a save into a place that is already there, with
save words (the safer option), because the chat shows the name the file gets there, which can show that a file with
that name was already in the private folder. A save of a new file asks nothing.

## Risks

The read card's keys and "Always allow" must not widen: a yes on a save covers only saves. No migration. Six server
languages and six web languages for the new "Always allow" label.

## Tests

`bun run typecheck`, `bun run check:prepush`, a new `tests/unit/b-shared-save-card.test.ts` (card kind and words, a
new file with no card, nothing about the private folder reaching the other person), the shared-chat suites under Bun
1.3.12.

## Result

Built as planned. `WRITE_TARGET_NOT_SAVES` keeps the read card for `edit`, `move_files`, `copy_files` and
`rename_file` (an edit shows lines of the file; the others take the person's files there). The audit row stays
`chat.shared_read` with `save: true`. Shared-chat suites pass under Bun 1.3.12; screenshots at 1440/390 light/dark on a
copy of the QA team.
