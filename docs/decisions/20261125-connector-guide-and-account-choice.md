# A connected service's own guide reaches the AI, and the AI picks the account before it acts

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: fix/aside-profile-choice (owner's chat 2026-11-25; QA TC-9020..9023)

- **Ask:** the owner asked the AI to answer a mail in one of their mailboxes. With Aside the AI first sent the account
  words as free text to Aside's agent (it failed: "sign in again"), then opened the browser in Aside's default profile
  (another account), found nothing and stopped. It listed the 14 profiles only when the owner asked. Claude Code with
  Aside's own skill (`aside guide`) picks the right profile at once.
- **Rule 1, the service's guide:** an MCP server's `instructions` (its `initialize` answer) are kept with the
  connection (`integrations.instructions`, migration 366), cut to 6,000 characters with the connection's secrets
  hidden, refreshed by every check and by a call that starts a new session. The AI gets them in "Connected services"
  under "How to use these services", one `<service_guide>` block per connection it can use in this answer (16,000
  characters in all; a guide past that is named, not shown), as Claude Code gives its model "MCP Server Instructions":
  how to use that service's tools, never above the person's request, the rules or the cards. A resumed session keeps
  its first instructions, so every message's context names the services that have a guide, and `service_guide`
  (reads only, calls no service) gives one again.
- **Rule 2, a listed app's own guide:** a listed app on the computer whose program gives no instructions but prints a
  guide of its own (preset `guide`; Aside: `aside guide`, what Claude Code's Aside skill reads) gets that text as its
  instructions from the desktop app, read once per process, after one line that maps its command-line words to its
  tools (`aside exec` is exec, `--profile` is profile_id). Only for the exact listed command.
- **Rule 3, the account first:** when the request names or implies one of the person's accounts (a company, a mailbox
  or address, a workspace, a person) and a connection works in several accounts or profiles, the AI lists them with
  that connection's own tool, takes the match (also across scripts: a Korean name and its Latin spelling), passes it in
  the tool's own account or profile argument (never only as words in a free-text task, never the default), looks in
  the other fitting ones before saying something is not there, never sends or changes anything in one that does not
  match, asks with the short list only when none fits, and remembers the match. General words only: no service or
  phrase is named.
- **Rule 4, Aside's agent signed out:** Aside's `exec` needs the Aside account of its profile signed in. When Aside
  answers "Sign in again before using built-in Aside models", the AI is told that nothing ran and that `repl` works in
  the same profile; `browser_profiles` says per profile whether its account is signed in (`accountSignedIn`; with one
  account only when it is not). `repl`/`exec` `profile_id` say how to choose it.
- **Why:** Claude Code is the floor. The model saw the profile argument but had no rule for choosing it and none of
  the app's own guidance, and every MCP server's instructions were dropped.
- **Left out:** listing profiles before every answer (a desktop round trip each time; the rule makes the AI list them
  when the request needs it); moving exec to another signed-in account by itself (that account's profiles are other
  people's sites).
- **Version impact:** minor (a new saved field and new AI behaviour for every MCP connection; additive migration).
