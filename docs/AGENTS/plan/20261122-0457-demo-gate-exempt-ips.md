# Demo gate: exempt addresses for the start limits; the refusal pages' buttons centred

- Date (UTC): 2026-11-22 04:57
- Branch: `fix/demo-gate-exempt-ips`
- Status: done
- Where: demo-gate only (config, state, pool, public, pages, README, example config, tests)
- Version impact: patch, a demo-gate setting with an empty default and a page layout fix

## Goal

1. The office shares one public address (the owner and the QA agents). After this change the gate's config can name
   addresses that skip the per-address start limits, without the config ever holding a raw address.
2. On the limit page at 1440 px the heading and text sit in a narrow balanced column while the two buttons fill a wider
   row that starts further left. After this change the buttons' row has the text column's width and is centred, as the
   landing page's Start button is.

## Scope

In:
- `limits.exemptIpHashes`: a list of the keyed hashes the gate already stores in `state.json` `starts`
  (HMAC-SHA256(stateDir/ip-key, address), first 32 hex characters), or a prefix of at least 8 hex characters. Default
  empty: nothing changes unless configured. Config validation refuses entries that are not hex or are shorter than 8.
- A start from a listed address skips the hourly and daily start limits. Its live copies at once are
  `limits.exemptLivePerIp` (default 6) instead of `livePerIp`.
- The daily token cap, the per-visitor (per-instance) cap, maxLive and Turnstile still apply.
- README: the settings and how to compute an address's hash from the gate's key.
- Pages: the buttons' row of the busy, limit and error pages gets a fixed column width, centred.

Out: the hosted demo's live config (the owner adds the hash); every other limit.

## Steps

1. config.ts: parse and validate `exemptIpHashes`, `exemptLivePerIp`.
2. state.ts: `hash(ip)` public; `isExempt(ip, list)`; `startRefusal` takes the list and returns null for a listed address.
3. pool.ts: `take` takes the live-per-address limit from the caller; public.ts passes `exemptLivePerIp` for a listed
   address.
4. pages.ts CSS: the text and the row share one column width.
5. Tests: unit (listed hash never refused for hour or day, an unlisted one still is, prefix match, config refuses bad
   entries), and a check of the limit, busy, ended and error pages at 1440 and 390 px.

## Decisions

none

## Risks

- A listed address that leaks lets anyone behind it start more copies; maxLive, the daily token cap and the per-visitor
  cap still bound the cost.
