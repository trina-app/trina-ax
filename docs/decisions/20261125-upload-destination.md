# 파일 opens 내 파일, like Drive's My Drive: upload first, share later

- Date: 2026-11-25
- Status: accepted
- Supersedes: in [활동, 파일 and 대화 as lists beside the rail (P3)](../DECISIONS.md#활동-파일-and-대화-as-lists-beside-the-rail-featnav-rail-rest-2026-11-13-navigation-redesign-p3), "파일's start … is 최근 파일" and "Left out on purpose: an Upload button in 파일's header (… one button, not two)"; in [Phone tabs: 트리나 · 대화 · 파일 · 나 (P5)](../DECISIONS.md#phone-tabs-트리나--대화--파일--나-featnav-rail-p5-2026-11-13-navigation-redesign-p5), "No upload button on the places" (only for 최근 파일, below)
- Branch: feat/upload-destination (the owner, 2026-11-25; plan docs/AGENTS/plan/20261125-1203-upload-destination.md)

- **Ask:** "파일을 올릴때 쫌 막막해 이걸 어디에 올려야하는거지?", then the cause: "구글에서는 그냥 내 파일이 default니깐 일단
  여기에 올리고 보는데, 우리는 전사 공유가 눈에 보이니깐 아 어디 올려야하지..? 하는거 같아." 파일 opened on 최근 파일, which has
  no Upload, so every upload began with choosing a folder, and the first folder in sight was 전사 공유.
- **Rule:**
  - **파일 opens 내 파일** for the owner, admins and members (the owner's choice: one rule, like Drive). Guests have no
    파일 place (unchanged), so none of this reaches them. The
    rail's start for 파일 is the person's own folder (`railRoot`); a press on 파일 while it is lit goes there too. On a
    phone the 파일 tab stays the list of places (P5), with 내 파일 as its first row.
  - **The order of 파일's places:** 내 파일, 최근 파일, 나에게 공유된 파일, 팀 폴더, 프로젝트 폴더, 휴지통 (computer list and
    phone tab alike). The team's places stay one tap away, as Drive's Shared drives.
  - **최근 파일 gets the one Upload button of its screen.** It has no folder of its own, so its upload goes to 내 파일 with
    no question (the owner's choice) and opens 내 파일, which uploads the files there. This is not a second button next
    to a folder's own: 최근 파일 had none. On a phone it opens our device sheet (20261118-our-file-picker-everywhere.md).
    Files picked there that 내 파일 cannot take (it does not open, or another folder opens first) are dropped, with a
    line when it failed; they are never uploaded on a later visit. 나에게 공유된 파일 and the other places get no Upload (a folder's own toolbar
    and ⊕ upload into that folder, as before).
  - **One line after an upload into 내 파일**, while only the person can see it (not shared): "내 파일에 올렸어요 · 나만 봐요 ·
    팀과 같이 보려면 [옮기기]". 옮기기 opens the Files page's existing Move picker (one file) or its bulk Move (several), at the
    team folder's places and with the 1–3 추천 folders it already has; no new picker, no AI call. Moving to a folder more people can see asks first
    (`files.widenTitle`, `files.widenBody…`), as every move does; Undo stays where it was (after a narrowing move). The
    line (and its finished rows) stays until closed or 내 파일 is left; without the line (another folder, 내 파일 shared) the
    rows go after 4 s like any upload's. A guest who reaches their own folder would get the line without 옮기기.
  - **내 파일's empty state** says "여기 올린 파일은 나만 봐요. 팀과 같이 보려면 팀 폴더로 옮기세요." (a guest: the first
    sentence only).
  - Not changed: uploads inside a folder go to that folder; setup's 팀 파일 step still puts the company's files in 전사 공유
    (it names its place); Find work files; Trina saves new files in 내 파일 unless a place is named
    (20261117-ai-save-my-files-default.md).
- **Why:** Drive and Notion start you in your own space (My Drive; Notion's Private, "only visible to you") and make
  sharing a later step. A file in 내 파일 reaches nobody by accident, and the existing move warning says how many more
  people will see it when it moves.
- **Tests:** `web/test/unit/rail.test.ts`, `web/test/unit/files-panel-shared-highlight.test.tsx`,
  `web/test/e2e/files-start-in-my-files.spec.ts`, and the 파일 specs whose start changed (`rail.spec.ts`,
  `files-panel.spec.ts`, `phone-tabs-v2.spec.ts`, `desktop-list-cache.spec.ts`).
