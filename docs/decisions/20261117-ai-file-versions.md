# The AI reads a file's earlier versions with read and `versions`

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/ai-file-versions (QA TC-4547, manual row MAN-022 on qa.trina.app)

- **Ask:** qa-member2 changed line 2 of a project file, QA-plan.md. Asked "What did qa-member2 change in QA-plan.md?",
  the AI said it had no version history, so it could not see who edited the file or what it said before. It printed
  the new text and sent the person to Version history on the Files screen. The hub keeps every overwritten version
  (`file_versions`, the Files screen's Version history), but no AI tool could reach them.
- **Why:** the versions are already kept and shown on the Files screen. Answering "who changed what" is reading, so the
  AI should do it in place, with no new tool for the model to learn and no new permission to reason about. Sending the
  person to a screen for something the AI can read is the kind of avoidable refusal the owner asked to remove.
- **Rule:** the existing `read` file tool takes two new options. No new tool, and no card, because it only reads.
  - `versions: true` (or a number from 1 to 20; default 5) returns the file's kept versions instead of its text, newest
    first. For each version it gives who saved it, when it was replaced and by whom, and its size. People are named by
    their display name, never by an id or a path. Times are UTC to the minute, the same form `list` uses.
  - It also returns the changes between the version before the current one and the file now, as unified-diff lines
    (`-` removed, `+` added, with line-number headers). At most 8,000 characters are shown, and the result says when
    it is cut.
  - `version: n` compares that earlier version with the file now instead.
  - Text, Word, Excel, PowerPoint, Hangul and PDF files are compared through the extractor `read` already uses (for a
    PDF, the text layer only, no OCR). Pictures, videos and sound files get the list only.
  - Conflict-copy rows are left out. A conflict copy is a separate file, not a version of this one.
- **Access:** the same as a plain read of the file.
  - The file is opened with `readAuth`, the check `read` uses. A file the caller cannot read gives exactly the answer
    a plain read gives (and the same as for a missing file). Other people's personal folders never open, not even for
    an admin.
  - The versions themselves come from `TeamFiles.history`, so each one is judged the way the Files screen judges it:
    a folder that is now in the trash, versions saved inside a project, folders that moved.
  - A file the person may read only because it was shared with them one by one shows no earlier versions. Versions
    follow the folder rules, as on the Files screen.
  - The file joins the turn's read scope, so a later save to a place where more people can see it is still checked.
    It does not count as "read" for read-before-write, because the AI did not get the whole current text.
- **Where:** every place that offers `read` gets the options with it: chats, sub-agents, rooms' ✦ side chat, guests (who
  see only their own places), and the "Trina AX MCP" connector. The read tool's description tells the model to use
  them for "what changed / who changed it / what did it say before" instead of saying there is no history. There is
  no separate prompt rule: the description is read with the tool, and a second copy would cost tokens on every turn.
  Add one only if a real-AI run (FL-28) shows the description is not enough.
- **Read scope:** the compared version's text is shown, so the places it was saved in (the path at save time and the
  live path of its folder) join the turn's read scope too. A file moved out of a narrower folder then keeps that
  folder's audience for a later save, room post or share.
- **Edge cases:** the file list, a file link and a file in a shared folder are resolved first, as a plain read does.
  The file list has no versions, so it answers "no earlier versions", never "not found". The list of versions is always
  given; only the comparison is left out, with a plain reason, when:
  - the old version's stored copy is gone;
  - either side's text is over 2 MB;
  - the file is binary;
  - the changed part is too long to compare line by line. Then it is shown whole as removed and added, and the result
    says the counts mean nothing.
- **Left out:** restoring an old version stays on the Files screen. The AI explains it but does not do it. There is no
  download of an old version's bytes and no comparison between two old versions (only an old version against now).
- **Tests:** `tests/unit/c-ai-file-versions.test.ts`:
  - the editor's name and the changed line;
  - a chosen version;
  - a file with no earlier version;
  - a hidden file gives the same answer as a missing file and as a plain read;
  - another person's personal folder (member, admin, owner);
  - a Word file's text changes;
  - a file moved out of a narrower folder (its old place joins the read scope; a member who cannot read that place sees
    only later versions);
  - a version whose folder is in the trash;
  - a binary file, a file too large to compare, and a version whose stored copy is gone;
  - a change too long to compare line by line.

  For a real-AI check, there is the flow FL-28 in `tests/ai-scenarios/flows.yaml`. `files.versions` is now `acts`
  with `read` in `tests/ai-scenarios/feature-scope.ts`.
- **Version impact:** no migration and no API change. The read tool's input has two more optional fields.
