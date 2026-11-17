# After a room read, a chat changes its own drafts in the person's own folder without a card

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (widens, for one case, the own-folder rule of docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기", which
  covered a new file in the person's own folder or one made in the same answer)
- Branch: fix/own-folder-cards

- **Ask:** the AI flow check of 2026-11-17 (tests/ai-scenarios, FL-08, default mode: nobody picked Always allow, on dev
  with #1168) showed 7 cards. After the AI read a room, fixing the quote asked a room card for the quote's HTML page and
  for its unstamped PDF, both made by the same chat in the person's own folder (users/<id>/…) one answer earlier. The
  owner: "권한을 너무 많이 물어보면 진짜 극혐", and "해야하는것들은 바로바로 해".
- **Rule:** in the person's own chat after a room read (or other people's words), with Always allow off, writing or
  changing a file goes without the room card when all of these hold (chat/turn.ts ownFolderTarget):
  - **(a) only the person can open it.** The file is inside users/<them>/ and the real audience check says nobody else
    can open it: no share row at the file or at any folder above it that lets anyone in (a file's or a folder's share
    with a person, a group or the whole team on it, paused too: files/share-readers.ts sharedWithAnyoneAt; a bare link
    id with nobody on it, which the app makes when a room post links the file or a "let them view" button is offered,
    lets nobody in), no folder share's people (privateToMe), and no folder rule
    that lets another person read it (rooms/ai-grants.ts readersOf). Not the path alone.
  - **(b) this chat made it.** From the server's own file events (chat/shared-actions.ts madeInChat, next to
    madeInTurn): the newest "create" at that path is a row of one of this person's turns in this chat, written by
    write, edit, make_file (its own text, or printed from a file it may read), edit_hwp or stamp_pdf, with no
    copy, move, rename, restore, conflict-copy, web or room mark; nothing was at the path before it; every change
    since is this chat's, by those tools; and no folder above it changed since. A copy, move or rename into place
    (copy_files, move_files, rename_file, the Files screen), a save from the web or a room, an upload, a restore, a
    change by the person on the Files screen, by another chat or by anyone else: not made by this chat.
  - **(c) nothing widens and nothing is special.** Only the writes the own-folder rule already took (write, edit,
    make_file, edit_hwp, save_room_file's new file); an existing file is never replaced by save_room_file (a room's
    bytes as they are), also one made in the same answer: never a share, a move out, a copy, a rename, a delete or a room
    post, which keep their own cards. Never a skill, a person's skills folder, an instruction file (CLAUDE.md,
    AGENTS.md, GEMINI.md, SKILL.md), a hidden folder (.attachments), a plugin's folder or a project's folder; never in
    a confidential chat, a chat shared with others now, or a restricted turn.
- **The PDF tools (QA TC-4703):** stamp_pdf, edit_pdf, merge_pdfs and split_pdf making a NEW file in the person's own
  folder after a room read go without the room card too, as write and make_file did (the own-folder rule for new
  files). Every place the call may write must qualify (chat/turn.ts ownFolderPdf): an explicit output (".pdf" added as
  the tool does), edit_pdf's replace (the PDF itself: an existing file, so only one this answer or this chat made), and
  without an output the tool's own new name in the PDF's folder (merge_pdfs: the first file's; split_pdf: its
  output_folder), plus the PDF itself when this answer wrote it (a PDF the AI made in this turn may be changed in
  place, docs/decisions/20261117-stamp-own-fresh-pdf.md). The source may be any PDF the person can read (a room file's
  copy, a group file): the output is still only theirs. Replacing a PDF the chat did not make, an output over such a
  file, a hidden PDF without an output, and any output outside the person's own folder keep the card (review round 4:
  no must-fix). writeTargetOf itself is unchanged (the room
  grants, the explicit-save rule and scheduled runs read it), so this widens only the own-folder rule.
- **Unchanged:** saving to a group folder or a shared folder, changing a file the chat did not make, and anything
  others can see keep their cards. The wider-audience card (a save where more people can see than can see what the
  chat read) is not touched. The step says "saved without asking: your own folder", as for a new file there.
- **Why this is acceptable (accepted residual, injection):** a planted instruction in a room (or a mail, a web page)
  the chat read can make the AI change, without a card, a draft that this same chat made and that only the person can
  open. It cannot reach a file the chat did not make, a file anyone else can open, a skill or instruction file, or any
  other person: a later share, send, room post or save to a team folder still asks on its own card (or goes by the
  person's own Always allow, Rule A, docs/decisions/20261116-always-allow-final-rule-a.md). The worst case is a wrong
  number in the person's own draft, which the person sees before anything leaves their folder (in the answer's file
  list and the step line), and the draft can be fixed again. A file made from a source (make_file printing the page)
  counts as made by the chat: it is new bytes at a new path, and changing it again destroys nothing but that output;
  the source stays as it was.
- **Independent review (Opus):** one must-fix, in: save_room_file could save a room's file over a draft the chat made
  (a teammate's bytes, a format write cannot produce) with no card; an existing file now always asks for it, also one
  made in the same answer (that hole was older than this change). Optional, not done: re-checking the own-folder pass
  right before make_file or edit_hwp writes after another card waited (only a parallel sub-agent call could change the
  file's audience in that gap; calls that change things run one at a time).
- **First real-AI rerun:** FL-08 default went 7 → 6, not 5: the unstamped PDF still asked, because posting the quote
  to the room offered a "let them view" button for it, which made the file's link id (nobody on it). The first version
  counted any share row as "others can open it"; a row counts now only when someone is on it.
- **Rule A is unchanged:** Always allow stays final; this rule is for people who have not chosen it.
- **Results:** FL-08 and FL-12, default and always, before and after: see the PR.
- **Tests:** tests/unit/b-own-folder-chat-made.test.ts (FL-08's own-folder cards gone; a card each for a shared
  personal subfolder, a file with a link, a file there before, one made by another chat, one the person changed, a
  copied file, a renamed file, a skill file, an instruction file, a group folder and a room file saved over the draft; the PDF tools' new own-folder outputs, and a card for a replace,
  an output over a file the chat did not make, a team-folder output and a split into a group folder).
- **Version impact:** patch (fewer cards; no schema change).
