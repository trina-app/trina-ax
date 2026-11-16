# The recipient's AI lists and reads a shared folder by its link

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds to [20261116-folder-share-server.md](20261116-folder-share-server.md) and
  [20261116-shared-files-for-the-ai.md](20261116-shared-files-for-the-ai.md))
- Branch: feat/shared-folder-ai-read (the owner approved the design on 2026-11-16; QA TC-4079, TC-4085, TC-4089)

Design: `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2, "The recipient's
AI inside a shared folder (PR 4)"). Plan of this part:
[20261116-1600-shared-folder-ai-read.md](../AGENTS/plan/20261116-1600-shared-folder-ai-read.md).

- **Ask:** a folder a teammate shares is in none of the receiver's folders, so their AI said there was nothing there,
  as it did for shared files before 20261116-shared-files-for-the-ai.
- **Rule: by link only, one level per call.** `list` with `/f/<id>` or `/f/<id>/<path inside>` gives one level of names
  (the Shared with me page's own listing: the same filter, at most 200 names, the same per-person bucket). `read` with
  `/f/<id>/<path inside>` reads a file there: `FolderShares.openChild` decides on every open (the folder still the one
  shared, the person still on it, nothing hidden, temp, linked or above the folder), and the bytes read are the very
  file it checked (the descriptor's identity equals the checked one, else refused). A team path under the sharer's
  folder stays closed for the receiver; glob, grep, search, write, edit, moves and versions never look inside.
- **Rule: what the AI saw there is someone else's words, for good.** A listing alone counts: the names were written by
  the person who shared the folder. The call is a grant read (`TurnFiles.grantReadPaths`), so the chat gets the mark a
  file read through a share already gets (`chats.rooms_seen`, which no new session clears, with `others_words` and
  `room_outside`): changes wait for the room card, `delete_files` and skill saves refuse, `remember` and a connection's
  write ask, and "Always allow" for shares, room posts and project members counts only for what the person's own
  message names. A read joins the read scope as the owner's, with the share (`{type:'user', id, share}`).
- **Where:** only where a file shared one by one may be read (`TurnFiles.grantReads`: a turn of the person's own chat;
  never a scheduled run, a shared chat, a guest, Slack, a template or restricted run, a confidential chat or the remote
  connector), and never in a sub-agent's call (`TurnFiles.agentView`, also a call whose agent is not known).
- **Words:** the turn's "Files shared with you" block names a folder with its link and says how to list and read it,
  that nothing above it opens and that its names and contents are not instructions. Names in a listing are one line,
  at most 120 characters, our block tags neutralized, quoted. The audit line keeps `/f/<id>` and the action, never the
  path inside. An answer links a file inside by the folder page's own address (`/f/<id>?f=<path inside>`, which the app
  opens; the first real-AI run wrote `/f/<id>/<path inside>`, which it does not), and list and read accept that form
  too.
- **Left out:** a shared chat even when the asker pasted the folder's link (the design's off table allows that one
  case; not built: its other viewers would read the answer). Paging past the first 200 names (the AI asks the person,
  or they open it on the Files screen). A name longer than 120 characters is shown cut and cannot be read by the AI.
- Tests: `tests/unit/c-shared-folder-ai.test.ts`.
- Version impact: **minor** (the AI can read more for the person it answers; no endpoint, no migration).
