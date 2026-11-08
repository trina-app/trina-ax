# First run: one box that takes an invite link, a team link or a team address

- Date (UTC): 2026-11-08 09:30
- Branch: `feat/first-run-one-box`
- Status: done
- Where: trina-ax `shared/` (one parser), `desktop/`, `mobile/`, `web/`, `server/src/auth`, `relay` names. Why: getting
  into a team is core (the apps and the web app), nothing here is about plans or billing (see docs/REPOSITORY-RULES.md)
- Version impact: minor (new first-run screens in both apps, a new `/api/me` field, three reserved relay names)

## Goal

People get an invite link or a team link in KakaoTalk or Slack, and do not know their team's address. Today:

- the desktop app asks for "팀 주소" and keeps only the origin of what is pasted, so a pasted invite or team link loses
  its token (`desktop/src/common/address.ts`), and any text with a space is refused;
- the phone app refuses the team link `/join#t=`, has no bare names (`acme` becomes `https://acme` and fails with a
  certificate message), and "다른 팀에 연결" removes the phone from its team at once, with no way back;
- a relay 404 (unknown name) and 403 (suspended team) both read "팀 서버가 아니에요";
- nothing shows the address a person connected to, and Settings › 앱 shows it only inside the install pictures
  (`location.host`, which is the office-network address when the desktop app connects directly).

What changes: one box (screen ①) takes an invite link, a team link, a full address, a bare name or a whole pasted
message, and opens that link's page inside the app. Two small screens explain what to do without an address (②) or
without a team (③). The app itself draws the host it connected to. The phone never leaves its team before the new one
answered and the person said yes.

## Scope

In (phase 1, this branch; phase 2 = `trina-ax://` links, universal / app links and screen ④, is a separate branch):

1. **One parser**, `shared/src/team-link.ts` (pure, no imports). The phone app cannot import `shared/` (its own npm
   project, Metro), so `mobile/src/team-link.ts` is a byte-identical copy and one test table runs against both and checks
   the copies are equal. Inputs: `/invite/<t>`, `/join#t=<t>` (the fragment kept), a full https address, a bare name
   (`acme` → `https://acme.<teamDomain>`), and any text with spaces or line breaks (a whole KakaoTalk bubble): the first
   invite or team link in it, else the first `https://` address. Other paths are dropped (the origin opens). Errors and
   hints: Hangul or jamo typed (`ㅁ츼` is `acme` in 한글 mode), an email typed, a cut-off invite link. Safety rules kept:
   https only, plus http only to this machine on desktop; no user:password; hosts as ASCII (punycode). The name is
   checked only when the person presses the button, and only under the team domain (no other domains are tried).
2. **Relay answers**, in the same module: `x-relay-error: team_unknown` (404) → "'{name}' 팀을 찾지 못했어요. 철자를
   확인하거나 초대 링크를 붙여 넣어 주세요"; `team_suspended*` (403) → its own message; a rename (308) is followed only
   to another `<name>.<teamDomain>` with the same scheme and port (the relay's rename), and the new address is kept.
3. **Desktop**:
   - ① replaces "팀 주소를 입력하세요": "팀에 들어가요", "팀장에게 받은 초대 링크를 붙여 넣어 주세요. 팀 주소(예:
     acme)를 알면 주소만 넣어도 돼요.", one box, [들어가기], "주소를 모르겠어요 · 아직 팀이 없어요", the remembered
     teams, [돌아가기] while a team is open, the language. A kit build still fills in its address.
   - A pasted invite or team link opens that page in the app (`openTeam(id, entryPath)`); a team already in the list is
     opened on that page. The office-network address (direct.ts) still wins when it answers.
   - ② and ③ as views of the same screen; [팀 만들기 ↗] and [직접 설치 안내 ↗] open the system browser with fixed
     addresses chosen by the main process (never a URL from the screen).
   - The first connect to an address outside `*.trina.app` (and not this machine) asks once: "트리나가 운영하는 주소가
     아니에요. 회사에서 직접 설치한 서버인지 확인하세요." [연결] [취소], focus on [취소].
   - A host strip above the team page on the sign-in pages (`/login`, `/invite/…`, `/join`, `/setup`,
     `/reset-password/…`): the team address the app connected to, in punycode, and [다른 팀]. Drawn by the app, so a
     page cannot fake it, and it shows the team address even while the page comes over the office network.
   - The 팀 menu: "팀 추가…" and "팀 목록…" become one "팀 목록·추가…".
   - The welcome screen follows dark mode (its colours already had a dark set; the shots are taken in both).
4. **Phone**:
   - The same ①②③ (Korean and English, the phone's string rule), bare names (the team domain comes from the edition's
     `service.json` at build time), team links.
   - "다른 팀에 연결" also on `/join`, with the host line: the team address in punycode above it.
   - "다른 팀에 연결" and the failure screen's "팀 주소 바꾸기" open ① over the team, with [{old}(으)로 돌아가기]. The
     old team stays until the new address answered `/api/health` and the person confirmed: "{old}에서 나가고 {new}에
     연결할까요? 이제 {old} 알림은 이 휴대폰으로 오지 않아요." with the new host, the outside note when it applies,
     [바꾸기] [취소], focus on [취소]. Only [바꾸기] removes the phone from the old team. The same team again just opens
     the link's page.
   - The first connect to an address outside `*.trina.app` asks the same one-time question as the desktop app.
   - ③ on phones has no [팀 만들기]: App Review 3.1.1(a) bans calls to action for purchases outside the app (the signup
     leads to a paid plan after the trial), and Google Play's payments policy bans leading users to another payment
     method from the app, so Android gets the same rule. The Mac App Store build follows 3.1.1 too: no [팀 만들기]. The
     Microsoft Store allows a non-game app its own payment, so the Windows store build keeps it.
   - The docs link in store builds (iOS, Android, Mac App Store) goes to the repository's install guide on GitHub
     (`docs/INSTALL-LINUX.md`, English `docs/INSTALL-LINUX.en.md`): it has no signup or pricing link. The docs site's
     install page has the plans link, so it is used only outside the stores.
   - In the browser sheet, closing it returns to ③; ③ has [팀 주소 넣기] → ①.
5. **Web**:
   - A used or expired invite or team link leads with "이미 가입했다면 로그인하세요" and a real [로그인] button.
   - Both join forms end with "이미 가입했어요? 로그인".
   - Settings › 앱: "팀 주소 · 새 기기에서 앱을 열고 이 주소를 넣으세요 [복사]", from a new `/api/me` `team.address`
     (signed-in people only): the relay address when the team is on a relay, else the public address the server knows
     (`publicAddress`), else nothing (no row). Never the address the page was opened at, so the office-network address
     never shows. The install pictures use the same address (they used `location.host`).
   - No host line on the web login page: a fake server can draw any host there (the apps draw it instead).
6. **Relay**: reserve `acme`, `trina`, `trina-ax` (`shared/src/relay-protocol/names.ts`). The repository's tests and the
   demo company (`scripts/demo/acme`, `bun run demo:company`) register `acme` on a local dev relay: the dev runner now
   lets its dev relay register its own `--team` name (`RELAY_DEV_NAMES`), and the relay tests use `acme-co`. An existing
   team already called `acme` on a relay keeps working (routing reads the teams table, not reservations); it could not
   be renamed back to it.
7. **Docs**: the install page gets "Apps with your own server": a real certificate for the desktop app, a public-CA
   https certificate and no redirect on `/api/health` for the phone, push only with `MYCEL_PUSH_GATEWAY`.

Out: `trina-ax://` links, universal links / app links, screen ④ and "앱에서 열기" (phase 2); an email lookup (phase 3,
only if support needs it); several teams on the phone.

## Exit walk (every button and link on ①②③)

| Screen | Control | Where it goes | Way back |
|---|---|---|---|
| ① | [들어가기], address answers | the link's page in the app (`/invite/<t>`, `/join#t=…`), else the team's own start (`/login` or home) | desktop: the host strip's [다른 팀], 팀 › 팀 목록·추가…; phone: footer "다른 팀에 연결" |
| ① | [들어가기], address fails | stays on ① with the reason under the box, the text kept | edit and press again |
| ① | [들어가기], first time outside `*.trina.app` | the one-time question | [취소] → ① with the text kept |
| ① | 주소를 모르겠어요 | ② | [뒤로], Esc (desktop), Android back |
| ① | 아직 팀이 없어요 | ③ | [팀 주소 넣기], Esc (desktop), Android back |
| ① desktop, a team open | [돌아가기] | the open team, as it was | 팀 menu |
| ① desktop | a remembered team [열기] | that team | 팀 menu, host strip |
| ① desktop | [목록에서 지우기] | the remove question ([지우기] [취소]) | [취소] |
| ① desktop | 언어 | ① in that language | — |
| ① phone, adding while connected | [{old}(으)로 돌아가기] | the old team's page, untouched | footer "다른 팀에 연결" |
| ② | [뒤로] | ① with the text kept | — |
| ③ | [팀 만들기 ↗] (desktop outside the Mac App Store) | the system browser, the account site | switch back to the app: still on ③ |
| ③ | [직접 설치 안내 ↗] | desktop: the system browser; phone: the browser sheet | desktop: switch back (still ③); phone: close the sheet → ③ |
| ③ | [팀 주소 넣기] | ① with the text kept | — |
| phone switch question | [취소] (focus) | ① with the text kept, the old team still connected | — |
| phone switch question | [바꾸기] | leaves the old team, opens the new one | footer → ① → the old address |
| desktop host strip | [다른 팀] | ① with the list and [돌아가기] | [돌아가기] |
| used / expired link page | [로그인] | `/login` | back |
| join forms | 이미 가입했어요? 로그인 | `/login` | back |

## Steps

1. Plan (this file).
2. `shared/src/team-link.ts` + `mobile/src/team-link.ts` copy; the test table `tests/unit/team-link.test.ts`.
3. Desktop: address.ts on the parser, app-window (entry path, relay answers, outside question, host strip), welcome
   ①②③, menu, strings in five languages, tests.
4. Phone: App.tsx setup ①②③, the switch flow, footer host line, team.ts health answers and the rename, app.config
   team domain and docs link, strings, tests.
5. Web + server: `/api/me` `team.address`, Settings › 앱 row, install pictures, join pages, five locales, unit and e2e
   tests.
6. Relay names, dev runner, relay tests. Docs install page. DECISIONS, CHANGELOG.
7. Checks, Docker web unit run, web e2e, screenshots, the exit walk by hand in the built desktop app and the web phone
   layout, the iOS simulator.

## Risks

- **Phishing**: any https server can draw a sign-in page inside the apps, and a `.trina.app` name proves nothing
  (trial names are open). Mitigations: the app-drawn host line, the one-time outside question, the reserved example
  names. No name-lookup API, no team display name for anonymous visitors (`shared/src/api/auth.ts` SetupStatus).
- **Enumeration**: nothing beyond the relay's existing 404 / 503.
- **App Review / Play**: no signup link in store builds; the docs link has no pricing.
- **The phone's leaving flow** touches push removal: the old team is left only after [바꾸기].
- No migration. Five web languages, desktop five, phone two.

## Tests

`bun run typecheck`, `bun run typecheck:mobile`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` (the
`/api/me` field); unit: the parser table (both copies), desktop address / teams / welcome strings, mobile address /
team / strings, relay names and the relay tests; web unit tests in Docker (bun 1.3.12); the full web e2e with new specs
(join pages, Settings › 앱 row); the desktop e2e specs that add a team.

## Result

Built as planned, with the design review's must-changes folded in before the code (the plan above already has them)
and an independent code review's findings fixed after it:

- The desktop health check no longer lets the network stack follow redirects (`net.request` with `redirect: 'manual'`;
  Electron's `net.fetch` throws on 'manual'); one relay rename hop, asked in both apps before the new address is
  remembered; a trailing-dot Location is refused.
- Tokens are 43 characters, so a link cut part-way says so instead of opening the "invalid invite" page.
- The phone saves the new team before it leaves the old one (a refused save used to leave it in no team).
- Trailing punctuation is trimmed with a loop (the regex was quadratic on a long paste).

After the first PR review: the host line shows on every page until `/api/me` answers for a signed-in person (not only
the listed sign-in paths: a fake sign-in page can sit at `/`); text glued after a link, zero-width characters and
fullwidth input are handled, `/invite` and `/join` match in any case; the phone owes the old team's device a removal
if it stopped between saving the new team and leaving the old one.

Differences from the plan: no web login host line (the review: a fake server can draw any host; the apps draw it);
the outside question moved into phase 1; phones have no [팀 만들기] on Android either (Google Play's payments
policy), and neither has the Mac App Store build; [팀 만들기] opens `https://account.trina.app/` because the repository
does not know the signup page's path.

Walked by hand in the built desktop app against a local dev server and its relay with fake data (`demo`, plus a local
TLS proxy for an outside address and a stand-in for a relay rename), and on the iPhone simulator (Korean, light and
dark) with Maestro: every exit in the table above. PR: see the pull request for test counts and screenshots.
