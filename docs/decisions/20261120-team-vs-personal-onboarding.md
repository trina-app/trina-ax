# Onboarding is the team's setup: team connections and team picks, then each person's own settings

- Date: 2026-11-20
- Status: accepted
- Supersedes: [Onboarding's Tools step: Drive, Notion and the full list](../DECISIONS.md#onboardings-tools-step-drive-notion-and-the-full-list-fixhosted-drive-broker-default-2026-11-15-the-owner-q3); the end screen's first result in [W6 — Onboarding v6: steps, 회사 소개 without a deck, 도구 연결, 준비 끝](../DECISIONS.md#w6--onboarding-v6-steps-회사-소개-without-a-deck-도구-연결-준비-끝-featonb6-core-2026-11-08-product-owner)
- Branch: fix/welcome-tools-personal-wording (the owner, 2026-11-20)

- **Ask:** The owner found step 4/5 "도구 연결" confusing: each [연결] made the owner's own connection, so it was unclear
  whether the step set up the team or the owner. Every other welcome step is a team setting, so this one must be too.
  Each person's own setup (their tools, photo, apps) comes after, in their own settings.
- **Step 4 is "팀이 쓸 도구" ("Tools for your team").** One list, and each row has one of two controls:
  - **A team connection** ([팀으로 연결], "팀 전체가 이 연결을 같이 써요"), for a tool the team connects once. Notion's
    row makes one team-scope connection that everyone may use (`POST /api/admin/integrations`, access everyone),
    from the list: nothing to type. It then signs in at Notion for the team, in the window reserved during the
    click. Slack's row opens its own page in Admin › Connectors (the steps' way back goes with it). A Slack added
    before does not count as this step done.
  - **A team pick** ([팀 추천] switch), for a tool each person connects with their own account: Google Drive where this
    server has it, Gmail where it can be connected. It is saved at once in `TeamSettings.recommendedTools`. A failed
    save puts the switch back and says why on its row.
  - Then one quiet "다른 도구 보기" link to Settings › Connectors, the full list. There, a tool's page has the same
    switch for an owner or admin ("팀에 추천하기").
- **No personal sign-in in this step.** Nothing here makes the owner's own connection.
- **Team picks gate nothing.** Recommended tools come first in everyone's Settings › Connectors, marked "팀 추천", in
  the order they were picked. Nothing is hidden, and members can still connect anything. With nothing picked (the
  default, and every team from before) the list keeps its usual order.
- **API for the personal-settings work:** `shared/src/api/team-tools.ts`. It holds the `RecommendedTools` schema,
  `isRecommended`, `recommendedFirst` and `withRecommended`. Everyone reads the list from `GET /api/integrations`
  `recommendedTools`; owners and admins read and change it with `GET`/`PATCH /api/admin/settings`
  `recommendedTools`, which is audited as `settings.update`. Ids are `google-drive`, a Google app's id, a listed
  service's id or a listed app's id, checked for shape only, at most 50.
- **Never blocking, as before.** There is one primary ("다음: 팀원 초대") once something is done: a team connection
  connected, or a tool picked. Until then there is only "나중에 하기". A phone still walks past the step.
- **The end screen sums up the setup.** "카드뉴스 만들어 보기", "'{skill}' 먼저 써 보기" and the 회사 소개서 line are
  removed. One row per step (회사 소개, 스킬, 팀 파일, 팀 도구, 팀원 초대) shows:
  - for a step done, ✓ and a short fact: where the company intro was saved, the skills shared, the file and folder
    counts in the team's folder (not counting its notes and brand folders), the team connections and picks, and the
    invites made. A fact that cannot be read is left out, and the row shows without it.
  - for a step put off, "나중에 하기로 했어요" with [지금 하기] where the step can be done on this device.
  Then the line "다음은 내 설정이에요 · 내 도구 연결, 사진, 앱" and one primary: "내 설정 시작" (Home, where the
  personal-settings card is). While no AI answers, the primary is "AI 연결하기" and "홈으로" stays as a quiet link.
- **Words.** en.ts is the source; ko, ja, zh, es and id say the same. The step's old keys are deleted
  (`welcome.tools.driveLine`, `confirm`, `yes`, `other`, `connected`, `popupBlocked`, `driveUnavailable`,
  `driveNotConnected`), and so are the end screen's `welcome.done.deck`, `deckPhone`, `try`, `later` and `write`.
- **Left out:** the Home "내 도구 연결하기" card and the Home order (another change reads `recommendedTools`). Also
  left out: a team-pick switch in Admin › Connectors, and any change to the Google Drive consent and return pages
  (another change).
- Tests: tests/unit/c-recommended-tools.test.ts, web/test/unit/welcome.test.tsx (팀이 쓸 도구, 준비 끝),
  web/test/e2e/welcome-tools.spec.ts, welcome-skills.spec.ts, welcome-notes.spec.ts, phone-welcome-flow.cases.ts.
- Version impact: **minor** (a new team setting, a reworked step and end screen).
