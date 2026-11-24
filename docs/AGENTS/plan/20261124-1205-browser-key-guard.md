# The desktop browser stops at a key screen, and key-like text never reaches the AI

- Date (UTC): 2026-11-24 12:05
- Branch: `feat/browser-key-guard`
- Status: done
- Where: shared/src (key finder next to secrets.ts), server/src/realtime and server/src/chat (browser tools, prompt,
  i18n). Why: the browser results reach the model and the records through the server, so the server is the one place
  that can hide a key for every desktop app version (see docs/REPOSITORY-RULES.md)
- Version impact: minor, new visible behaviour: on a page that shows a key the AI hands over and screenshots of it are
  refused; no API, setting or data format changes

## Goal

Founder decision 2026-11-24: in the desktop app the AI may take the person to a service's sign-up or API key page, but
when the screen shows a key the AI stops reading the screen and hands over ("여기서부터는 직접 해 주세요"). On top of
that, key-like strings are hidden on the server, so a key never reaches the model or any record.

Today only auth values in URLs are hidden (desktop `redactUrl`, only on the site card). A key the page shows comes back
in read_page / get_page_text / find / a script's output, goes into the model input, the engine's session file and the
answer the AI writes; a screenshot shows it as pixels.

## Scope

In:
1. A key finder for page text (`shared/src/page-keys.ts`), built on `secrets.ts` (`findLikelySecrets`, `looksRandom`,
   `secretValue`): provider prefixes (the ones secrets.ts knows plus more: Google OAuth, SendGrid, Shopify, Toss, xAI,
   Perplexity, Replicate, Figma, Supabase, DigitalOcean, Postman, Sentry, Grafana, Atlassian, Doppler, PyPI, Slack
   app tokens, Telegram and Discord bot tokens, Stripe webhook secrets, Mapbox), labelled values, a generated-looking
   value shortly after a key word (API key, secret, token, 인증키, 비밀키, 시크릿, REST API 키 …), secret query values
   in addresses, and reveal phrases ("you won't be able to see it again", "다시 볼 수 없어요").
2. Server masking: every text of a browser result and its error go through it before the model, tool_events, logs and
   the step record see them. A hit (outside an address) or a reveal phrase makes the page a key screen: then
   random-looking runs are hidden too, pictures in that result are dropped, and the result tells the AI to stop and
   hand over with a sentence in the chat's language.
3. Screenshots and scripts: before a call that takes a picture or runs a script (computer screenshot / zoom,
   javascript_tool, a batch holding one) the server reads the tab (read_page) and refuses on a key screen; after a
   batch or a script that brought back a picture or script output it reads the tab again and drops them on a key
   screen.
4. Prompt: one short line in the desktop browser rules; one clause in CONNECT_RULE for the web and the phone.
5. Tests: canary keys of several shapes on a fake key page never reach the model input, tool_events, the audit log,
   the server log, the stored messages or any file under the data and team folders; screenshots refused there;
   false-positive cases (normal pages, Korean text, UUIDs, hashes, docs placeholders, token counts).
6. Decision file, changes note.

Out: the desktop app's own handling (it still renders the key for the person, which is the point); a refusal of a key
the AI types from the chat (the step record already keeps typed text as a length); masking images by OCR.

## Steps

1. `shared/src/page-keys.ts` + unit tests (shapes, false positives, size).
2. `server/src/realtime/browser-keys.ts`: mask a result, decide the key screen, which calls need a page check, the
   notes for the AI.
3. Wire it into `browserTool` (server/src/chat/tools.ts): pre-check, mask, post-check, summary.
4. i18n `browserKeyHandOver` (six languages), prompt lines.
5. Canary test through the harness with a fake desktop window; false-positive tests.
6. Docs: decision file, changes note, plan result.

## Decisions

`docs/decisions/20261124-browser-key-guard.md`: the threat and the two layers (the AI stops; the server hides).

## Risks

- False positives make a page a key screen (screenshots refused). Kept narrow: only strong shapes, a key word right
  before a generated value, or a reveal phrase; addresses never make a key screen.
- One more read_page round trip before each screenshot (and after a batch / script). A failed check lets the call go
  ahead (the call fails the same way, or the page has no readable text, such as a PDF).
- No migration. Five app languages + Chinese for the hand-over sentence. Desktop app unchanged.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, unit tests
`tests/unit/page-keys.test.ts`, `tests/unit/b-browser-key-guard.test.ts`, `tests/unit/b-browser.test.ts`,
the secrets and prompt tests.

## Result

Built as planned:

- `shared/src/page-keys.ts` (`scanPageText`, `findPageKeys`, `keyish`, `revealsKey`) on top of `secrets.ts`, with 27
  more provider prefixes, values after key words (English, Korean, Japanese, Chinese, Spanish, Indonesian; at most four
  page words between, and not after "commit", "SHA", "ID" and the like), secret query values, reveal sentences in six
  languages. Leading look-behinds are checked by hand (they made each pattern scan every position: 2.6 s → 1 s on 2 MB).
- `server/src/chat/browser-keys.ts` (`guardedBrowserCall`, `maskBrowserResult`, `pageCheckOf`, `readForKeys`,
  `keyScreenNote`, `guardSummary`), used by `browserTool` in `server/src/chat/tools.ts`.
- i18n `browserKeyHandOver` in six languages; one line in BROWSER_RULES, one clause in CONNECT_RULE.
- Docs: decision file, `changes/browser-key-guard.md`, a paragraph in security-and-permissions (en, ko, zh).

Differs from the plan: the canary test showed that `find` lists a field without its label, so a key screen now also
hides every generated-looking value and every UUID, labelled or not (not only random-looking runs).
