# Fewer needless asks, batch 5

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "then share it with the room's other people" step of
  [20261117-room-notes-not-company-wide.md](20261117-room-notes-not-company-wide.md); the "Not here" line on write,
  edit and make_file of [20261122-late-card-answer-resumes.md](20261122-late-card-answer-resumes.md); amends
  [20261117-own-folder-chat-made-no-card.md](20261117-own-folder-chat-made-no-card.md) (a file the chat handed over from
  its work folder counts as the chat's own)
- Branch: fix/fewer-asks-b5 (QA of batch 4, dev 02ea01f89 / #414; stacked on #419)

Plan: docs/AGENTS/plan/20261122-2301-fewer-asks-b5.md.

- **Ask (the owner, angry about needless cards; Rule A):** four cards from the batch 4 QA should not have asked.
- **A side chat never shares on its own.** In a ✦ side chat the person said only "방문-메모.txt 만들어줘" and got a card to
  share the file with the room's 4 people. The side-chat prompt told the AI to share every saved file with the room.
  Now: save in the person's own folder; share it only when they ask to share or send it; never offer to. A backstop in
  the tools: in a side chat, share_with_person, share_folder (adding) and post_to_room are refused before any card when
  neither the asker's own message nor their message before it in the chat has any word about sharing, sending,
  showing, posting, replying or linking (six languages, `talksOfSharing`, far wider than the explicit-ask word lists:
  it fails open). Not for a scheduled run or Slack, and not when the person's own "Always allow" for that kind is on
  (Rule A: no guard on top of it; the gate only stops a card nobody asked for).
- **The chat's own file in the person's folder asks nothing.** A copy_files of only this chat's places (chat:work/…,
  chat:files/…) into a team folder weighs the files it lands as (the names copyOne gives them, `landingPaths`), not
  the folder: a new name asks nothing, as any save. A landing name that is there and is the chat's own file
  (`chatOwnsFile`), and any save over such a file, counts as the chat's. `chatOwnsFile` is the old chatMadeOwnFile
  check (unchanged bytes, the answers that wrote it ran while the chat was shared as now, none a k or x answer), and
  takes a file the chat handed over from its work folder too, with later hand-overs of its own over it (so the Share
  dialog's "Share with files" offers such a file too). A file over 8 MB (no hash kept), and one with a mixed history
  (written, then handed over, or the reverse), still asks.
- **File cards wait across turns.** write, edit and make_file join the tools whose cards wait after the answer ends
  (their checks and cards all come before any write; mcp/protocol.ts runs write and edit through `fileCallLater`).
  Only where a late run works: write and make_file for a NEW file (a whole-file replace in the next turn has no read
  of the file it replaces before the engine resumes), edit always. Never a file of an edit_files batch, a sub-agent's
  call, a scheduled run or Slack, nor a call whose arguments and card are over 1 MB (kept inside the call as before).
- **A running answer counts its sources as the saved answer will.** A post or share check of the running answer reads
  its files from the turn's live source list (`liveSources`, the list the end of the turn saves), not "a turn that
  never ended: every scope place counts". The live card and the card of a late press then read the same sources line.
  Reads the AI makes after the card, before its answer ends, can still change it (it is told to end its answer).
- **Tests:** tests/unit/b-fewer-asks-b5.test.ts, places-copy.test.ts ("the chat's own work file into my own folder").
- **Version impact:** patch.
