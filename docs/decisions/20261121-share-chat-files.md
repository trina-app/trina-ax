# Sharing a chat offers its files: copies by their owner's press, no view-only tier, the chat's copy wins in links

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (adds to [Chats shared with people and groups](../DECISIONS.md), [20261116-shared-files-for-the-ai.md](20261116-shared-files-for-the-ai.md)
  and [20261118-chat-files-full-read-and-save.md](20261118-chat-files-full-read-and-save.md))
- Branch: feat/share-chat-files (plan [20261121-0249-share-chat-files.md](../AGENTS/plan/20261121-0249-share-chat-files.md);
  the owner, 2026-11-21)

- **Ask:** the owner shared an existing chat with one person. Trina had made a quote PDF and its HTML in the owner's
  own folder; the other person clicked the file in the chat and got "The file can't be found, or you don't have access
  to it", a dead end. The owner: sharing a chat is for working together, so **no view-only tier**; ask at share time,
  the way Gmail asks "share these Drive files?"; files made later just work.
- **Rule 1, ask at share time:** when the creator shares a chat with people (or opens Share on a chat already shared)
  and the chat made files in their own folder (`madeInChat`, from file_events only, unchanged since), the Share dialog
  asks "Share the files from this chat too?" with the list, [Share without files] [Share with files]. Nothing is
  ticked one by one in this version: the made-here files go together.
- **Rule 2, copy by the owner's press, never a grant:** "Share with files" copies each file into the chat as a chat
  file (`chat_files`), attached to the answer that made it. `origin: 'shared-copy'` in the attachment JSON is the one
  provenance mark (session e6 uses `'ai'` in the same field); the source path and sha256 for the server's re-check sit
  beside it in the same JSON. A client never gets the sha256, and the path (in the creator's own folder) only the
  creator. A copy may be up to 1 GB within the team's storage (`CHAT_COPY_MAX`, to be one constant with e6's cap for
  the AI's attached files); people's uploads keep 50 MB. It is streamed from the checked descriptor into a temp file,
  never held in memory (a picture, whose metadata is cut out in memory, at most 50 MB). Nothing is written into anyone's own folder, no folder rule or per-file grant changes, and the
  original stays in My files. The copies are the chat's: everyone in it opens them, someone taken out loses them with
  the chat, and they go when the chat is deleted for good. A file leaves its owner's folder only by its owner's press.
- **Rule 2b, a hidden answer's file stays hidden:** a file whose making answer is hidden from anyone who sees the chat
  or is being added (chat/shared-answers.ts) is never offered or copied, and a copy carried only by answers hidden from
  someone is not theirs to open (the file, its thumbnail, `chat_file`, `file-access`), also for people who join later.
- **Rule 3, the chat's copy wins in links:** inside that chat a link to the original's path opens the chat's copy, for
  everyone, the creator included, so nobody works on two different files by accident: the creator's page maps the path
  to the copy; for everyone else the link's panel asks the server (`file-access`), which answers with the copy, so
  nobody else learns where the original is. The AI of whoever runs a turn
  there is told the copy's file_id in the transcript (`chat_file`).
- **Rule 4, checked at the press:** the confirm key binds every (path, sha256). At the press the server lists the
  files again, reads each from one descriptor and hashes the bytes it read. Anything different (changed, moved, gone,
  a new file): nothing is saved or copied and the step is asked again. Sharing again makes no second copy of the same
  path and bytes.
- **Rule 5, the dead end asks:** in a chat shared with people, a file link that does not open offers "Only <creator>
  can add this file to the chat" with [Ask to add it]. Only for a path the chat made in its creator's own folder; every
  other case is one generic "can't open" answer that never says whether the path exists, whose it is or where it is.
  The ask is untrusted: [Add to the chat] in the creator's Activity runs Rule 4's check for that file and copies only
  then. Leaving the chat closes the person's waiting asks there. The limits are the access requests' own.
- **Why:** a grant would put other people's writes into a private folder (users/<id>/ stays private by path, admins
  too). A shared folder per chat would be a second model next to chat files. Copies reuse the one place whose audience
  is exactly "who is in the chat now".
- **Left out (follow-ups):** new AI output in chats shared with people and AI edits of chat files (session e6,
  `fix/ai-sees-and-saves-workspace-output`); version chains and people editing a chat file in place; asks routed to
  admins or to a file owner outside the chat; team projects (copies into the project folder); per-file checkboxes and
  "used here" files.
- **Tests:** tests/unit/b-share-chat-files.test.ts; tests/security/share-chat-files.test.ts; web/test/e2e/share-chat-files.spec.ts (1440 and 390).
- **Version impact:** minor (new optional API fields and the `file-access` routes; no migration).
