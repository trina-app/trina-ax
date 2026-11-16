# The AI shares a folder with its own tool, always behind its card

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds to docs/decisions/20261116-folder-share-server.md and 20261116-ai-share-card-and-stop.md)
- Branch: feat/share-folder-tool (PR 6 of docs/AGENTS/plan/20261116-1147-folder-sharing.md; security review M6, M7, M9;
  QA "Manual AI tests" MAN-019)

- **Ask:** "Share the folder QA-test with qa-b" got "folders can't be shared". Folder sharing exists on the server and the
  screen now; the AI should do what the Share dialog does.
- **Decision:**
  - `share_folder` is a tool of its own (`folder`, `add`, `remove`, `stop`), never a mode of `share_with_person`. It
    calls the dialog's own path (`FileShares.put` → `FolderShares.change`, audited `via: 'ai'`), so every server check
    runs again at the press.
  - An add **always** shows the server's card: no Always allow kind and no explicit-ask skip, whatever the person chose
    for files and whatever their message says. A folder grants what is put in it later too.
  - A removal or a stop only narrows, so it runs without a card when the asker's own message of this turn names the
    folder (and, for a removal, every person), with no "don't"; otherwise one card. Its record carries the server's
    Undo snapshot id (`Step.shared.undo`): Undo restores the still-valid grants, quietly, for the actor only, once; past
    its 10 minutes the card offers Manage access, never a client re-add.
  - A folder is "named" (`namesFolder`) only by its path, its place in words, a quoted name (any length) or the app's
    own mention (an attachment, a /files link). "Work" or "Reports" in a sentence never count. The check reads the
    asker's own words only, so a folder the AI learned from `looking_at` never counts as named.
  - Off: the gate closed, scheduled runs, confidential chats, Slack, restricted and template runs, guests; refused for a
    sub-agent; not offered to a room's AI or the remote connector. Where other people's words are in the turn (a shared
    chat, a chat others wrote in, rooms or a shared file read, content someone else wrote) it acts only when the asker's
    own message names the folder and, for an add, every person.
  - Never-shared places, a disk without birth times, a team folder and a running dev-environment task are refused before
    any card, with one plain sentence and the next step, and a refusal record whose reason is the Share dialog's own.
  - The record is the share card's (`Step.shared` with `files[0].folder`); only the person whose turn it was gets it, in
    every view (`ChatStore.viewSteps`; tested for a chat shared later).
  - Words: with the tool offered, `share_with_person` and the refusal rule send the person's own folder to
    `share_folder`; with the gate closed the interim "I can't share the whole folder yet, but I can share the files in
    it" stays.
- **Why:** the design's rule: a folder share never skips its card; narrowing is safe to run on the person's word and is
  repaired by the server's Undo.
