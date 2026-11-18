# Files sent in a chat shared with people: the full read path and save_chat_file

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "The AI" item of DECISIONS.md "Files from the computer in a chat shared with people" (text layer
  only, no media, 32 MB), for chat_file
- Branch: fix/limits-people-chat-files (QA TC-4909, limits audit #7)

- **Before:** in a chat shared with people, `chat_file` read a file someone attached with the room-file extractors only:
  a recording or a video was "only its name is known", a scanned PDF "cannot be read here", a file over 32 MB "too
  large" (the upload takes 50 MB), 40,000 characters a call. No other tool reached the file, so it could not be saved to
  a team folder, stamped, merged, split, unzipped or resized. In a person's own chat the same file is a team file and
  gets all of that.
- **Read:** `chat_file` now calls the team read itself (`FileService.read`) on the chat file, bound through
  `ToolCtx.sharedChild` (the seam a shared folder's file uses): every open of the read (the first, a media slot's
  wait, right before delivery) checks again that the person sees the chat, the file is still there with the same
  bytes and is not on the download-only list. So it gets numbered lines (`offset`, `limit`), a PDF's pages (`pages`,
  `as_images`; scans as page images, or recognized text where pictures may not go), pictures, and video and audio
  (`time`, `frames`, `transcript`) with the read's own limits: the plan's read limit, 1 GB for media. The inner path
  (under `.system/`, which nothing authorizes) is never shown to the AI or written to the audit line; the result names
  the file by its name. The read's own bookkeeping (read-before-write hashes, the answer's file list, team paths in the
  read scope) goes to a throwaway view; the read is recorded as `{type:'chat'}` as before, and the turn's image budget
  is shared.
- **save_chat_file `{ file, save_as? }`:** a copy of the file, by its id only, into the team folder, made like
  `save_room_file`: refused before any card for a name instead of an id, skills/, an instruction file's name, a place
  the person may not write or a held file; then the wider-audience card with the chat as the source (the file was
  visible to everyone in the chat, but a team folder may be wider); then `placeProduced` (write access again, storage,
  a conflict copy next to an unread file, versions, file events). Default place: the person's own downloads, no card
  there. Offered where `chat_file` is (SHARED_TOOLS), never to a sub-agent or a guest.
- **Other file tools:** they take the copy's team path. In a shared chat, a read of the person's own folder normally
  asks to share it; a file whose bytes are exactly a file sent in this chat (and that the person sees) counts as the
  chat's instead (`chatFileCopyOf`, only files of a sent chat file's exact size are hashed), so "split this PDF" or
  "unzip it" after the copy asks nothing new. Once the copy is changed it is the folder's file again.
- **Kept:** who may open a chat file (seesChatFiles), the download-only list, the people-shared rule after a chat gets
  another audience, guests without the tools, the read record of the chat.
- **Left out:** passing a chat file id straight to stamp_pdf, unzip_file and the others (they go through the copy);
  raising the 50 MB upload limit of such chats (audit #25).
