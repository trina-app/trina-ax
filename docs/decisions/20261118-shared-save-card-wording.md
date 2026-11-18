# A save in a shared chat asks with save words; a new file asks nothing

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/shared-save-card-wording (QA TC-4968)

- **Ask:** in a chat shared with people, "save this attachment into my folder" (`save_connector_file`, PR #1296) showed
  the read card: "The AI wants to read your personal folder. 1 of the 2 people who see this chat can't open it. If it
  reads it, what it finds stays in this chat… Don't read / Always allow / Read and share". The call reads nothing. The
  card misled the asker.
- **Cause:** the read gate (`TurnExec.sharedSources`) counts every path a call names as a read, except the write
  arguments in `WRITE_TARGET_ARGS`, which count only when something is there already. `save_connector_file` was not
  in that list, so its `save_as` always counted as a read, also for a new file. A save into a folder that is there
  (`save_as: "users/<me>/"`) or onto a file of the same name counted the folder as a read for every save tool, and
  the card said "read".
- **What a save there shows the others:** not the folder's contents or its other names. But the chat shows the name
  the file is saved under, and the save keeps both files when one of that name is there already (a copy named after
  the person and the time, `placeProduced`). So the others can learn that a file of that name was in the private
  folder. A new file shows them nothing they did not already have in the chat.
- **Rule (the safer of the two options):**
  - A save of a new file asks nothing, whatever the folder (`save_connector_file: ['save_as']` added).
  - A save into a place that is there already, which some people who see the chat cannot open, keeps a card, with
    save words: "The AI wants to save a file in your personal folder. 1 of the 2 people who see this chat can't open
    it, so they won't be able to open the file either. Everyone who sees the chat will see the name it's saved under,
    which can show whether a file with that name was already there." Buttons: Save / Always allow / Don't save.
  - The save card shows only when every place the card would name is one the call only saves into. A call that also
    reads from there (unzip a file of the person's, a private template for `make_file`) keeps the read card.
  - The save card has its own "Always allow" kind (`shared_save`, "Saving in shared chats" in Settings) and its own
    yes and no for the turn. A yes to save in a place never lets a read of it through. A yes to read a place covers a
    save there (a read shows more).
  - A no, no answer, a scheduled run or a check that fails saves nothing. The AI is told "Not saved (tool): nothing was
    saved there", by whom, and to suggest saving from a chat of the person's own. The step says "Not saved: not
    everyone who sees this chat can open that place". No place and no person is named.
  - The audit row stays `chat.shared_read`, with `save: true` (the widening list and migration 296 read that action).
- **Which tools:** every tool with an entry in `WRITE_TARGET_ARGS` gets the save card, except `edit` (its result shows
  lines of the file) and `move_files`, `copy_files`, `rename_file` (they take files the person has into that place),
  which keep the read card (`WRITE_TARGET_NOT_SAVES`). That covers `save_url`, `save_connector_file`, `make_file`,
  `unzip_file`, `write` and the PDF, Hangul and image tools, and `save_chat_file` (#1286) and `make_zip` (#1302),
  which add their own entries. A test checks that every save-type tool offered in shared chats has an entry.
- **Why not skip the card for the person's own folder:** it would be quieter, but the saved name can still tell the
  others that a file of that name was in a folder only the asker can open. The card is only for a place that is there
  already, it says what is shown, and "Always allow" turns it off for the person.
- **Tests:** `tests/unit/b-shared-save-card.test.ts` (a chat shared with people and a shared project chat).
- **Version impact:** patch. A card's words and when it shows; one new "Always allow" kind; no API or migration.
