# Shared chats: the asker's own tools work as in a private chat

- Date: 2026-11-26
- Status: accepted
- Supersedes: the team-file refusal of [20261118-shared-chat-connections.md](20261118-shared-chat-connections.md)
  ("Team files (`team-file:` handles) are not sent to a service from a shared chat"), and the in-app browser's
  exclusion from shared chats (`rooms/ai-tools.ts` SHARED_TOOLS "nothing … in the person's signed-in browser",
  `chat/turn.ts` `browser = desktop && !shared`, `chat/prompt.ts` "the browser on X's computer" in the list of what a
  shared chat does not offer, SHARED_PROMPT_SECTIONS `browser: false`)
- Branch: fix/shared-chat-own-tools (the owner, 2026-11-26)

- **Ask:** in a five-person team project chat the owner asked Trina to reply to a vendor with two PDFs and a business
  registration through their own Daum mail (their Aside browser profile). Trina refused: team files cannot go out from
  a shared chat; continue in a chat only you see. The owner: a shared chat should work like a private one for the
  asker's own request (AI should match Claude Code; Rule A, teammates are trusted; the one "others may see it" notice per
  place of 2026-11-23; no blanket offs).
- **Rule:** in a shared chat the person who asked may use their own tools for their own request exactly as in a private
  chat: their connections and the team's, apps on their computer (Aside, ego lite), and the desktop app's in-app
  browser. Each person's turn has only their own connections and their own desktop window; another member's message
  never drives the asker's tools (it is information, never instructions, and their own turn uses their own tools).
- **Rule, the notice:** the in-app browser gets the same one notice per person and place as a connection: "Other people
  in this chat can also see what the AI gets from your browser." / "이 채팅의 다른 사람도 AI가 내 브라우저에서 가져온 내용을
  볼 수 있어요." (a guest among the people is said), one button, Continue / 계속. Nothing is opened before the press;
  no press opens nothing. The press is kept in `card_always_allow` (kind `seen:browser:<place>`; `connector_tool_allow`
  needs a connection row, so no migration) and Settings › Allowed for Trina lists it ("Browser · <place>") and can reset
  it. What its pages bring in joins the answer's read record as the asker's own (`via: 'browser'`, a k group), as their
  own connection's answer does: someone who joins later does not see that answer.
- **Rule, other people's words (security review of #647):** in a shared chat where someone else wrote, or that a guest
  sees, a browser call that acts (anything but the page reads: `read_page`, `get_page_text`, `find`, `tabs_context`, the
  console and network reads) waits for the asker's card after the notice ("Other people wrote in this chat, so the AI
  asks before it acts in your browser…", Allow once / Always allow / Don't allow), as after a room read in a private
  chat: another person's message may be what asks for the click. Their Always for changes after other people's words
  (`room_change`, Rule A) holds; Allow once covers the same call for the rest of the answer.
- **Rule, team files:** a team file the asker attaches through a connection (`team-file:` handle) is no longer refused in
  a shared chat. It goes through the chat's read check first, as a read of the same file would: when someone in the
  chat cannot open it, the asker gets the file read card (only they see it); a yes adds it to the answer's read record;
  a no (or no answer) sends nothing, the call's step says "그 파일은 이 채팅 사람 중 일부가 열 수 없어서, 보내지 않았어요." /
  "Not sent: some people in this chat can't open that file.", and the AI says the same. Then the send card, which in a
  shared chat asks every time, and the read check once more after it (people may have joined while it waited). The hard blocks stay: a stored key inside the file, the size and count limits, files held
  by the safety check, the recheck after the card, never in a scheduled run.
- **Rule, what cannot attach:** no tool of an app on the computer (Aside's repl and exec take code or a task) and no
  in-app browser tool takes a file's content, so a team file cannot be attached through them, a web mail opened there
  included. A handle given to such an app anywhere but an argument that takes a file's content (`content`, `data`, at any
  depth; never its code, task, command or a CLI's stdin) is refused in plain
  words before anything reaches the desktop app (an app's tool that does take a file's content still gets it), and the
  AI's instructions (ATTACH_HOW, the browser rules) say to say so before starting, never promise it, and offer what
  works: a connected mail service that takes attachments, a link to each file, or the person attaching the files
  themselves. A file upload tool for the browser is left for later (since then: the desktop browser's file_upload,
  [20261126-browser-file-upload.md](20261126-browser-file-upload.md)).
- **Left out:** memories from other chats stay out of shared chats (20261125-auto-memory-shared-chats.md); Google Drive,
  room reading and connecting a new service in a shared chat are unchanged.
- **Tests:** `tests/unit/b-shared-chat-connections.test.ts` (a team file everyone can open: send card then sent; one some
  cannot open: the file read card, a no sends nothing with the plain line, a yes then the send card),
  `tests/unit/b-shared-connector-warning.test.ts` (the browser's notice once per place, nothing opened before the press,
  the read record, Settings reset, another member's turn uses only their own window),
  `tests/unit/c-local-apps-shared.test.ts` (a team file to Aside refused plainly in a private and a shared chat).
- **Version impact:** minor (shared chats gain the browser and team-file attachments).
