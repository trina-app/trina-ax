# The person's own MCP apps can use their linked browser profiles (mcp:browser)

- Date: 2026-11-28
- Status: accepted
- Supersedes: none (extends "who drives" of [20261128-trina-in-chrome](20261128-trina-in-chrome.md) and the session of
  [20261120-mcp-connector-session](20261120-mcp-connector-session.md))
- Branch: feat/mcp-browser-tools (plan [20261128-0920-mcp-browser-tools](../AGENTS/plan/20261128-0920-mcp-browser-tools.md),
  two review rounds, security and product)

- **Ask:** Claude Code, Codex and Claude already use Trina through Trina AX MCP. Let them drive the person's own linked
  Chrome, Edge and Brave profiles too, with a profile per call, parallel sessions and the same approvals.
- **Rule, the scope:** `mcp:browser` ("Use my browser profiles"), its own box on the sign-in page, unticked at first
  (the strongest box there); never for a guest; a connection made before it never gains it (reconnect). Only the token
  owner's own profiles: another person's profile names and ids answer "No browser profile named …".
- **Rule, the tools:** the in-app browser tools with their names (`shared/src/browser-tools.ts`), each with `profile`,
  and `list_browser_profiles`. Not offered over MCP: `javascript_tool` and `read_network_requests` (a script or a
  response body can read a site's storage and non-HttpOnly cookies for whoever holds the token, and the server cannot
  tell an app nobody watches, as for scheduled runs), and `preview_start` (the desktop pane's). A batch may hold only the
  listed tools, never file_upload.
- **Rule, profiles:** the in-app rule (`server/src/chrome/profiles.ts`): the named profile, else the session's last,
  else the one whose sites hold the address, else the only open one; a closed named profile is refused, never swapped.
- **Rule, runs:** each MCP session is its own run (its window and tab group in the profile), titled with the app's
  cleaned name. This keeps well-behaved sessions apart; it is not a security boundary inside one connection (a client may
  send any session id of its own). One connection holds at most 3 of a profile's 4 runs; a person has at most 8 browser
  calls running and 120 a minute.
- **Rule, approvals:** the profile's own site list is the limit (one Always per profile and site, the site card's;
  "Only these sites"; the team's Always switch; the extension's hard blocks). Without a conversation the in-app address
  check keeps its address part: an address that is not plain (a query over 200 characters, random-looking parts, a long
  name before the site, a user name) is shown to the person in full, even on an allowed site. A site nobody allowed, such
  an address or an office address waits for the person on one Trina page (`/browser-ask/<id>`, their own signed-in
  page only). The app reaches it by URL elicitation when it declared it (the client's answer only says it showed the
  link), else by the notice in the person's open Trina windows and the link in the tool's answer. Form elicitation is
  not used: a token holder could answer it itself. A once covers the host of a plain address, or only the exact address
  otherwise, for that connection for 10 minutes. Asks: one per connection and host, 5 open and 30 an hour per
  connection and per person.
- **Rule, Stop:** Stop in the extension (or closing the task's window or the debugging bar) pauses the whole
  connection's browser calls for 30 minutes or until Resume in Settings › Trina AX MCP (migration 135, it survives a
  restart). Other apps and Trina's own chats go on.
- **Rule, what comes back:** text and screenshots; the team's vision switch applies (off: a note instead of the
  picture). What the browser showed joins the session's read scope as the person's own, so saving or sending it where
  more people see it is refused. One audit row per call with the tool, profile and host (never the path, query, page
  text or what was typed).
- **Why not form elicitation, or approval in the app:** the approval must come from a place the token does not
  control; Trina's page is that place.
- **Why not scripts:** the owner's floor is Claude Code, but scripts in a signed-in browser for a remote token are a
  wider door than the in-app AI's (whose turns the server sees); left for later, with its own decision.
- **Residual risk:** a stolen token with `mcp:browser` reads and acts on the sites the person's profiles already allow,
  until Disconnect or 90 days unused. It cannot add a site, run a script or read cookies.
- **Left out:** scripts and network bodies over MCP, a phone driving Chrome, Firefox and Safari.
- **Tests:** `tests/unit/remote-mcp-browser.test.ts`, `tests/security/remote-mcp-browser.test.ts`, web
  `browser-ask` and consent tests.
- **Version impact:** minor (new tools, a scope, a page, a migration).
