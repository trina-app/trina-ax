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
  development), a member invite page and the team link page lead with **Open the app**, the same link as "앱에서 열기"
  (`<scheme>://open?url=<this page>`, web/src/lib/team-link.ts openInAppHref). The app's screen ④ asks first, as for
  every link. **Download the app** (the edition's listing for this system, else its download page) is the clear second
  choice, and Continue in the browser and Sign in are quiet links.
- **The page never says whether the app opened.** A browser does not tell, and blur or visibility are a coin flip: on
  Windows, Edge 158's "This site is trying to open …" prompt (default button Cancel) took focus before the person
  answered and read as "opened" in 3 of 4 runs, and without the app Edge's translate bubble did the same at 2.9 s. So no
  timer and no focus event decide what the page says: before a try it says what the page is for ("Join in the app. No
  app yet? Download it first."), after any try one neutral line ("If the app opened, you can close this tab. If not,
  download and install it, then press Open the app.").
- **One try by itself, once, when seen:** one try per page load, never a loop, and only once the tab is visible (a link
  cmd-clicked from a mail tries when its tab is first shown). Where a browser blocks it, nothing happens and the
  person presses Open the app: Chrome 158 on Windows blocks a try no press started ("a user gesture is required"),
  which is harmless. Edge shows its prompt. Firefox gets the try through a hidden frame (kept up to 60 s or until the
  page goes away), because its top-level try of a link no app answers replaces the page with an error page.
  **Safari** gets no try by itself: on a Mac, a top-level try without the app keeps the page but covers it with a modal
  "Safari cannot open the page because the address is invalid". There the press of Open the app is the try.
- **Page language:** left as is. The first HTML says `lang="en"` and the app sets the person's language once it runs;
  the team's language is known only after an API call, so putting it in the first HTML needs the server to rewrite the
  page per team. With no focus-based guessing left, Edge's translate bubble no longer changes anything here.
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
