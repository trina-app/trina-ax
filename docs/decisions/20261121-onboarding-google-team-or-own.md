# Onboarding's Google rows offer both: connect for the team, or ask everyone to connect their own

- Date: 2026-11-21
- Status: accepted
- Supersedes: the Google rows and the "팀 추천" name in [Onboarding is the team's setup](20261120-team-vs-personal-onboarding.md) (the rest of it stands)
- Branch: fix/onboarding-google-team-or-own (the owner, 2026-11-21)

- **Ask:** In "팀이 쓸 도구" Notion and Slack had [팀으로 연결], but Google Drive and Gmail only a "팀 추천" switch. The
  owner: a Google account was meant to be added both as a team account and as a personal one, and "팀 추천" does not
  say what it does.
- **Rule:** Google Drive's and Gmail's rows have both (only where the server can connect them). Google Calendar, Docs
  and Sheets stay out of the step to keep it lean (four rows): "다른 도구 보기" and Admin › Connected apps have them. [팀으로 연결] on the right opens the same dialog Admin ›
  Connected apps uses for a shared Google account (DriveShares.tsx `DriveShareDialog`, GoogleAppTeam.tsx
  `GoogleAppTeamDialog`); it is offered only where the server can do that (Drive set up; the app set up and the server
  sends its `team`). Once connected the row says "공유 계정 <email> · <who uses it>" and 연결됨, and it counts as the step
  done. Under the row's line the per-person switch, now "각자 연결하도록 권하기" ("Ask everyone to connect their own");
  the row's line is one short line for both ways: "공유 계정 하나, 또는 각자 자기 계정" ("One shared account, or each
  person their own"). The dialog keeps whether it opened for a new account while it is open, so Cancel after the
  sign-in removes the account made there, as in Admin. The member's list marks those tools "팀이 연결을 권해요" ("Team asks you to
  connect"), and a tool's page switch has the same name as the step's. No new connection logic or API.
- **Notion gets the switch too.** A person may connect their own Notion, so Notion is no longer a team-only tool
  (`TEAM_CONNECT_TOOLS` is Slack alone, which has no own connection): its row has [팀으로 연결] and the switch.
- **A shared Drive counts on My setup.** "Connect your tools" (MyToolsRow.tsx) shows Google Drive as the team's when an
  admin shares a Drive with the person (`DriveConnection.teamShares`), as it already did for a Google app's shared account.
- **The admin page is named as it is labelled:** "Admin › Connected apps" (`admin.integrations`), not "Admin › Connectors".
- **Why:** both ways already existed on dev (Admin › Connected apps); the step hid one of them. One name for one setting.
