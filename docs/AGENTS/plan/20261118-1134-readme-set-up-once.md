# README: set up once, the whole team gets it

- Date (UTC): 2026-11-18 11:34
- Branch: `docs/readme-set-up-once`
- Status: in progress
- Where: trina-ax root READMEs and `docs/images/readme/v4/`. Why: the repository front page (docs only, no product code).
- Version impact: none, README and images only.

## Goal

The README's feature list read like features for one person. What sets the product apart is that one person sets
things up once (AI account, Google, apps, company API, Slack, skills, team files) and everyone's AI starts from them.
The front page should say that first, and show the real app instead of drawings.

Research behind it (2026-11-18, 50,051 Show HN posts, README at posting time): among team and self-host repos, 80% of
posts with 100+ points had a picture or video on the first screen against 49% of posts with 3 points or fewer; real app
screens and a way to try it near the top were common in the ones that did well.

## Scope

In:
- Five READMEs (en, ko, ja, es, zh-CN), same structure:
  1. Name as the title, the tagline under it, download buttons (Mac, Windows, App Store, Google Play).
  2. The 97-second film, playing on GitHub (a GitHub attachment, with a one-second title card first so its thumbnail
     reads), instead of a still image that leaves for the website.
  3. "Set up once. Your whole team gets it.": one diagram (light and dark), a "set up once → everyone gets" table and
     three real screens (add an app for the team, the team drive, team skills).
  4. "What everyone does with it": three real recordings (room side chat, folder permissions, picking up a teammate's
     session), four docs screens (scheduled tasks, guests, usage, search) and six one-line features.
  5. Get started with the 10-minute demo unfolded, a short "How it works", then the existing data/limits, community
     and license text unchanged.
- New images in `docs/images/readme/v4/`: the diagram per language and theme (webp), download buttons per language
  (png), three GIFs made from the website's recordings. Docs screens are linked from `docs/site/images/`.

Out:
- A hosted demo team (a "Try the demo team" button): no such server yet.
- Retaking the docs screens with the website's company name (docs use "Acme", the recordings "Dawnroute").
- GitHub's About text.

## Steps

1. Plan (this file).
2. Images and the five READMEs.
3. `bun run check:prepush`, PR to dev, review, merge queue. The front page shows it after the next release.

## Decisions

- Google sits in the "set up once" table: Drive shares with the team and one shared Google account for Gmail, Calendar,
  Docs and Sheets are admin features (docs/site/use/google-apps.md); each person can still connect their own.
- Bright Data is named as an example of an MCP server added by its address (it is not in the app list).
- "Session" for picking up a teammate's work, not "chat".

## Result

(filled in when done)
