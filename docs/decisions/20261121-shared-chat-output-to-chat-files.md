# In a chat shared with people, a file the AI makes goes to the chat (chat:files/) unless the user names a folder

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (amends [20261117-ai-save-my-files-default.md](20261117-ai-save-my-files-default.md) for chats shared
  with people; the PR2c H1 design of the earlier shared-chat plan, never built)
- Branch: feat/places-outputs (plan docs/AGENTS/plan/20261121-0652-places-outputs.md, P3 of
  docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md)

- **Ask:** in a chat shared with people the AI could hand over a finished file only through save_work_file; a deck or
  a PDF it made with make_file went to the asker's own folder, which the others in the chat cannot open.
- **Rule (where):** in a chat shared with people (not a project chat) a file the AI makes for the people there goes to
  the chat itself: the produce tools (make_file, edit_office, the PDF tools, stamp_pdf, comment_docx, resize_images,
  make_zip) take `output: chat:files/<name>`, and the file is attached to the answer, where exactly the chat's people
  open it. A team folder only when the user names one. This is one line of the shared-chat instructions, not special
  code: the AI decides. A name that is taken in the chat gets "name (2).ext"; nothing is overwritten.
- **Rule (who):** the resolver decides (server/src/files/places.ts mayAttachChatFile): only the main AI of a chat
  shared with people, and never in an answer with a k group (a connection's answer hidden from people added later).
  A shared project chat keeps the project folder as its only save place (owner, 2026-11-21); a personal, confidential
  or scheduled chat, a guest, a sub-agent and remote MCP are refused in plain words.
- **Rule (sources):** what goes into the new chat file is weighed as a read of the chat: a source some of the chat's
  people cannot open (an embedded picture, a template) asks on the shared read card first. A document's references
  resolve through the place it is in: a source in the chat's work folder takes its pictures, stylesheets and fonts only
  from the work folder, one in the chat's files only from the chat's files; never from the team folder.
- **Rule (link):** a chat file's link is `/c/<chat>?file=<id>`; the tools give it, the API engine's link guard keeps it
  only when a tool gave it, and the app opens the file's viewer beside the chat.
- **Kept:** the 1 GB cap for the AI's chat files (CHAT_FILE_AI_MAX), the turn's write limits, the storage check, the
  quarantine hash, `ChatFiles.createFromAi` as the one attach (#200).
- **Tests:** tests/unit/places-produce.test.ts; web/test/unit/chat-file-link.test.tsx.
- **Version impact:** minor (a new kind of output and source for the produce tools).
