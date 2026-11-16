# The recipient's AI reads a file shared with them

- Date: 2026-11-16
- Status: accepted
- Supersedes: the archive's "A member shares their own files" (#979) on one point: "Search, the AI's file tools and
  the file list stay on RuleSet and never see a file through a grant", and its P2 item "the recipient's AI reading a
  shared file". Everything else there stands.
- Branch: fix/shared-files-for-the-ai (the owner: "everyday sharing must just work"; QA TC-3807, TC-3808)

- **Ask:** the AI flow check of 2026-11-16 (tests/ai-scenarios, branch test/ai-scenarios) broke twice the same way.
  FL-02: sora shared `groups/영업/거래처-목록.csv` with hana (not in 영업); hana's AI retried the path, was refused, and
  told her it was still closed. FL-13: sora shared two notes in her own folder with the Sales group; daniel's AI searched
  the Sales folder and the rooms and said there was nothing. The share itself worked: the link opened for them on the
  Files screen.
- **Why it broke:** by #979's design, a grant was read only by the link endpoints (`/api/files/shared/:id`). The AI's
  read tools checked the folder rules alone, so a shared file was refused by its path, and nothing told the AI that
  files shared with the person exist or where. Not the file list and not search: no index was involved.
- **Rule:**
  - **read opens a file shared with the person**, view only, named by its team path or by its link (`/f/<id>`, also
    with the team's address in front, `files/shares.ts linkIdOf`). The grant is checked as the link page checks it
    (`FileShares.open`: live, the same file as when shared, the owner still edits it, never a guest), at the read and
    again right before delivery (`recheckSource`). Only files the folder rules do not already let them read take this
    path. A read by the link names the file by the link in its result, not by its path (the link page shows no path
    either). Write, edit, moves and every other tool stay on the folder rules: nothing about changing the file widens.
  - **"Files shared with you"** (prompt.ts `sharedWithMeSection`): each turn of the person's own chat lists the files
    shared with them by a grant (their own or a group's) that open for them now and that the folder rules do not show,
    newest first, at most 20, each with its name, who shared it, the day and its link, and says that list, glob and grep
    do not show them. In the fresh instructions and in the per-message turn context (a resumed session gets it too).
    File and person names are quoted, on one line, with our block tags neutralized.
  - **Only in a turn of the person's own chat** (`TurnFiles.grantReads`, set by chat/turn.ts): a personal chat or a ✦
    side chat. Never in a shared chat (its other viewers would read the answer; the section is in neither its prompt
    allowlist, `SHARED_PROMPT_SECTIONS.sharedWithMe = false`, nor its read gate), for a guest, in a restricted run or a
    confidential chat, and never for a call without a chat turn (the remote connector): the folder rules alone decide
    there, as before.
- **What a grant read counts as:** the file's real path joins the turn's read scope (`readPaths`), so saving or posting
  what came from it asks like any content fewer people can see (the folder rules see only its owner). The answer's
  "참고한 파일" list re-checks each file against the viewer's folder rules, so a file read through a grant is counted
  there without its name (unchanged, on the safe side).
- **Not changed:** grep and glob do not search inside shared files (the block lists them by name; the AI reads them).
  No "Shared with me" screen (still P2 of #979). The link page, requests, notices and the Share dialog are as they were.
- **Left out:** sub-agents do not get the block (the main AI passes them the link when needed; read opens it there
  too, the flag is the turn's).
- Tests: `tests/unit/c-shared-files-ai.test.ts` (refused before the share, read after it by path and by link, nobody
  else, not without the flag, view only, access taken away, a file replaced on disk, a group's grant, the block's list
  and wording, linkIdOf); `tests/unit/b-shared-chats.test.ts` (a shared chat leaves the block out).
- Version impact: **minor** (the AI can read more for the person it answers; no endpoint, no migration).
