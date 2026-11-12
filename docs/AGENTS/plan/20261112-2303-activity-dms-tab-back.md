# Activity: the DMs tab is back

- Date (UTC): 2026-11-12 23:03
- Branch: `feat/activity-dms-tab-back`
- Status: in progress
- Where: trina-ax `web/src/pages/Activity.tsx`, `shared/src/api/notifications.ts`. Why: Activity and the notices are
  core (see docs/REPOSITORY-RULES.md).
- Version impact: minor, a visible tab comes back and the "Mark all as read" API accepts `tab: 'dms'` again.

## Goal

#635 took the DMs tab out of Activity. The owner wants it back: All · DMs · Mentions · Threads.

## Scope

In: undo #635 on top of today's dev, keeping what came after it, mainly "Mark all as read" (#639/#656), which must work
on the DMs tab too. The tab's words in five languages (en first), its tests, the changelog fragment.
Out: any other change to Activity. The 멘션·스레드 page opened from a phone's 대화 tab keeps no DMs tab, as before #635.

## Steps

1. Shared `ActivityTab` and `activityTabHas` get `dms` back (a direct or group chat's conversation row), so the page's
   filter and the server's `POST /api/notifications/read` follow one rule.
2. `Activity.tsx`: the DMs tab with its phone short word, `CHATS_FILTERS` for the 대화 page; `?tab=dms` there opens All.
3. i18n `feed.tab.dms`, `feed.tab.dmsShort` in en, es, id, ja, ko (the words #635 removed).
4. Tests back to four tabs (activity-tabs, phone-menus-tabs, phone-chats-tab, inbox-rooms), plus Mark all as read on
   DMs (server unit, web unit, the e2e mock's tab rule).
5. `changes/activity-dms.md` replaced by `changes/activity-dms-tab-back.md`; a DECISIONS entry.

## Risks

No migration. Five languages. A phone at 390 must fit four tabs without scrolling sideways (the spec checks it).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web and notification unit tests, the e2e specs
activity-tabs, phone-menus-tabs, phone-chats-tab and activity-mark-all-read.

## Result

Filled in at the end.
