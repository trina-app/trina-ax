# In a chat shared with its files, a path to a copied original means the chat's copy

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (narrows rule 7 of docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md, "the resolver never maps
  a team path to chat:files/")
- Branch: fix/shared-chat-copy-paths (QA TC-v1b-*, QA-D flow 4, TC-v1d-02; plan
  docs/AGENTS/plan/20261122-0503-shared-chat-copy-paths.md)

- **Ask:** after "Share with files", the answers still link the original in the sharer's own folder. Another member's
  AI followed that link, was refused and made a new file instead of a version of the chat's copy. It depended on the
  model reading a note.
- **Rule:** in a chat shared with people now (not a project chat, not one made private again), for the main AI only,
  every tool call's source and in-place path arguments that name a path recorded as copied into this chat (`from` of
  a 'shared-copy' attachment the person may see, chat-files-share.ts sharedCopyMap) become the copy's
  `chat:files/<id>/<name>` before any other step (chat/copy-paths.ts, run by mcp/protocol.ts callTool through
  TurnToolSet.mapPaths). For everyone, the sharer too: one file, not two, as the web already shows it to them. A read
  opens the copy; write, edit, edit_office and edit_pdf save a new version of it. The transcript a fresh session gets
  names the copy's path in place of the original's.
- **Not mapped:** destinations (folders, a new file's output, save_as), the tools about the file itself (delete, move,
  rename, who can open, share, stop sharing), sub-agents, any path not recorded as copied. Those keep their team
  handling.
- **Accepted:** a member's tool call may tell whether a path in the answer's text was copied (the path is in the text
  they see already). The sharer's reads in the shared chat give the copy, not a newer original; "Share with files"
  again adds the change as a version.
- **Share dialog:** "Share the files too" is ticked by default when no listed file is marked as made from what the
  people can't open and the check warns about no pick; unticked by default otherwise (the #320 rule for those files).
