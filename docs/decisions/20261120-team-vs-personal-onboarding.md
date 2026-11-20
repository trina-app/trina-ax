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
    click. Slack's row shows 연결됨 only while Slack is connected (`state` connected). Added but not connected, it
    shows [다시 연결]; not added, [팀으로 연결]. Both open its own page in Admin › Connectors, and the steps' way back
    goes with them.
  - **A team pick** ([팀 추천] switch), for a tool each person connects with their own account: Google Drive where this
    server has it, Gmail where it can be connected. It is saved at once in `TeamSettings.recommendedTools`. A failed
    save puts the switch back and says why on its row.
  - Then one quiet "다른 도구 보기" link to Settings › Connectors, the full list. There, the page of a tool each
    person connects has the same switch for an owner or admin ("팀에 추천하기"). Notion and Slack never get it: they
    are team connections here.
  - The line under the title says where each is changed later: "팀 연결은 관리자 › 커넥터, 추천은 각 도구 페이지에서
    바꿀 수 있어요".
- **No personal sign-in in this step.** Nothing here makes the owner's own connection.
- **Team picks gate nothing.** Recommended tools come first in everyone's Settings › Connectors, marked "팀 추천", in
  the order they were picked. Nothing is hidden, and members can still connect anything. With nothing picked (the
  default, and every team from before) the list keeps its usual order.
- **API for the personal-settings work:** `shared/src/api/team-tools.ts`. It holds the `RecommendedTools` schema,
  `isRecommended`, `recommendedFirst` and `withRecommended`. Everyone reads the list from `GET /api/integrations`
  `recommendedTools`; owners and admins read and change it with `GET`/`PATCH /api/admin/settings`
  `recommendedTools`. The server stores the list clean (`cleanRecommended`): each id once, and only ids that can be
  recommended (`RECOMMENDABLE_TOOLS`: Google Drive, the Google apps, the listed services and the listed apps on a
  computer, without the team-connect tools). At most 50. A change is audited as `settings.update`; settings are now
  compared by value, so saving the same list again writes no audit entry.
- **Never blocking, as before.** There is one primary ("다음: 팀원 초대") once something is done: a team connection
  connected (Slack too, also one connected before the step), or a tool picked. Until then there is only "나중에 하기". A phone still walks past the step.
- **The end screen sums up the setup.** "카드뉴스 만들어 보기", "'{skill}' 먼저 써 보기" and the 회사 소개서 line are
  removed. One row per step (회사 소개, 스킬, 팀 파일, 팀 도구, 팀원 초대) shows:
  - for a step done (lib/welcome.ts `stepDone`), ✓ and a short fact:
    - where the company intro was saved, as the sidebar names it ("전사 공유 › 브랜드");
    - the skills shared;
    - the files in the team's home (`teamHome`: shared/ since "Team folder basics"), at every level, without its
      notes and brand folders, reading at most 25 folders;
    - the team connections that work (Slack too) and the picks;
    - "팀 링크를 만들었어요", with "{n}명 들어왔어요" once people came in with it.
    A fact that cannot be read whole is left out, never a count that could mislead, and the row shows without it.
  - for a step put off, "나중에 하기로 했어요" with [지금 하기]. A step this device does not do (a phone walks past
    팀이 쓸 도구) says "컴퓨터에서 할 수 있어요", with no button.
  Then the line "다음은 내 설정이에요 · 내 도구 연결, 사진, 앱" and one primary: "내 설정 시작" (Home, where the
  personal-settings card is). While no AI answers, the primary is "AI 연결하기" and "홈으로" stays as a quiet link.
- **Words.** en.ts is the source; ko, ja, zh, es and id say the same. The step's old keys are deleted
  (`welcome.tools.driveLine`, `confirm`, `yes`, `other`, `connected`, `popupBlocked`, `driveUnavailable`,
  `driveNotConnected`), and so are the end screen's `welcome.done.deck`, `deckPhone`, `try`, `later` and `write`.
- **Left out:** the Home "내 도구 연결하기" card and the Home order (another change reads `recommendedTools`). Also
  left out: a team-pick switch in Admin › Connectors, and any change to the Google Drive consent and return pages
  (another change).
- Tests: tests/unit/c-recommended-tools.test.ts (clean list, audit by value), web/test/unit/welcome.test.tsx (팀이 쓸 도구, 준비 끝),
  web/test/e2e/welcome-tools.spec.ts, welcome-skills.spec.ts, welcome-notes.spec.ts, phone-welcome-flow.cases.ts.
- Version impact: **minor** (a new team setting, a reworked step and end screen).
