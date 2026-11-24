# A failed built-in tool goes on with a connected tool that only reads, without asking

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: fix/connector-fallback-undo-particle (F1 measurement, 2026-11-24)

- **Ask:** `web_fetch` got a 403. The AI then asked "Bright Data로 시도해 볼까요?", and the person had to repeat the
  request three times. The same happens with any connector, not only that one.
- **Rule:** when one of the AI's own tools fails or brings back nothing usable (a page that will not open, a search with
  no usable result) and a connected tool does the same job and only reads, the AI uses it at once for the same request.
  It does not ask, offer it as a choice or wait for the person to repeat the request, and it says in one line which
  service it used. "Only reads" is the read tiers' mark ([20261118-shared-readonly-tools.md](20261118-shared-readonly-tools.md),
  [20261122-connector-always-allow.md](20261122-connector-always-allow.md)): a tool whose description does not say it
  changes something, which `find_tools` shows as "reads only".
- **Where:** one general line in "Connected services" (only when something is connected), in `web_fetch`'s
  description, and in a `web_fetch` failure where the site itself would not give the page (HTTP errors, no valid
  answer, a name that does not resolve). No service is named in code or prompt.
- **Shared chats:** the one-time connection notice ([20261123-shared-connector-warning-once.md](20261123-shared-connector-warning-once.md))
  is the only guard; no extra question.
- **Unchanged:** a tool that changes something still asks on its card; the read tiers themselves; a connected tool that
  itself fetched nothing is still not retried another way.
- **Version impact:** patch.
