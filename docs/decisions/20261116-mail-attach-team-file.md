# A team file is attached to a connected service's send by a handle, on the connection's own card

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/mail-attach-team-file (AI scenario flow FL-08; QA rows in the PR)

- **Ask:** "이 견적서 김대리한테 메일로 보내줘" must send the mail with the file attached, after the one mail card
  there is today. In the AI scenario flow FL-08 the AI stopped at a draft without the file, or said it could not.
- **Cause:** a connection's MCP tool is called with the AI's own arguments only, and a mail tool takes a file as base64
  text in an argument. The AI cannot produce a team file's base64: `read` gives it text or a picture, never bytes, and
  a write over 100,000 characters is refused before the card. Gmail's send and draft refuse an attachment given by a
  path or a web address (the library would read this server's disk or fetch the address). No path carried a team
  file's bytes to a connected service.
- **Rule:** where a connection's tool takes a file's content as base64, the AI gives `team-file:<path in the team
  folder>` as that whole value, and the server puts the file there (`connections/team-attach.ts`, `tools.ts` mcpTool;
  also through `call_tool`, and Gmail's send and draft).
  - **Whose file:** read as the person of the turn as they are at that moment: read permission on the path, a regular
    file (no link, no hard link, no folder), not held by the safety check. A file they cannot read answers exactly like
    one that is not there.
  - **The card:** the connection's own card, the one a send raised before; no second card. Its first line is the file:
    "첨부할 팀 파일 / Team file to attach", the file's name, its size and its folder in the Files screen's words. The
    name the receiver will see is the tool's own argument, on its own line; the exact text shows the handle, never the
    bytes, and the card's 100,000-character limit counts the handle.
  - **After the card:** the account, its access and the file (same file, same size and times) are checked again right
    before the call is handed to the connection; changed: nothing is sent. The bytes sent are the ones read before the
    card. A file named twice in one call is refused, so the card and the cap count exactly what is sent.
  - **Size:** at most 10 files and 10 MB together in one call (base64 makes it about 13.4 MB; Gmail takes 25 MB a mail).
    Over it nothing is read or sent, no card is shown, and the AI is told the file's size and the limit and to say in
    plain words that the file is too large to attach here, with a link offered instead.
  - **Where not:** a tool that only reads (it raises no card); a scheduled run or any turn where nobody can answer a
    card. Guests, shared chats, confidential chats and runs limited to one task get no connection tools at all, as
    before (`chat/tools.ts`), so nothing changes there.
  - **Sends without asking:** a connection that already sends without the card for this person (the team's rule, or
    their own Always allow, whose card says it covers every send there) attaches without a card too, but only in a
    turn the person watches from their own app; a question asked elsewhere (Slack) attaches nothing without a card.
    The card decides as it did (docs/DECISIONS.md "Always allow on every card"), with one addition made in the batch:
    in a chat that holds content written by others (a room's messages, a teammate's file, a file shared with the
    person, a web page, a service's answer: docs/decisions/20261116-always-allow-more-cards.md "Content written by
    others"), a file the person's own message did not bring (named or attached it, or the AI made it in this answer)
    keeps the card (`TurnPerson.attachAsks`). The text of a send still follows the connection's rule there, as before.
    The audit line names every file that left.
  - **Stored keys:** a file whose bytes hold one of the person's stored connection keys (as text, as UTF-16, or cut by
    white space) is not sent (as base64 the AI writes itself, `hide-args.ts`); when the keys cannot be read just then,
    nothing is sent. Compressed content (inside an Office file or a zip) is not looked into.
  - **Afterwards:** the audit line (`tool_events`) names each file by path, size and the start of its hash, never its
    content. The file's readers join the chat's read scope, since the service's answer may repeat what it was sent.
- **Why:**
  - The file must reach the service without passing through the AI's text: a handle keeps megabytes out of the model's
    context and out of the card, and the server stays the only one that turns a path into bytes, with the person's own
    permissions.
  - The card is the consent for content that leaves the team (docs/INTEGRATIONS.md "Reads, writes and the confirmation
    card"). So the file is named on that card, and a call no card could cover in person (a read, a scheduled run) takes
    no file.
  - One convention for every mail connector: services name the content argument differently (`content`,
    `content_base64`, `data`), so the handle is recognised by its value, not by an argument's name.
- **Left out:** `api_request` (1 MiB body and no base64 convention); scheduled runs (a weekly report by mail needs the
  schedule's card to name the file, a follow-up); base64url or multipart uploads; attaching a file sent in a room or a
  chat that is not in the team folder (save it to the team folder first).
- **Tests:** `tests/unit/c-integrations-attach.test.ts`.
- **Version impact:** minor. No setting and no migration; a server without this refuses nothing new.
