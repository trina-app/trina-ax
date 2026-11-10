# README: the features at a glance

- Date (UTC): 2026-11-10 00:49
- Branch: `docs/readme-features`
- Status: done
- Where: the five root READMEs (`README.md`, `README.ko.md`, `README.ja.md`, `README.es.md`, `README.zh-CN.md`). Why:
  the README is the GitHub front page, and visitors do not see what the product does.
- Version impact: none, documentation only.

## Goal

A visitor sees what Trina AX does, feature by feature, in the first screen of the README: shared files with
per-person access, team skills, rooms with the private AI side chat and **Send to room**, continuing a teammate's AI
chat, connections, scheduled tasks, version history, PDF/Office/HWP files, the apps, self-hosting and bringing your
own AI login.

## Scope

In:

- A feature table right after the intro, one line per feature, which replaces "What you get" and the three bullets
  under the hero.
- Fix text that still says @Trina answers in the room: since #247 people ask in the side chat beside the room (✦) and
  only a sent answer reaches the room. Drop the two room images that show the old way (`room-quote.png`,
  `share-check.png`); they stay in the repo.
- Mark what is in the 0.5 betas or on `dev` only, since the stable release is 0.4.0.
- Remove "What's next": shared project chats have shipped, the Android APK is out, 0.4 is stable.
- The same changes in all five languages, written naturally in each. Every claim checked against the code,
  `CHANGELOG.md`, `docs/` and `web/src/i18n/en.ts`; claims that cannot be checked are left out.

Out: new images, the docs site, `llms.txt`, the website.

## Steps

1. Check each feature on `dev` and the app's labels (Send to room / Send to thread from `shared/src/api/rooms.ts`).
2. Rewrite `README.md`, then the four translations.
3. Check links and anchors in the five files.

## Risks

Public repo: fictional names only (Dawnroute, Mina, Sam, Alex), no customers, no testimonials, no claim that AI
usage is included. `scripts/check-onboarding-docs.ts` needs the exact phrase "one company connection can serve the
whole team by default" in `README.md`.

## Tests

`bun run check:docs`, `bun run check:i18n`, `bun test tests/unit/onboarding-docs.test.ts`, and a check that every
relative link and in-file anchor in the five READMEs resolves. No code changes, so no typecheck needed.

## Result

A twelve-row feature table replaces "What you get" and the hero bullets in all five READMEs; "Same room, two
screens" and "What's next" are gone; each file is 24 lines shorter. An independent review found that stable 0.4.0
has no threads or group chats and that project skills, your own OAuth app and sending answers to a room are on
`dev` only, so those are marked (0.5). Left out: a public Mac desktop app download (no DMG in the releases). PR into
`dev` from `docs/readme-features`.
