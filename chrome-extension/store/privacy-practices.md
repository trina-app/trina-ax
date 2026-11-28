# Chrome Web Store › Privacy practices

Answers for the developer console's "Privacy practices" tab. Keep them true to the code (`chrome-extension/src/`);
change them in the same PR as a change of permissions or of what is sent.

## Single purpose

Let the user's own team AI (Trina AX) operate tabs of this browser when the user asks it to in their team's chat:
open pages, read them, click and type, and attach files the user chose in the chat, in a separate window per task that
the user can see and stop.

## Permission justifications

- **debugger:** The AI reads and operates the tabs of its own task windows through the Chrome DevTools Protocol: it
  reads the page's text and structure, takes screenshots, clicks and types, and blocks requests to the user's team
  address and (after the AI ran a script on a page) to sites the user has not allowed. It is attached only to tabs in
  the AI's own task windows while it works (Chrome shows its "started debugging this browser" bar), detached after a
  minute without work, and limited by a fixed list of protocol methods; it never reads cookies or site storage.
- **tabGroups:** Each task's tabs are put in a named tab group ("Trina AX · <task>") so the user sees which tabs the AI
  uses, and the AI only uses tabs in its own group (also tabs the user drags into it).
- **storage:** Keeps the link to the user's team (its address, the link token, the team and account names) in
  local extension storage, and the running tasks' window ids in session storage. Nothing is synced.
- **alarms:** Reconnects to the team within a minute after Chrome put the extension's service worker to sleep, and
  closes a task's window after ten minutes without work.
- **activeTab:** When the user clicks the extension's icon, the popup reads the address of the tab in front to offer
  "Connect to <that team address>". Nothing else of the tab is read.
- **nativeMessaging:** Only to link this browser profile through the user's own Trina AX desktop app on the same
  computer, when the user presses Connect for this profile in the app: the extension's pair page sends the app a
  one-time number the app put in that page's address and a hash of a secret only the extension keeps, and gets back a
  one-time code for the user's team. Nothing else goes over it; the browser calls themselves go to the team server.
  The desktop app's helper accepts this extension's id only (Chrome enforces the list).
- **Host permissions (optional, one origin):** Asked at Connect for the user's own team address only (the
  `optional_host_permissions` patterns let the user grant that one https address, or localhost for developers). Used
  to read the team's connect page address (for the one-time code), to talk to the team server (link, WebSocket, file
  downloads for file_upload), and nothing else. No other site's data is read through host permissions; pages the AI
  works on are reached through the debugger on the AI's own task tabs.
- **Remote code:** No. All code ships in the package. The extension evaluates JavaScript in a web page only when the
  user's AI calls its `javascript_tool` on a site the user allowed; that code is data the AI sends for that one page,
  it never runs in the extension's own context, and the user sees each call in the chat.

## Data usage (what the extension handles)

Check these types in the form:

- **Website content:** Yes. Text, structure and screenshots of pages in the AI's task tabs are sent to the user's own
  team server, only as the answer to the user's own AI request in their chat.
- **Web history:** Yes, limited: the addresses of the tabs the AI drives (its task windows) are sent with the AI's
  results. The user's other tabs and browsing history are never read.
- **User activity:** No (the extension does not monitor clicks, keys or scrolling of the user; it only sends the AI's
  own input events to its task tabs).
- **Personal communications:** No collection by the extension itself. If the user asks the AI to read a web mail page,
  that page's content is website content sent to the user's own team, as above.
- **Authentication information:** No. The extension never reads passwords, cookies or site storage, refuses to type
  into password and payment-card fields, and blocks sign-in and account-security pages. Its own link token is kept
  locally and sent only to the user's team.
- **Personally identifiable information:** Yes, limited: when the profile is linked through the desktop app, the
  name and the Google account email address the browser shows for this profile (read by the desktop app from the
  browser's own profile list) are sent to the user's own team server once, so the user and their AI can tell the
  profiles apart. The extension does not read the account itself.
- **Health, financial and payment information, location:** Not collected by the extension. (Banking, payment and
  crypto sites need the user's explicit permission per site.)

Where the data goes: only to the team server the user connected (their organization's own Trina AX address, hosted or
self-hosted). The extension sends nothing to the developer or to third parties itself. The team's server passes what
the AI needs for the user's request (for example a page's text or a screenshot) to the AI model provider the team
chose, which processes it only to produce the answer, as the privacy policy's "Trina AX in Chrome (browser extension)"
section says.

## Certifications (tick all three)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy

https://trina.app/privacy (what the developer console names; its section "Trina AX in Chrome (browser extension)", in
Korean and English, covers the extension).
