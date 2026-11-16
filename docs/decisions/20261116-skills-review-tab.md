# Team skills › To review shows only what waits; the navigation counts it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (it changes how "팀 스킬 관리" and "MC" in docs/DECISIONS.md draw the review tab)
- Branch: fix/skills-review-tab (the owner)

Plan: docs/AGENTS/plan/20261116-0900-skills-review-tab.md.

- **Ask:** the owner looked at Team skills › To review: "the UI looks bad", and asked whether a waiting review shows a
  notification like chat does. The tab listed one suggestion registered weeks before under a person heading, its
  "Registered as …" line in the accent colour (it read as an error), and two grey sentences above it ("Who can edit",
  "Folders you manage: skills/, groups/…/skills/").
- **Rule: the tab is a to-do list.** To review lists suggestions with the status `pending` and share proposals, nothing
  else. With none: the plain empty state.
- **Rule: decided suggestions stay, folded.** Under the list, a "Reviewed" section (the shared `ListSection`, folded
  until opened, its count beside the label, the fold remembered) holds what was registered or turned down, with its
  badge, reviewer, note and the link to the registered file. Why not Recent changes: that tab is for the owner and
  admins only (a group's skill managers review too), and it records files, so a turn-down and its note are not in it.
  Why not a tab of its own: four tabs already fill a phone's width. No new request: the one review read (waiting ones
  first, 100 rows) is split by status in the page.
- **Rule: no settings sentences above the list.** "Folders you manage" is removed (the review dialog's folder field
  says where a skill goes); "Who can edit … Change" shows on the skills tab only. A folder is said in words: skills/
  is "Team skills", groups/<folder>/skills/ is the group's folder name, deeper folders follow after " › "
  (`skillFolderWords`). The registered file's path stays a path: it is a link to that file.
- **Rule: a person's heading only when it helps.** Several people, or several suggestions of one person. One row names
  its person in its own line.
- **Rule: the registered line is neutral.** Muted text with an underline. The accent colour of this edition is an
  orange-red; a success must not read as an error. Red stays on the "Turned down" badge.
- **Rule: the Team skills row counts what waits for me.** `pendingReview + sharesToReview` of GET /api/skills/overview,
  drawn with `CountPill`, the one pill the rooms' unread count and a folded room folder's pill use (they were two
  copies of the same classes). On the Trina panel and in the phone's drawer. Nothing at 0, nothing for a guest, nothing
  for a person who reviews nothing. Read when the row first shows (a row that shows again within a minute keeps its
  number) and on an event: `skillsChanged` (the server's `skill_*` notices, this window's own review), a file change
  under a skills folder (another reviewer registered one), a reload after a reconnect. No timer.
- **Left out:** a turn-down by another reviewer sends no event to my window, so my count follows on the next event or
  load (a server event for that is a separate change). The phone's ☰ dot (an AI chat wants me) does not light for
  reviews; the Inbox entry and the banner already tell a reviewer.
- **Tests:** web/test/unit/member-contribute.test.tsx ("Skills › 검토 shows only what waits"),
  web/test/e2e/skills-review-tab.spec.ts, team-skills.spec.ts.
- **Version impact:** patch. No API, data or migration change.
