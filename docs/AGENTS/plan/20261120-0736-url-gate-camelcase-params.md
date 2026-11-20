# Web address card: stop flagging camelCase words, let "always allow" cover long plain queries

- Date (UTC): 2026-11-20 07:36
- Branch: `fix/url-gate-camelcase-params`
- Status: done
- Where: server/src/tools/url-gate.ts (+ card and settings wording). Why: the address card's rules live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: public read-only addresses asked when the person's own "Allow all websites" or site allowance should have opened them; no API or data change

## Goal

The owner saw two cards ("확인해 주세요", only 열지 않기/열기) for two public Hacker News search API addresses
(hn.algolia.com/api/v1/search?…&attributesToRetrieve=…&attributesToHighlight=none, 169 and 208 characters).
Both highlighted `attributesToRetrieve` and `attributesToHighlight` as "알아보기 어려운 긴 글자". Two causes:

1. `opaqueParts` flags any 20+ letter run with both cases and entropy >= 3, so ordinary camelCase parameter names count
   as random-looking. A marked address is not "plain", so neither a site allowance (①b) nor "Allow all websites" (①d)
   covers it, and the card loses those answers.
2. A query over `MAX_UNCONFIRMED_QUERY` (200) always gets a card (③), even with Allow all websites on.

## Scope

In:
- `opaqueParts` skips letter-only runs that read as camelCase/PascalCase words (`camelWords`): pieces split at case
  changes are words (2+ letters; a two-letter one has a vowel) or capital acronyms (1-5 letters, at most 2), 3+ letters
  a piece on average, and the words are at least 30% vowels. Runs with digits, `+` or `%` keep the old rule. Measured:
  fewer than 1 in 100 random mixed-case letter runs of 20-40 letters pass; base64, base32, hex, JWT and keys stay marked.
- ③: in a turn the person watches, a plain address (no marks, no user name, not an echo) with a long query opens under
  ①b and ①d, and the long-query card offers "allow this site" and "Allow all websites". Unchanged: typed, allowed and
  learned addresses with a long query still ask; scheduled runs, drafts and other unattended runs never open one;
  echo, userinfo and long-subdomain checks; schedules.ts and onboarding/draft.ts keep their own long-query rules.
- Card and settings wording (6 languages) no longer says long queries always ask; docs/security-and-permissions(.ko).md.

Out: raising the 200 limit itself; the readable-words exfiltration channel that Allow all websites already accepts.

## Steps

1. `camelWords` in url-gate.ts, used by `opaqueParts` (shared by connection-urls, schedules, post-to-room,
   share-words, integrations/connections).
2. gateUrl: long-query branch for watched turns (①b, ①d), offerSite no longer excludes long queries.
3. Wording, docs, decision file, changes file.
4. Unit tests: the two owner URLs, camelCase names not flagged, tokens still flagged, gate outcomes.

## Decisions

docs/decisions/20261120-url-gate-camelcase-params.md. Changes the ③ part of
[web_fetch URL rules](../../DECISIONS.md) ("쿼리 200자 초과는 카드") and builds on
docs/decisions/20261116-always-allow-more-cards.md.

## Risks

Security: a long readable query can carry more readable text out under ①b/①d. Allow all websites already accepts any
number of plain addresses with readable words (its risk sentence says so), so a long one adds no new channel. Fewer
camelCase marks also means fewer echo windows in connection-urls; address-level echo marks are unchanged.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit and tests/security files for url-gate and its callers.

## Result

Built as planned. Finding: the owner's two addresses have queries of 173 and 132 characters (the 208 was the whole
address), so the camelCase marks alone made both cards; the long-query change covers the next, longer search.
Tests: tests/unit/url-gate-camelcase.test.ts (new); site-allow and web-allow-all updated (a long plain query is now
covered by the site allowance / Allow all websites in a watched turn, the Allow-all line lost "a lot of text at the
end"). 40 url-gate-related unit and security files: 746 pass, 0 fail.
