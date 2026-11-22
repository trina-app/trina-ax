# No card after an explicit ask to save, move or copy to a named place

- Date: 2026-11-22
- Status: accepted
- Supersedes: two rows of [No card right after an explicit ask](20261116-no-card-after-explicit-ask.md) ("Fewer-people-can-see save" and "move/copy that changes who sees")
- Branch: fix/ask-less (QA TC-ask2-2, -6, -8, -12, -13, -15)

- **Ask:** the second ask audit found cards right after the person had said where to put something: "팀원들도 볼 수 있게
  저장해줘" then "옮길까요? 16명이…" (TC-ask2-8), "팀 폴더 마케팅에" then a save card per file (TC-ask2-13), "프로젝트에
  만들어줘" then "저장할까요?" (TC-ask2-2); a trash card for an empty folder the AI had just made (TC-ask2-12); Always
  allow notes that did not say what they cover (TC-ask2-15); and no question at all when a person saved a private room's
  file to Company-wide (TC-ask2-6).
- **Rule (explicit place, chat/explicit-place.ts):** the wider-audience save card (chat/turn.ts confirmWidening) and the
  move / copy card whose people only grow (tools/file-moves.ts) are skipped when the asker's own message of this turn,
  quoted lines left out and with no "don't", has a save / move / copy / make / put request (저장해줘, 보관해줘, 복사해줘,
  옮겨줘, 넣어줘, 만들어줘, 담아줘, "… 둬"; save / store / put / move / copy / make / create / add … to / in / into; the
  other app languages alike) **and** names the destination: the folder by a shown name in full as a place (namedInFull
  with place: "마케팅에", "to Marketing", "전사 공유에"; a project folder also by its project's name), "프로젝트에" /
  "in the project" when the destination is the chat's own project folder, or an everyone-word (팀원들도, 전사, 모두가 볼,
  다들, everyone, the whole team…; not a bare 모두 / all) when the destination is Company-wide itself (shared/).
- **Same exclusions as the 11-16 rule:** never in a chat with other people's words (shared, others wrote in it, rooms
  read, content someone else wrote: othersWordsIn), a scheduled run, Slack, a restricted or template run, a confidential
  chat, a message the app sent for them, a sub-agent's call, a publication's binding, a skill or hidden folder. A move
  where someone loses access, a move after a room read and the many-items card keep their cards. When unsure, the card
  stays.

| Card | After an explicit ask | Why |
|---|---|---|
| Fewer-people-can-see save ("…저장할까요?") | **skipped** when the message asks to save there and names the place (above) | the place is the person's own word; the card would only repeat it |
| move/copy that changes who sees | **skipped** when only more people see it and the message names the place; **stays** when anyone loses access | widening to a place they named is what they asked; narrowing takes something from others |

- **Empty folders (chat/own-files.ts emptyFolderMadeHere):** delete_files takes an empty folder (nothing but empty
  folders inside, at any depth) without a card when this person's answers in this chat made it (its own file history is
  theirs in this chat; never a folder made on the Files screen, moved in, or made in another chat). Nothing anyone sees
  goes.
- **Always allow notes (chat/always-allow.ts alwaysNote):** still one switch per kind ([Always allow on more cards](20261116-always-allow-more-cards.md));
  every card's note now names what it covers: the kinds with their own line keep it, every other kind says "앞으로
  {what} 다시 묻지 않아요" with its own {what} (6 languages), never "이런 확인".
- **A person's save of a room file (rooms/save-to-team.ts):** with `askWiden`, a save to a folder people outside the
  conversation can see answers 409 conflict `{params: {reason: 'audience_widened', viewersAdded}}` unless `confirm`,
  like a move or a restore; a client that sends neither saves as before. A person's move (POST /api/files/move with
  askWiden) already answers the same way out of a group or project folder.
- **One answer never asks twice about the same target (QA TC-f2-a04):** a yes for a place on the shared read card
  already covers it for the rest of the answer; now also a file this answer saved whole (write, make_file,
  save_work_file, save_chat_file; nothing changed it since: chat/shared-actions.ts wholeSavedInTurn) reads back as the
  chat's, not its folder's, and the wider-audience card's no (or no answer) for a folder stands for that folder for the
  rest of the answer (no second card; the refusal repeats).
- **A file this chat made (QA v2g, chat/chat-file-tool.ts chatMadeOwnFile):** in a shared chat, reading a file this
  chat's AI made in the person's own folder in any answer of it (madeInChat: untouched since) asks no read card, when
  every answer that wrote it ran while the chat was shared as now and none of them is kept from anyone (no k or x
  group). Any other own-folder file keeps the card.
- **One count (S-122):** after the many-items move / rename card and the bulk_files card, the tool result gives the AI
  the card's own number of people, labelled, so the answer cannot count again.
- **Tests:** tests/unit/ask-less-explicit-save.test.ts, one-card-per-target.test.ts, b-rooms-save-to-team.test.ts,
  b-always-allow.test.ts.
- **Version impact:** patch (fewer cards, wording; one optional request field).
