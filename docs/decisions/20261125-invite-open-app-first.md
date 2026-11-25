# An invite or team link opened in a computer's browser opens the desktop app first

- Date: 2026-11-25
- Status: accepted
- Supersedes: none. Builds on docs/DECISIONS.md "First run, phase 2: a tapped link opens the app, behind screen ④";
  on computers its "앱에서 열기" line under the form becomes this page.
- Branch: feat/invite-open-app-first (the owner, 2026-11-25)
- Plan: [docs/AGENTS/plan/20261125-0815-invite-open-app-first.md](../AGENTS/plan/20261125-0815-invite-open-app-first.md)

- **Ask:** "앱으로 우선 열도록하는게 나을 것 같은데.. 없으면 다운받게 하거나. 정 안되면 브라우저.." A member invite link or a
  team link opened on a Mac, Windows or Linux computer showed the browser form with a small "앱에서 열기" under it.
- **Rule:** like Zoom and Slack. In a computer's web browser, on a team the desktop app opens (https, or this machine for
  development), a member invite page and the team link page try the desktop app once on load with the same link as
  "앱에서 열기" (`<scheme>://open?url=<this page>`, web/src/lib/team-link.ts openInAppHref). The app's screen ④ asks
  first, as for every link. The page says the app is opening and offers three things: Open the app (tries again, only
  on a press), Download the app (the edition's listing for this system, else its download page) and a quiet Continue in
  the browser.
- **Did it open:** a browser does not say. After a try, a blur or the page turning hidden within about 2 s counts as
  opened ("You can close this tab"); otherwise Download the app becomes the one primary button. Only events that happen
  after the try count, never a state read later: a tab opened in the background starts hidden, and that is no sign. A
  later sign still counts (Chrome's own "Open …?" prompt can take longer). All three actions stay whatever the guess.
- **Once, when seen:** one automatic try per page load, never a loop, and only once the tab is visible (a link
  cmd-clicked from a mail tries when its tab is first shown).
- **By browser** (checked in real Chrome and Safari on a Mac, 2026-11-25): Chrome and Edge navigate the page to the link;
  without an app nothing shows and the page stays. Firefox gets the try through a hidden frame (kept up to 60 s or until
  the page goes away), because its top-level try of a link no app answers replaces the page with an error page.
  **Safari** keeps the page but covers it with a modal "Safari cannot open the page because the address is invalid", so
  Safari gets no automatic try: the page says "Join in the app" and leads with Open the app, whose press is the try, and
  no blur counts as opened there (Safari's "Allow this page to open …?" sheet may take focus before the person answers).
- **Already a member:** the quiet "Already joined? Sign in" line stays on the page; it does not remember the browser.
- **Browser remembered:** Continue in the browser is kept in this browser (localStorage `mycel.joinInBrowser`); later
  invites there go straight to the form. Back from Google (`?google=`) also goes to the form: the person chose the
  browser already.
- **Guests:** a guest invite (someone from outside the team, usually joining once for one room or project) keeps the
  browser first, as before. The one special case.
- **Phones and our apps:** unchanged (a phone copies the link and goes to the store; inside our apps the page is the app).
- **Privacy:** the token reaches the app exactly as before (the existing link; the team link's token from this tab's
  memory). Nothing new is logged, sent or stored about the person; no clipboard, no fingerprinting. The only thing kept
  is the browser choice, a flag with nothing of the link in it.
- Left out: a server check of whether the app opened (none exists, and Zoom-style guessing is enough with all three
  actions on the page); deferring the try while the tab is in the background.
- Tests: web/test/unit/join-open-app.test.ts.
- Version impact: minor (a new default flow on the join pages; no API or data change).
