# No Korean on screen for a person who chose another language

- Date (UTC): 2026-11-27 10:39
- Branch: `fix/id-korean-leaks`
- Status: done
- Where: web/src (session language), mobile/ (phone app's own screens), server/src (a few messages and names picked by
  the team's language), tests/unit (a guard). Why: the owner set the app to Bahasa Indonesia and still saw Korean on an
  iPhone ("한글이 나오는 곳이 너무 많아").
- Version impact: minor. Three new languages in the phone app and a new optional, versioned phone-app message
  (`language-v1`); the rest are fixes in the words shown. No API, data or migration change.

## Goal

A person who picks a language sees that language everywhere the app writes its own words: the sign-in screen after
signing out, the phone app's own screens, error messages and the names the app makes for them. Team content (folder
names, messages people wrote, the team's templates folder) stays as written.

## Audit (static and live, on a private local copy with test data)

- Static: a TypeScript-AST scan of web/src, desktop/src, mobile/, server/src, shared/src and relay/src for Hangul
  literals outside comments, the dictionaries and locale tables; plus a read of every place the server picks the team's
  language or a fixed `ko` instead of the person's.
- Live: a Korean team on this Mac, the owner on Bahasa Indonesia, every main screen at 390 (iPhone) and 1440, signed out
  and signed in, an invite page, the welcome steps and an AI chat written in Indonesian.

## Scope

In:
1. Web: the language a person picks in Settings becomes this browser's sign-in language too, so signing out or an
   expired session shows the sign-in screen (and its errors) in it, not the team's default. "Follow the team" clears it.
2. Phone app (iOS/Android shell): Indonesian, Japanese and Spanish for its own screens and the iOS permission texts; the
   app's own screens follow the language the page says (new optional message `language-v1`), else the phone's.
3. Server: messages chosen by the team's language or English for one person now use that person's language (room app
   address errors, project-room refusals, the guest one-place refusal, the after-update list and update progress for the
   admin watching, `?? 'ko'` fallbacks); the archive folder made in the owner's own folder in the owner's language; the
   chat "(continued)" suffix recognised in every language.
4. Setup: a first owner with no usable name is named "Admin" in the team's language (English "Admin" fallback), not
   "Owner"; the account CLI's language error lists all six languages.
5. Web: `errorText` treats older default wordings as defaults (shown in the person's language); latent `'ko'` defaults
   become English.
6. A guard test (tests/unit/no-hangul-literals.test.ts) that fails on a new Hangul string in user-visible code, with an
   allowlist that names each kept file and why.

Out (left Korean on purpose, or later):
- Team content and names stored once for everyone (shared/양식, people's messages, chat titles, skills).
- The invite message the owner copies for the team (written in the team's language on purpose).
- Room app cards (webhook / mail cards) are stored as finished text in the team language; rendering them per reader
  needs a stored key + params: later.
- Office Mac installer and `teamax` CLI pages (Korean-and-English pairs by design for the Korean office edition).
- HWP/Hangul document features, Korean matching vocabularies, AI-instruction examples, legacy wordings kept only for
  matching.
- Trina Cloud (separate repo): its `ko` defaults for a new team's language are reported, not changed here. They are
  the likely root of Korean seeded names in a team the owner reads in Indonesian: the welcome steps name the brand
  folder, its images folder and the company intro file in the team's language at the time they run (checked: a team on
  `id` gets shared/Merek/Gambar and Profil perusahaan.md), and a folder once made keeps its name.

## Decisions

- docs/decisions/20261127-sign-in-language-follows-settings.md: the Settings language pick is also this browser's
  sign-in language (changes "Offline reload language", docs/DECISIONS.md, which kept `mycel.locale` for sign-in screens
  only).
- docs/decisions/20261127-phone-app-language.md: the phone app's own screens follow the page's language.

## Risks

No migration. Shared computers: the sign-in screen shows the last person's picked language; it has a language picker.
The phone change needs a store release to reach phones; the web side is harmless for older apps (capability-gated).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, `bun run check:docs`, `bun run test:unit`, the web
unit tests, all under Bun 1.3.12.

## Result

- Built as planned. Live walk: sign-in after sign-out and its error were Korean at 390 and 1440 in a Korean team with
  the owner on Indonesian; fixed and checked again on the rebuilt app. Every signed-in main screen, the welcome steps
  and an AI chat written in Indonesian were already Indonesian (the AI answered in Indonesian; no system prompt forces
  Korean). The onboarding brand step already names folders in the team's language.
- Added after review: the phone app clears the page language on a team switch; a guest accepting an invite gets the
  one-place refusal in their own language; the member archive reuses an archive folder already there in another
  language; the guard test no longer skips any `const id = {…}` object, replacement strings or 3-argument calls.
- The guard covers web/src and the phone app string by string; server, desktop, relay and shared code keep their
  existing file guard (tests/unit/i18n-languages.test.ts).
- PR: https://github.com/trina-app/trina-ax/pull/696
