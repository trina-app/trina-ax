# The web tools, the browser and the dev shell never carry a stored key out

- Date (UTC): 2026-11-15 19:02
- Branch: `fix/web-tools-hide-keys`
- Status: in progress
- Where: server/src/chat/tools.ts (the turn's `hideKeys` hook), server/src/integrations/connections/hide-args.ts.
  Why: the choke point of fix/connection-tools-hide-keys already sees every tool call first (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a security fix; no new feature, no API change)

## Goal

QA tracking TC-3097. A stored connection key that reached the AI could leave through the built-in tools that reach
outside hosts: web_fetch (a key in the address goes to any host), save_url, the browser tools (an address, typed text,
a form value, a script) and the dev shell (box_shell). The connected-service tools already hide or refuse it (#981).
For the person: such a call is not sent, and the AI tells them so ("Nothing was sent: …").

## Scope

In:
- `refuseKeysInArgs` (hide-args.ts): every string and field name of the arguments, as written, with its whitespace
  taken out, and %-decoded; any stored key form refuses the call (KeyRefusal, "Nothing was sent: …"). An address with
  [hidden key] in it is useless, so nothing is sent hidden.
- chat/tools.ts hideKeys: web_fetch, save_url (`url`), the browser pane tools (every value, also inside browser_batch),
  intro_deck's `urls`, and box_shell (`command`, `request_sites`). Checked with `completeRedactorFor`: fails closed.
- save_url's other field (`save_as`) keeps being hidden as before.
- box_shell: any command that holds a stored key is refused, not only curl/wget: every program in the box (node -e,
  python -c, git) can reach the network, so a list of tool names would be easy to get around; write already saves
  [hidden key] instead of the key.
- The step line keeps showing the hidden form (chat/turn.ts redactStep, unchanged); no card is raised for a refused call.

Out (known limits, written in DECISIONS):
- A key the AI builds in pieces (string joins in a script or a shell command), or reads from a file inside the command
  (`curl -d @.env`): the box runs the person's own environment as it is (#971 security review).
- generate_video (already hidden, KEEP), promo_video (team files only), make_file/artifact (no outside fetch), plugins
  (no outbound calls on the server): listed as checked.

## Steps

1. `refuseKeysInArgs` + texts in hide-args.ts.
2. Wire it in chat/tools.ts hideKeys before the saving-tools branch.
3. Unit tests (pure function) and turn tests through the harness with a fake outside host (a local server as
   "public" via the fetch test options; a scripted desktop window for the browser; box_shell where the runner runs).
4. DECISIONS entry, changes/web-tools-hide-keys.md.

## Risks

- A legitimate address that happens to hold the key (none expected: a stored key is a secret).
- box_shell failing closed when a stored secret cannot be read: same rule as connection tools; rare (a damaged row).
- No migration, no UI words (the refusal goes to the AI, which tells the person).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/c-integrations-*, b-browser, save-url,
web-allow-all, dev-env-srt, b-chat.

## Result

(filled in at the end)
