# Phone screens: the offline page in the phone's language; no "drag files here" on a phone

- Date (UTC): 2026-11-11 16:45
- Branch: `fix/phone-offline-words`
- Status: in progress
- Where: web app (`web/src/i18n/recovery-locale.ts`, `web/scripts/product-pages.ts`, `web/src/pages/Files.tsx`, the five locale files). Why: wording on the web screens every client shows (see docs/REPOSITORY-RULES.md)
- Version impact: patch, wording and language choice only

## Goal

QA TC-207 (TC sheet TC-133, TC-118):
1. A Korean phone that opened the team once but never signed in shows the offline page in English ("Can't reach the
   team server"): with no language stored on the device the page falls back to English and ignores the browser's.
2. An empty folder on a phone says "파일을 끌어다 놓으세요" (drop files here), but a phone cannot drag files.

## Scope

In: `recoveryLocale` takes the device's languages as a last choice before English (stored choices still win); the
offline page passes `navigator.languages`. On a touch phone an empty folder you can write to says "아직 파일이 없어요.
올리기를 눌러 넣어 보세요" (new key `files.emptyTap`, five locales).
Out: the error screen inside the app (`store/session.ts`) keeps its current rule; other drag hints.

## Steps

1. `recoveryLocale(recent, signIn, browser?)`; the embedded offline script reads `navigator.languages` safely.
2. `Files.tsx`: `touchPhone` picks `files.emptyTap`.
3. Tests: `web/test/unit/offline-worker.test.ts` gets a case with the device's languages; check:i18n.
4. `changes/phone-offline-words.md`.

## Risks

None for data or permissions. The offline page stays self-contained (no imports); a blocked `navigator` falls back as
before.

## Tests

`bun test web/test/unit/offline-worker.test.ts`, `bun run --cwd web typecheck`, `bun run check:i18n`, `bun run check:docs`.

## Result

Filled in at the end.
