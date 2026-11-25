# Upload destination: close the gaps that leave a person asking "where do I put this?"

- Date (UTC): 2026-11-25 12:03
- Branch: `feat/upload-destination`
- Status: **draft for review** (not built; replaces Part 2 of 20261125-1044-folder-restrict-honest.md)
- Where: web/ (Files root list, the Upload button at the root, FolderPicker rows, the upload line), server/ (one
  optional field on the folder listing), shared/ (the top places' words). Why: the screens are web; who can see a
  folder is the server's answer (see docs/REPOSITORY-RULES.md)
- Version impact: minor (new words on the Files root, in pickers and after an upload; no breaking API change)

## Goal

Owner, 11-25: "파일을 올릴때 쫌 막막해 이걸 어디에 올려야하는거지?" Start from what exists and change only what leaves a
person stuck.

## What already exists (kept as is)

- **Uploads go to the folder on screen** (button, drag-and-drop, drop on a folder row "Upload here", phone ⊕).
- **The folder header chip says who sees the folder on screen** where you can write ("팀 전체가 봐요", "5명",
  "팀장과 관리자만", "나만 봐요"), so an upload inside Files already has a who-sees line in view.
- **Move/copy/restore warn when more people will see it** (`files.widenTitle` "Show it to more people?",
  `files.widenBodyAny`, `files.narrowTitle`, Undo after a narrowing move).
- **The room "Save to team folder" sheet** suggests a folder and says "{n} people outside this conversation can see
  this folder"; the AI's `save_wider` card asks before saving where more people can see.
- **Trina places files by place words** (`chat/explicit-place.ts`, `place-words.ts`), defaults to the person's own
  folder, and says where it saved.
- **Chat attachments** in your own chat are yours only (the box says "새 채팅은 나만 볼 수 있어요"); shared chats say who
  sees an upload.

## The gaps, checked on screen (local test server, owner and member, 1440 and 390, 11-25)

| Gap | Real? | What the screen shows |
|---|---|---|
| (b) The top places don't say what each is for or who sees it | **Yes** | Files root and the phone's Files tab list "전사 공유, 팀 스킬, 개인, docs, …" with names only. Nothing says 전사 공유 is everyone's and 내 파일 is mine. This is where the question starts. |
| (c) An upload with no folder has no clear default | **Yes, at the Files root only** | A member's Upload is greyed at the team root (the root has no rule by default, so members cannot write there) and nothing says where to go. Home, chat and the desktop app have no team-folder upload (the chat + attaches to that chat, which already says who sees it; the desktop app is the web page), so they are not gaps. |
| (a) At upload or pick time nothing says who will see the file | **Partly** | Inside Files, the header chip already says it. Not covered: the **folder picker** (move, "Save to team folder" from an artifact, schedules) lists folder names only, and the warning comes only after "Move here". The upload line says "3 files uploaded" without the place. |

## What others do (verified 11-25: Drive live; Slack, Notion, Dropbox from their help pages)

1. **Context-first** (Slack: a file belongs to the conversation; Notion: a subpage "will take on the permissions of its
   parent page"; Drive: upload into the folder on screen). **We have it.** Keep.
2. **Top level split by audience** (Notion Private "only visible to you" / Teamspaces / Shared; Drive My Drive vs
   Shared drives, "all members of a shared drive see all of the files"). **We have the split** (전사 공유 / 부서 /
   프로젝트 / 내 파일) **but don't say it**: gap (b). Adopt: say it.
3. **Warn on a different audience** (Drive: documented only for moving *out of* a shared folder and big moves into a
   shared drive; nothing on upload; Notion documents the risk, no dialog). **We have it for moves.** Adopt only the
   cheap part: the who-sees words on picker rows, before the click.
4. **Search over filing** (Drive: filter chips, "text within the file", OCR of PDFs and images). **We have search and
   the file lists the AI reads.** Keep; it is not the fix for deciding where.
5. **AI filing** (Gemini "Suggest file moves": on request, "will not move any files without your permission"; Dropbox
   automated folders are fixed rules; Notion AI and Slack AI do not place uploads). **No product files a new upload by
   itself.** Not in this change (decision 2).

## The smallest change (three pieces, one shared helper)

One helper makes the same short words everywhere: **"what it is for · who sees it"**. The purpose comes from one table
of the top places, moved out of the AI's instructions (`folderPurposeLines`) into `shared/src/folder-labels.ts`, so
the AI and the screen say the same thing. Who sees it uses the Files chip's words. No new description field.

**1. Files root: a second line on each top place (gap b)**

```
1440                                                         390 (Files tab)
파일                                                         팀 폴더
📁 전사 공유   팀 모두가 쓰는 자료 · 팀원 모두 12명           📁 전사 공유
📁 부서        부서별 폴더 · 그 부서 사람만                      팀 모두가 쓰는 자료 · 12명
📁 프로젝트    프로젝트별 폴더 · 프로젝트 사람만               📁 내 파일
📁 팀 스킬     팀 규칙과 스킬 · 팀원 모두 봐요                   나만 봐요
📁 내 파일     나만 봐요                                      …
```

Root list rows only; the sidebar stays as it is (lean). Other folders made at the root get their who-sees words, with
no purpose.

**2. Upload at the root asks where, with the default picked (gap c)**

Where Upload is greyed today (the root, a read-only folder), it opens the folder picker titled "어디에 올릴까요?" with
**decision 1's default** selected, then uploads there. No new dialog type: the existing FolderPicker.

**3. Picker rows and the upload line say who sees it (gap a)**

```
FolderPicker, 1440                                    390 (bottom sheet)
 📁 전사 공유      팀원 모두 12명이 봐요                📁 전사 공유
 📁 Finance        팀장과 관리자만 봐요                    팀원 모두 12명이 봐요
 📁 내 파일        나만 봐요                            📁 Finance
                                                         팀장과 관리자만 봐요
upload line, after:  "영업에 3개 올렸어요 · 5명이 봐요 · 옮기기"
```

Writable rows only (read-only rows keep the lock and no count). "옮기기" opens the same picker; the move keeps its
existing warning and Undo.

## What gets removed or kept small

- Removed: the bare "{n} files uploaded" line becomes the one place line. The greyed, unexplained Upload at the root
  goes.
- Not added: no "where?" dialog before an upload inside a folder (one extra click on every upload; nobody else has
  one); no avatars; no folder descriptions; no new page; no AI.
- Kept: the move/copy warnings, the room save sheet, the AI's card, the header chip, search.

## Roles

- Owner and admins: the words everywhere they can write, including "팀장과 관리자만".
- Members: the words only on folders they can write (every upload destination), the same rule the chip follows today.
- Guests: their own folder and their project's folder only. "나만 봐요" or "프로젝트 사람 N명"; never the team's size
  ("팀원 모두 N명"), never names or a member list.

## Performance

- The picker and the root list already call `API.tree`; the listing adds an optional `audience` field to writable
  folder entries. No new request, no N+1.
- Counted per class of people (same role and groups, as `classesAt` does), cached by the rules hash and the member
  list's version. A timing test with 1,000 people and 200 folders on a page.

## Owner decisions (2)

1. **Default place for an upload started where you cannot write** (the Files root, a read-only folder).
   **Recommended: 내 파일 (나만 봐요)**, with "옮기기" right after. It matches Trina's own rule (new files go to the
   person's folder unless a place is named), and a file never reaches more people by accident. The other choice is
   전사 공유: everyone sees the file at once and it is easier to find, but it is riskier.
2. **Trina suggests a folder from the file's content.** **Recommended: not now.** If wanted later, make it a button
   after an upload that only suggests and moves on a yes, like Gemini's "Suggest file moves". Each ask is one model
   call: the file name, its first page and the candidate folders' file-list lines, about 2–4k tokens and 2–5 s, on the
   team's own AI connection. It reads the file before the person confirms the place, and teams with no AI connected
   get nothing.

## Risks

- "팀원 모두 N명" must never reach a guest (test).
- Subfolders have no purpose line; only the top places do.
- Six locales; ko in 해요체.

## Tests (when built)

Server: the listing's `audience` per role (admin; member write vs read; guest: no team size, no names) and per state;
the 1,000-person timing test. Web: root lines, the root Upload picker with the default, picker rows, and the upload line
at 1440/390 light/dark. e2e: a member uploads from the root (default chosen), moves with "옮기기" (warning and Undo
kept), and a guest uploads.

## Result

(at the end)
