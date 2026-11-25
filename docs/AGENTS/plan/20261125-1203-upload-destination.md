# Files starts in My files, like Google Drive: upload first, share later

- Date (UTC): 2026-11-25 12:03
- Branch: `feat/upload-destination`
- Status: **draft for review** (not built; replaces Part 2 of 20261125-1044-folder-restrict-honest.md)
- Where: web/ (the 파일 rail's landing, the Files side list and the phone 파일 tab order, an Upload button on 최근 파일,
  the upload line, My files' empty state). Why: navigation and Files are web (see docs/REPOSITORY-RULES.md). No server
  or API change.
- Version impact: minor (Files opens in a different place; no API change)

## Goal

Owner, 11-25: "파일을 올릴때 쫌 막막해 이걸 어디에 올려야하는거지?", then the cause: "구글에서는 그냥 내 파일이 default니깐 일단
여기에 올리고 보는데, 우리는 전사 공유가 눈에 보이니깐 아 어디 올려야하지..? 하는거 같아." In Drive you land in My Drive and
upload without deciding anything; sharing is a later step. In Trina the first places you see are team places, so every
upload starts with a choice. Make My files the place you start and upload, and make sharing the later step (move the
file to a team folder, or share it), which the existing move warnings already cover.

## Where it is today (read from the code, seen on screen)

- **The 파일 rail opens 최근 파일** (`RAIL_ROOT.files = '/files?view=recent'`, navigation P3, 2026-11-13). 최근 파일 has
  **no Upload button**. To upload you must first pick a place.
- **The side list (desktop) and the phone 파일 tab** show: 최근 파일, 나에게 공유된 파일, **팀 폴더 (전사 공유 first, then
  부서, then the others)**, 프로젝트 폴더, and only then **내 파일**, then 휴지통 (`panels/FilesPanel.tsx`). The first
  folder the eye meets is 전사 공유.
- **Upload goes to the folder on screen** (button, drag-and-drop, phone ⊕), with no line about where it went.
- **Moves already warn** when more people will see a file (`files.widenTitle`, `files.widenBodyAny`, "{n}명이 더 보게
  돼요"), with Undo after a narrowing move. A file of mine can be shared with chosen people (Share).
- Not gaps (checked): Home and the chat box have no team-folder upload (the chat + attaches to that chat, and a new
  chat already says "나만 볼 수 있어요"); the desktop app is the web page; Trina saves new files in My files unless a place
  is named (docs/decisions/20261117-ai-save-my-files-default.md).

## What Drive does (seen 11-25)

Drive opens on Home/My Drive. New › File upload goes into the folder on screen, My Drive by default. Shared drives sit
lower in the side list. Sharing is a separate step (Share, or a move that changes who can see it). Pickers say where,
not who. Notion is the same: Private is "only visible to you", Teamspaces come after.

## The change (three small pieces)

1. **The 파일 rail opens 내 파일**, and 내 파일 moves to the top of the side list and the phone 파일 tab, right under the
   search. 최근 파일 and 나에게 공유된 파일 follow, then 팀 폴더 and 프로젝트 폴더, one tap away as now (Drive's Shared drives).
   The list itself, its rows and the phone screens keep their look; only the order and the landing change.
2. **An upload with no folder of its own goes to 내 파일.** That is the Upload button that 최근 파일 and 나에게 공유된 파일 get,
   and a drop on those lists. Inside a folder you can write, uploads still go to that folder. A read-only folder keeps
   its greyed Upload: you are clearly somewhere else.
3. **One line, so sharing reads as the next step.** After an upload to 내 파일, the upload line says "내 파일에 올렸어요 ·
   나만 봐요 · 팀과 보려면 옮기기". 옮기기 opens the existing picker, and the existing "{n}명이 더 보게 돼요" warning and Undo
   apply. 내 파일's empty state says: "나와 내 트리나는 어디에 두든 찾아요. 팀과 같이 볼 때 전사 공유로 옮기세요."

```
1440, now                                   1440, proposed
파일                                        파일
 🕘 최근 파일          ← lands here           👤 내 파일            ← lands here, [올리기]
 👥 나에게 공유된 파일                         🕘 최근 파일          [올리기 → 내 파일]
 팀 폴더                                      👥 나에게 공유된 파일
   📁 전사 공유                               팀 폴더
   📁 영업                                      📁 전사 공유
 프로젝트 폴더                                    📁 영업
 👤 내 파일                                   프로젝트 폴더
 🗑 휴지통                                     🗑 휴지통

upload line after:   ✓ 견적서.pdf  내 파일에 올렸어요 · 나만 봐요 · 팀과 보려면 [옮기기]

390 (파일 tab), now                          390, proposed
파일                     🔍                  파일                     🔍
 최근 파일                                    내 파일                 (opens it; ⊕ uploads there)
 나에게 공유된 파일                            최근 파일
 팀 폴더 ›                                    나에게 공유된 파일
   전사 공유 · 영업 · …                        팀 폴더 ›
 내 파일                                        전사 공유 · 영업 · …
 휴지통                                       휴지통
```

On the phone the tab keeps its list of places (Phone tabs decision); 내 파일 is the first row. The upload line on the
phone is the same one line, wrapped to two.

## What stays

- **Setup's 팀 파일 step** (the owner uploads the company's files and the AI proposes folders in 전사 공유): it names its
  place, so it does not change. The same goes for the member welcome card ("Ask Trina what you can do here", no files
  step) and **Find work files** (a member's files already go to 내 파일 › "From this computer", and the owner's in setup
  go to 전사 공유).
- **Trina's own saves:** 내 파일 unless named (20261117-ai-save-my-files-default.md). This change makes the screen match
  that rule.
- Folder headers, the Share dialog, the move/copy warnings, search, team places and their order among themselves.

## What gets removed or kept small

- Removed: 최근 파일 as the landing; an upload that needs a choice before it can start.
- Not added: no picker before an upload, no new page, no avatars, no AI placement, no folder descriptions.

## Roles

- Members and admins: as above.
- Guests: their 파일 already shows only their own folder and their one project. They land on 내 파일 too. No member lists,
  no team sizes; the upload line says "나만 봐요".

## Conflicts checked

- Navigation P3 (2026-11-13) made 최근 파일 the rail's landing. That part is superseded by a new decision file
  (`docs/decisions/<date>-files-start-in-my-files.md`).
- Phone tabs (트리나 · 대화 · 파일 · 나): kept; only the order inside 파일 changes.
- Files onboarding (setup proposes team folders; leads upload for everyone): kept, because setup names 전사 공유.
- AI default save place, Find work files, member welcome: already 내 파일 or not about files. No conflict.

## Performance

No new request: 내 파일's listing is the same `API.tree` call as any folder. One fewer screen before the first upload.

## Owner decisions (2)

1. **Owner and admins too, or members only?** **Recommended: everyone lands in 내 파일** (one rule, like Drive). Leads still
   put team files in 전사 공유 through setup's 팀 파일 step and by moving files, and the move says how many more people will
   see them. The other choice: owner and admins land in 전사 공유, so team files go there first, but then the screen
   differs by role.
2. **Upload on 최근 파일 and 나에게 공유된 파일: straight to 내 파일, or ask first?** **Recommended: straight to 내 파일**,
   with the one line after it. That is the Drive habit the owner described ("일단 여기에 올리고 보는"), and it saves a
   question on every upload. The other choice: open the folder picker with 내 파일 preselected (one more click, the
   place chosen up front).

## Risks

- Habit change for teams that used 최근 파일 as the start: it stays as the second row.
- "나와 내 트리나는 어디에 두든 찾아요" must stay true: Files search and your own Trina read 내 파일. Teammates' Trina does
  not (personal folders are private and not in the shared file list), which is why the line says "나와 내 트리나".
- Six locales; ko in 해요체.

## Tests (when built)

Web: the rail opens 내 파일 (member, admin, guest); the side list and phone tab order; Upload on 최근 파일 lands in
내 파일; the upload line and 옮기기 (the warning and Undo kept); the empty-state line. 1440/390, light and dark. e2e: a
member uploads from the first screen, then moves the file to 전사 공유 and sees "{n}명이 더 보게 돼요".

## Result

(at the end)
