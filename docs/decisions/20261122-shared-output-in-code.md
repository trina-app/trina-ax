# In a chat shared with people, the server moves a new file in the asker's own folder to the chat

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (amends [20261121-shared-chat-output-to-chat-files.md](20261121-shared-chat-output-to-chat-files.md)
  "This is one line of the shared-chat instructions, not special code")
- Branch: fix/sharing-sq-findings (QA TC-7261, TC-7279, TC-7376, TC-7280; plan
  docs/AGENTS/plan/20261121-2342-sharing-sq-findings.md Part 2)

- **Ask:** in chats shared with people the AI kept saving decks, reports and videos to the asker's own folder. The
  answer showed a normal link, and the other people got "not found" or "can't play". The 2026-11-21 rule (the file goes
  to the chat) was only an instruction.
- **Rule:** in a chat shared with people (not a project chat), when the main AI calls a produce tool with one output
  (make_file, edit_pdf, merge_pdfs, stamp_pdf, comment_docx, make_zip, resize_images) whose output is a new path in the
  asker's own folder (users/<asker>/…), the server changes the output to `chat:files/<name>` before any card weighs
  the call (chat/turn.ts TurnExec.sharedOutput), and the file is attached to the answer. It does not when: the asker's
  own message of this turn names that folder (a sub-folder by its name; the folder itself by "my files" / "내 파일" and
  the like); the path is there already (the save card asks, as before); the turn may not attach a chat file
  (mayAttachChatFile: a k answer); a sub-agent; any other folder (a group folder, skills/) or any other tool (write,
  save_chat_file, save_connector_file, save_room_file keep their places: they save to the asker's folder on purpose).
- **Also (same root):** a "My files" attachment in a chat shared with people goes in as a copy kept with the chat when
  some people there cannot open it, only for the sender's own folder (chat/attach-copies.ts; 20261121-share-chat-files
  Rule 2: the owner's press of Send, with a line in the box saying so). At a first share, a dev environment answer of
  the private time is no longer kept from people added later: the Share dialog says it in a line of its own
  (devAnswers) and the press covers it; the "not all known" mark is per answer, not on every answer at once. A later
  share says how many earlier answers stay hidden from the people added (hiddenAnswers).
- **Known limit:** an app build older than this one does not show the dev environment line (it knows no `devAnswers`);
  its Share press then covers those answers without that line. Accepted for the MVP (the owner may ask to keep them
  hidden instead: per answer `x`, the fallback the plan review named).
- **Why:** a link that is dead for most of the chat is worse than a file in the chat; the people of the chat are the
  audience the asker chose.
- **Tests:** tests/unit/places-produce.test.ts "QA TC-7279/TC-7261 …"; tests/unit/b-share-chat-people.test.ts "QA
  scenario P1s".
- **Version impact:** patch.
