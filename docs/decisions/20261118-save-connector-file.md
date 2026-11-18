# Gmail attachments and Drive files saved as the original file

- Date: 2026-11-18
- Status: accepted
- Supersedes: in [docs/GOOGLE-APPS.md "Attachments"](../GOOGLE-APPS.md) and `google-apps/attachments.ts`, "a PDF or a
  picture is kept for this chat and saved with save_url; other kinds are saved from their text"; Google Drive being
  read-only text for the AI
- Branch: fix/audit2-conv-connectors (limits audit 2, N17 + N18, QA TC-4927)

- **Ask:** the owner's goal for limits is "the AI should behave like Claude Code". A Word, Excel or Hangul attachment
  could be kept in the team files only by retyping its text (formatting, formulas and pictures lost), and a Drive file
  not at all. Claude Code copies the file.
- **Rule:** one tool, `save_connector_file`, saves the original bytes into the team folder. `file` is either an
  `mcp-file:<id>` handle (every Gmail attachment the AI read is now kept for the chat, any kind; also any file in a
  connection's answer, which save_url refuses when it is not an image, PDF, video or audio) or `drive:<file id>` (a
  Google document, sheet or presentation exported as .docx, .xlsx or .pptx). Name: the file's own; `save_as` as in
  save_url (a folder ending in "/" keeps the name); default the person's own `users/<id>/downloads/`.
- **The normal save path:** never under skills/ or as an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md,
  SKILL.md); write access checked before anything is fetched and again in `placeProduced` (a version of a file the AI
  read in this turn, else a copy next to it; storage check; file events); the wider-audience card before the write, on
  what the chat read (the connection's answer, or the Drive source, which the save records first); without a chat
  turn's check only the person's own private folder; bytes on the team's safety-check list are refused.
- **What each connection may do stays:** a handle opens only in the chat whose answer made it, only for that person,
  for 24 hours (connections/media.ts). Drive goes through drive_read's own path (`tools/drive.ts withDrive`): the
  person's own Drive or a team share, a share only inside its folders, the share checked again after the call. In a
  shared chat (PR #1276) a Gmail attachment was already behind the asker's card when it was read, so its handle can be
  saved there; `drive:` is refused in a shared chat, because Drive tools are not offered there. Guests: not offered
  (not in GUEST_TURN_TOOLS; guests have connectors off).
- **Security review (2026-11-18):** the name is cleaned (no control or direction marks, no "..", never an
  instruction file) and checked against the bytes: a program or script is never saved, a known kind gets its own
  extension, a ZIP that is not an Office or Hangul file is saved as .zip. A Gmail attachment's name is the one the AI
  passed (`file_name`, copied from the message listing): the library's attachment answer carries no name, and the
  listing is the library's text too, so reading it again would not make the name more trustworthy; the checks above
  are what makes it safe. The place (a folder too) is checked for write before anything is read. A handle needs its
  connection still there and usable by the person (`mayUse`), and the save records the connection's sources again
  before the card (as save_room_file does). Kept files go with a purged chat and a deleted account.
- **Caps kept:** a Gmail attachment at most 18 MB (what one answer can carry), a Drive file the server's read limit and
  32 MB (10 MB for an export). The kept-media caps (200 MiB a chat, 1 GiB a person, 4 GiB a server, 24 hours) stay.
- **Not done here:** OCR of attachments, `offset` for long Drive or attachment text (N11/N18), Drive in shared chats.
