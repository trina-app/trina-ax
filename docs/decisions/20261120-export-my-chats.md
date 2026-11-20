# Every member exports their own chats from Settings › Export; the owner's full export stays as it is

- Date: 2026-11-20
- Status: accepted
- Supersedes: none
- Branch: ap038-export-my-chats (QA AP-038, AI parity 2026-11-19)
- Keeps: the redaction rule of [No stored key in the answer](../DECISIONS.md#no-stored-key-in-the-answer-int-13-b-w5-4-b-w5-1-2026-10-29)
  ("the chat file names and headings of the settings export", QA SEC-16)

- **Ask:** the AI parity QA (Trina vs claude.ai) found that claude.ai lets every user export their data. In Trina only
  the owner has an export (Admin › System, chats + memories + files as `.tar.zst`). A member had no way to take a copy
  of their own chats.
- **Rule:**
  - Settings › Export (group Account, after Memory) has one button, "Export my chats". `POST /api/me/export` starts a
    job; the server builds a ZIP; the person downloads it with `GET /api/me/export/:jobId/download`.
  - **Only the person's own chats:** the chats the owner's export takes for the owner (`system/export.ts ownChats`, now
    one function for both exports): `chats.user_id` is the person, not deleted, a shared project chat only while they
    still see its project, an answer withheld from them as one line with no text. Never a chat of somebody else, also
    not one shared with them (people or project), and the owner gets no more here than a member.
  - **The ZIP:** `chats/<date> <title>.md` and `chats/<date> <title>.json` for each chat (the visible branch of an
    edited chat). Names are made safe with the team export's `safeSegment` and two equal names get " (2)". The Markdown
    starts with the chat's address on the team; the JSON has the id, title, address, times, engine and the messages.
  - **Attachments are links, not copies:** a file kept with a shared chat links to `/api/chats/:id/files/:fileId`; an
    upload or a team file links to `/api/files/download?path=…` only while the person can read it now (the Files tree's
    check). A team file they lost access to shows "(a file you can no longer open)": no name, no path. Links are full
    addresses (the team's address of the request), because a relative link does not work from an unzipped file. Each
    link checks access again when it is opened.
  - **Secrets:** a stored connection secret in a title is hidden in the file names, the headings and the JSON `title`
    (the same redactor as the owner's export).
  - **Where the file is:** `<data>/my-exports/<person>/<job>.zip`, mode 600, outside the team folder. So the AI, the
    Files tree, storage use, backups and the team export never see it. Only its maker downloads it (anyone else gets
    the 404 of a missing job); `Cache-Control: private, no-store`. It is kept 24 hours (an hourly sweep deletes it,
    and an older file is not given out); the person's next export deletes the earlier one.
  - **Load:** one export at a time per person (409 `busy` while theirs is queued or running). The job kind is
    `export`, so all exports (the owner's and every member's) run one at a time on the server. It does not take the
    lock of the owner's tools: a member's export never blocks a backup, a restore or an update.
  - **Audit:** a row `export.mine` with the number of chats and the size (never titles) when the ZIP is ready.
  - **Guests:** no. The endpoints are not in the guest list (`auth/guest-endpoints.ts`, deny by default) and the
    section is hidden for guests, as Memory is.
- **Why:**
  - Markdown, not `.txt` as in the team export ([20261120-team-export-zip.md](20261120-team-export-zip.md)): the
    brief asked for Markdown, the owner's export already uses `.md`, and the JSON file is there for other apps.
  - A job and a file, not a ZIP streamed in the request: a long history through the relay would hit request time
    limits, and the job shows progress.
  - No new job kind: `jobs.kind` has a CHECK constraint, so a new kind would need a migration that rebuilds the table.
- **Left out:** memories and files (Files has its own download), the phone app's screen, a mail when the export is
  ready.
- **Tests:** `tests/unit/g-my-export.test.ts` (own chats only; not a chat shared with the person, not the owner's, not
  a deleted one; download only for the maker; one at a time; 24 hours and the sweep; attachment links; withheld
  answers; hidden secrets), `web/test/unit/my-export.test.tsx`.
- **Version impact:** minor (a new feature, nothing removed).
