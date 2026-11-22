# Each person sorts their own Trina history into sections, as the Chats sidebar and Claude Code's session sidebar

- Date: 2026-11-22
- Status: accepted
- Supersedes: [Projects: a place of their own; the Trina list is pinned and recent](../DECISIONS.md#projects-a-place-of-their-own-the-trina-list-is-pinned-and-recent-featnav-projects-tab-2026-11-13-product-owner) ("The Trina list's own folders leave the screen"), and [20261121-personal-sidebar-sections](20261121-personal-sidebar-sections.md) "Left out"
- Branch: feat/history-sections (the owner, 2026-11-22)

Plan: docs/AGENTS/plan/20261122-0926-history-sections.md (plan review: approve with changes, 14 items).

- **Ask (owner, 2026-11-22):** with a screenshot of Claude Code desktop's session sidebar (user-made sections on top,
  each folding and holding the sessions put there; then the date groups; one menu with Group by, Sort by, New section,
  Reset to defaults): "우리도 이런거 도입해야할듯?".
- **What it replaces:**
  - 2026-11-13: "**The Trina list's own folders leave the screen** (the owner: personal projects take that role). The
    server tables and endpoints stay for a release so a revert loses nothing; a chat once filed in one is in 최근 기록
    like any other; the row menu has no 폴더로 옮기기."
  - 2026-11-21 (personal sidebar sections), "Left out: … The Trina AI-chat folders, which are unchanged."
  - Both kept folders apart from the history; now the history has the same sections as Chats, under the same name.
- **Rule:**
  - Everyone, guests too, sorts their own Trina history into **sections** ("섹션"). Under the hood they are the
    person's list folders of kind `chats` (migration 289), the same model as the Chats sidebar's sections (kind
    `rooms`). Nobody else, owners and admins included, sees them. Folders a person made before 2026-11-13 come back as
    sections with what is still in them.
  - **A section and a project differ:** a section is only my way to sort my own list (only I see it, it changes nobody's
    access); a project is a shared place with its own files, instructions and people.
  - **Where:** between 고정 and 트리나 기록 on the computer's Trina panel; on top of the filtered list; in the phone's ☰
    drawer as headers of their own above the "트리나 기록" fold. A chat shows in one place: pinned › its section › 트리나
    기록 (with Group by Project the sections are not drawn: the projects stand alone). A filter applies inside sections,
    Sort by orders them, and an empty section is not drawn while a filter is on.
  - **Create:** New section in the history's filter menu (then Add chats), and New section… in every Move to section.
  - **Fill:** Move to section / Remove from section in a chat's "⋯" (the row, the phone's long-press sheet), drag onto a
    section (out: onto 트리나 기록), or Add chats (after New section, from an empty section's line, from its "⋯"). Every
    move says where it went in a toast with Undo. Move to project of a chat in a section keeps it in its section.
  - **Who can go in (owner, 2026-11-22: "allow all chats visible in my history"):** every chat my Trina history shows:
    my own chats (project and team-project chats too), a shared project chat I wrote in, a chat shared with me by name,
    through a group or a project. The server checks it by the history list's own rule
    (`server/src/chat/history-list.ts`, the same for `GET /api/chats`, the history's groups and the sections), and a
    section shows and counts a chat only while it passes that rule: one I lose (taken out of its project or group,
    unshared, hidden from my list) drops out by itself and comes back with access, while the section has room: a full
    section drops those rows before it refuses, and taking a chat out of a section works even after I lost it. A chat the history does not show
    (a project's shared chat I never wrote in, one I hid) is refused (409 `folder_not_in_history`). Moving a chat into or
    out of a project keeps it in its section; the trash takes it out (restored, it is in no section). My section is
    mine alone: nobody else's copy of a chat carries it. A room's side chat and a task's folded runs have no section
    items.
  - **Folded:** remembered on every device (the account's folds); a folded section shows its strongest session marker
    and keeps the chat on screen drawn.
  - **More:** a section shows the server's first rows and "더 보기" pages through `GET /api/chats?folderId=`; 트리나 기록's
    "더 보기" reads on (up to five pages) while chats in sections leave a page short, so no server option is needed.
  - **Words:** the Chats sections' words; the few that name what goes in say "chats" (`sidebarSections.chats.*`). The
    server's "folder" refusals are said again in section words. The old Trina folder words and parts (folderKindName,
    FolderMenu, useFolderRowItems, NewFolderRow, "대화 폴더는 트리나 폴더와 따로 있어요") are gone.
- **Why:** the owner wants Claude Code's session sidebar; the Chats sections already work per person, so one concept
  and one name serve both lists.
- **Left out:** Group by Status and Environment, View all, emoji, sort per section, sections shared with the team.
- **Tests:** web/test/unit/history-sections.test.tsx, web/test/unit/sidebar-sections.test.tsx, web/test/unit/nav-folders.test.tsx,
  web/test/e2e/history-sections.spec.ts, web/test/e2e/sidebar-sections.spec.ts (unchanged), tests/unit/b-nav-folders.test.ts.
- **Version impact:** minor (a new feature in the Trina history; no API change).
