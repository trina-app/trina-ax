# Always allow on the share, web address and room-post-with-files cards

- Date: 2026-11-16
- Status: accepted
- Supersedes: the archive's "A member shares their own files" (its card was shown every time); the "review of #678"
  line of "Always allow on every card" (no Always allow on a room post card that offers the linked files); the
  "an unknown exit address" exception of "Allow all websites covers the AI's web reads"
- Branch: fix/always-allow-more-cards (QA TC-3809, TC-3810, TC-3811)

The AI flow check of 2026-11-16 (tests/ai-scenarios, report 2026-11-16-flows) found three cards with no "Always allow",
against the owner's rule (2026-11-11 and 11-14: "Always allow" ends the asking for its scope, offered on the first card,
the caller's own switch, also in rooms, side chats and scheduled runs). In the flows that pick "Always allow" these
cards still came every time: FL-02 and FL-13 (sharing), FL-05 (a web address), FL-14 and FL-27 (a room post with files).

- **Sharing a file with a person or group (share_with_person, kind `share_files`).** The card offers "Always allow"
  on its first showing; once picked, shares go without the card. Every other check stays and runs without the card
  too: only the person's own files they may share, never a folder or a guest, the team's switch, the grant's own
  checks. A scheduled run of that person may share under it (only their own choice counts there, as for
  post_to_room). Where other people's words are in the turn (a shared chat, a chat others wrote in, or one that read
  rooms: a ✦ side chat, room_read, a quoted room message; independent review):
  - the file must still come from the asker (named or attached in their own message, or made by the AI in this turn),
    with or without the card;
  - the choice counts only when the asker's own message names every recipient (post_to_room's rule, `namesRecipient`):
    otherwise the card shows, without "Always allow". This is the existing post_to_room rule, kept so the two actions do
    not drift, not a new guard.
- **A room post that offers the linked files (post_to_room, kind `post_files`).** The card that offers
  [파일도 함께 보내기] now offers "Always send with the files" / "항상 파일도 함께 보내기". Picking it sends this post with
  its files; later posts that can carry linked files go with them and no card. A post with no file to offer stays
  kind `post_to_room` (its own first card). Shared chats keep post_to_room's rule (the asker names the recipient; never
  for own words). It holds after a room read too (a side chat): the independent review suggested sharing's file-origin
  rule here as well, but that would make "고친 제안서 방에 올려줘" (no file name) ask every time, and the owner's rule is
  no teammate-injection guard that makes the person's own choice ask again; left to the owner.
  The two kinds stay apart on purpose: "Always" on the files card can only mean "with the files" (nothing sends more
  than the person picked), so a person who chose it on one kind still meets the other kind's first card once.
  This also covers the report's "room-read guard" card ("여기에 대화 메시지(다른 사람이 쓴 글)가 들어와서…") without
  "always": in FL-14 and FL-27 that was this same card (its first line is the room-read line), not another kind.
- **A web address while the server's exit address is unknown (url-gate.ts, "Allow all websites").** The FL-05 card
  ("AI가 이 주소를 열려고 해요. 내부 네트워크의 기기…") is the `noEgress` card: the server has not learned its own public
  exit address yet (tools/egress.ts), so it cannot refuse a name that leads back to itself (hairpin NAT). The gate
  skipped every rule there, ①d included, and the card never offered "Allow all websites", so nothing ended the asking.
  Now, while the address is unknown:
  - ①d (the person's own "Allow all websites", while the team allows it, in a turn they watch) opens a plain address
    without the card, and the card offers "Allow all websites" on such an address;
  - a plain address has a site name, never a number (`siteOf`), no random-looking part, long name before the site,
    user name or long query, and is not an echo; everything else still asks;
  - private, local and metadata addresses stay refused on every hop after the lookup (web-fetch.ts), with or without
    the switch; ①b ("this site in this conversation") and typed addresses still ask while the address is unknown;
  - accepted: a public name that resolves to this server's own exit address can open under the person's switch, the
    same trust the switch gives any site ("can send anything it can read to any site"). On a running server the
    address is learned at start (the feed's /ip), so this card is rare outside test servers.
- **Content written by others (added in the batch, QA rows in PR #1109).** "Other people's words" for these gates is
  no longer only other people's messages. A chat is marked (`chats.others_words`, migration 410, chat/turn.ts
  `markOthersWords`) once content someone other than its person wrote comes in:
  - a team file another person wrote or changed (every event that gave the file content must be the person's own; a
    file outside their own folder with no known history counts as someone else's), also as a team attachment or a
    search hit; a file read through a share grant (which also counts as a room read for the rest of the chat, and is
    not read in a scheduled run: 20261116-shared-files-for-the-ai.md); a file in their own folder that an AI answer wrote after its chat
    read such content, or that was copied from one;
  - a web page or search, the browser, Google Drive, Slack, a room's files, a connected service's answer, any tool
    not on the list of tools that bring nothing in (`OWN_WORDS_TOOLS`, fails closed);
  - a team, group or project skill, and project instructions someone else wrote.
  Not counted: the person's own uploads, attachments and files (their own bytes are their own choice), and the names
  a listing shows (a search's hits count as read, whatever it prints). The mark stays until the chat's session starts anew, like `session_tainted`.
  In a chat with the mark, or one that read rooms (`shared-actions.ts othersWordsIn`):
  - **share_with_person:** "Always allow" counts only when the person's own message (quoted lines left out) asks to
    share or send, names every recipient and names every file (or they attached it, or the AI wrote it as a new file
    in this answer). Otherwise the card shows, without "Always allow". Naming a person is not asking to send to them
    ("summarise the notes Tess wrote"), so the request word is needed too.
  - **"Made in this answer"** (also for the shared-chat rule): a new file the AI wrote in this turn, with nothing at
    that path before. A file copied, moved or renamed into place, or an older file edited in the turn, is not.
  - **post_to_room:** "Always allow" counts only when the person's own message asks to send or post, for a place it
    names or the side chat's own room; "Always send with the files" only when they brought each linked file the same way. This replaces the line
    above that left the files rule after a room read to the owner: "고친 제안서 방에 올려줘" after a room read now shows
    the files card once per post. A post without files to a named place stays card-free.
  - **change_project_members:** the card shows there, also under "Always allow".
  - **A scheduled run:** the same rule on the task's own text; a card there gets no answer, so nothing is sent.
  What the person names themselves stays as it was: an explicit ask has no card, and "Always allow" covers their own
  asks. A chat that read only their own files is not marked.
  Known limits: a file the AI makes in the answer may hold what it read; a file or folder name, a skill's description
  in the skill list and a connected service's tool descriptions can carry words; the text of a post to a place the
  person named is the AI's. The mark is cleared with the session (an edited first message), as the other marks are.
  **Second review (in):** two more rules.
  - "Always allow" covers the person's own asks in every chat, marked or not: a share needs their own message to ask
    to share or send and to name every recipient; a post needs the place named (or the side chat's own room) and the
    ask; a project's members need every name in their messages; a team file attached to a send needs the person to
    have brought it (named or attached it, or the AI wrote it new in this answer). A name a teammate chose (a shared
    file's, a folder's) reaches the AI in a chat that read nothing, so no chat is free of other people's words. Which
    file to share stays the person's "it" in a chat without the mark. A card that shows where the choice does not
    count still offers "Always allow" on its first showing in a chat without other people's words.
  - "Written new by the AI" is one rule for every gate (`shared-actions.ts WROTE_IT_SQL`, also answer-share.ts): a
    create by write, or by make_file from the AI's own text, with nothing at the path before. A file any tool built
    from another file, a page or a room (make_file with a source, stamp_pdf, edit_pdf, split_pdf, merge_pdfs, edit_hwp,
    comment_docx, save_url, save_room_file, a video) is not.
  Left as follow-ups (QA rows): the person's own uploads and inline attachments do not set the mark; the explicit-ask
  words may sit anywhere in a long pasted message; find_tools descriptions.
  **Independent review:** one must-fix (a file copied or renamed in the answer counted as made in it) and the
  should-fix items (the request word, find_skills, the order of the grant check) are in.
- **Where it still never applies:** as before (always-allow.ts): a Slack question, a company profile draft and other
  restricted turns, a confidential chat, the team's switch off, someone else's choice.
- **Settings:** the two new kinds are listed in Settings › 트리나에게 허용한 것 ("Sharing my files with people", "Sending
  linked files with posts to conversations") and taken back there. "Allow all websites" stays in Settings › Browser.
- **Tests:** tests/unit/b-share-with-person.test.ts, b-post-to-room.test.ts, web-allow-all.test.ts,
  b-others-words-gates.test.ts (content written by others).
