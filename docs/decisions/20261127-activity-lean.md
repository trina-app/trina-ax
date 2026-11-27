# 활동's panel: one filter line with "⋯", an Unreads switch, two-line rows, no gear

- Date: 2026-11-27
- Status: accepted
- Supersedes: the chip list and the "unread first, then 읽음" order of [Every notice is in one 활동](20261126-one-activity.md)
  (its one list stays)
- Branch: ui/activity-lean (the owner, 2026-11-27: "야 이거 너무 번잡하긴 하네. 이거 슬랙이랑 똑같이 갈려고 했는데..";
  plan [20261127-1338-activity-lean.md](../AGENTS/plan/20261127-1338-activity-lean.md), its recommendations approved)

- **Ask:** the computer's 활동 panel looked busy: six chips on two lines, a folding "읽음" section, a gear, and rows of
  three or four lines. Slack keeps one feed with most filters behind "Filters".
- **Rule:**
  - **One filter line that never wraps.** 전체 · 멘션 · 스레드 are chips; DM, "트리나가 한 일 / Done by {AI}" and (for the
    owner and admins, and a member while an ask of theirs is listed) 요청 are in a "⋯" chip's menu.
    - DM moved into "⋯", not removed: the owner's 2026-11-13 call ("Activity: the DMs tab is back") stands, and
      `?tab=dms` still picks it.
    - A filter picked from the menu shows as its own pressed chip before "⋯"; "⋯" stays "⋯".
    - A chip the line has no room for moves into "⋯" by itself (스레드 first, then 멘션; 전체 and the picked chip never
      move), measured on the line, so no language and no panel width wraps the line or pushes "⋯" out.
    - A dot on a chip, and on "⋯" and its menu item, marks something unread under it.
  - **안 읽음 / Unreads is a switch**, not a section: the list is newest first, read and unread together; the switch
    shows only unread rows. Off by default, remembered in this browser, and the same switch as the phone page's. Below a
    1052 px window it is its bell icon, the word its name and tooltip. With it on and nothing unread: "You're all caught
    up." and "Show all". Older pages load by themselves only while it is on.
  - **Rows are two lines.** A conversation: where (#room › 스레드, a group chat, a shared chat's title) and the time,
    then "who: message" cut to one line. A 1:1 DM says the person's name once, on the first line. An app notice: its
    words (up to two lines) and the time; the three chat notices (shared, lost, left) keep the chat's title as line 2.
  - **No gear in the panel.** Notification settings are in Settings › Notifications and in a quiet link in the empty
    area beside the list. The phone keeps its gear.
  - The phone is unchanged except for the remembered switch.
- **Why:** one line of filters and one way to hide read items read at a glance, as Slack's Activity does; rows of two
  lines fit about 30% more at 1440. Where-first keeps the place at 240 px, where "who · where" lost it.
- **Left out:** Slack's saved views and its "detailed/dense" setting (we have the dense one only); UX package D (one set
  of notification levels) is separate and not waited for.
- **Tests:** web unit `activity-panel-one.test.tsx`, `rail-panels-p3.test.ts`; e2e `activity-panel.spec.ts` (the line in
  ko, en, id, ja, es at 240 and 288 px, the bell below 1052, the switch remembered and shared with the phone, two-line
  rows), `activity-mark-all-read.spec.ts`, `file-share-links.spec.ts`.
- **Version impact:** minor (a visible change to a main navigation list; no API change).
