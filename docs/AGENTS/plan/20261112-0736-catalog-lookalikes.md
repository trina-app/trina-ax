# Look-alike service names: capitals, more scripts, mixed alphabets, old reconnect names

- Date (UTC): 2026-11-12 07:36
- Branch: `fix/catalog-lookalikes`
- Status: done
- Where: Team AX core (`shared/src/service-catalog.ts`, `server/src/chat/connect-service.ts`,
  `web/src/lib/connectCard.ts`). Why: the chat's connect card is core (docs/REPOSITORY-RULES.md).
- Version impact: patch. A security hardening of #582; no API or data change.

## Goal

Follow-up to #582 ("The chat's connect card trusts the app's list"). Its review found that the look-alike check could
still be passed:

- `nameSkeleton` lowercased first, so a Greek capital Ν became ν and was read as "v", not "n". Other capitals were
  missing too.
- Some look-alike letters were not mapped: Armenian օ, dotless ı, small capitals (ᴛ, ɴ …) and Greek σ.
- A connection saved under a known name before #582 (say "Notion" at a made-up address) got a reconnect card titled
  "Sign in to Notion again".

## Scope

In:

- `nameSkeleton` maps look-alikes before and after lowercasing. The table gains the Greek capitals
  (Ν Μ Η Ζ Υ Κ Τ Ρ Β Ε Α Ο Ι Χ), Armenian օ, dotless ı, the small capitals and Greek σ.
- The robust rule: a name that mixes Latin letters with another alphabet (Cyrillic, Greek, Armenian, Cherokee) inside
  one word is titled by its host, never by a catalog name, at any address that is not exactly the official one. The
  server checks it, and the web card checks it again. `mixedScript(name)` is in the shared list module.
- A reconnect card uses the same rule as any other card. Its title is the connection's name, unless the name is (or
  looks like) a listed service's, or mixes alphabets, and the address is not the official one; then the title is the
  host. The server sends the card under that name, and the web card works it out again. The saved connection keeps
  its name.

Out: the full Unicode confusables table; renaming saved connections.

## Steps

1. `shared/src/service-catalog.ts`: the table, the two-pass `nameSkeleton`, `mixedScript`, `posesAsListed`.
2. `connect-service.ts`: the title rule for new and reconnect cards.
3. `web/src/lib/connectCard.ts cardTrust`: the same rule for unknown and reconnect cards.
4. Tests, DECISIONS and a changes fragment.

## Risks

- A real name that mixes alphabets in one word is titled by its host. Such names are rare; a name in one script
  ("노션", "Нотион") or words in separate scripts ("Acme 노션") are not affected.
- Five languages: no new text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/connect-service.test.ts` (Bun 1.3.12),
`web/test/unit/connectors.test.ts`, `web/test/unit/connect-card.test.tsx`.

## Result

Built as planned. The look-alike map runs before and after lower case. `mixedScript` and `posesAsListed` live in
`shared/src/service-catalog.ts`. The server uses them for new cards and reconnect cards, and the web card's `cardTrust`
uses them too. The new server tests fail on the handler and list from #582.
