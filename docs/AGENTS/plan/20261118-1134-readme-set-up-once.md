# README: set up once, the whole team gets it

- Date (UTC): 2026-11-18 11:34
- Branch: `docs/readme-set-up-once`
- Status: done
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
- "Session" for picking up a teammate's work, not "chat" (the founder's word; Spanish says "sesión de trabajo" so it does not read as a login session).

## Result

- Five READMEs with the structure above; the part from "Trina provides the workspace" down is byte-identical to dev.
- 25 images in `docs/images/readme/v4/` (3.4 MB). The film is a GitHub attachment posted in the PR, public without
  sign-in (an attachment that is only uploaded, not posted, returns 404 to signed-out visitors).
- An independent review checked every claim against docs/site. Fixed from it: the team dialog screenshot (the template
  one said "each member adds their own"; now `connect/add-by-address-key.webp`), "the owner or an admin", Slack
  answers only in channels it is invited to, "every file request" for the permission check, Korean 게스트, the Korean
  security link.
- `bun run check:prepush` OK; rendered on GitHub signed out in light and dark.
- Follow-up (founder, 11/18): the screen row starts with Admin › Connected apps (`slack/connected-apps.webp` cropped to
  `docs/images/readme/v4/connected-apps.webp`: "Applies to everyone", Google apps "One setup, then every member just
  signs in", Slack, Notion, Linear, Atlassian, Canva, "Add one by its address") across the full width; the team drive
  and team skills sit under it. The add-an-app dialog is no longer in the README.
- Follow-up (founder, 11/18): "One AI account for the whole team" opens the set-up-once section; "Team chat, like
  Slack" (channels, private channels, DMs, group chats, threads, @mentions; `chats/room.webp`) opens what everyone does;
  Get started shows the three Docker commands (clone, `docker compose up`, setup link) with the guide's caveat (newer
  and less tested than Linux; Ubuntu 24.04 needs a host setting).
- Follow-up (founder, 11/19): team chat moves to a small last row of the grid with a full-window picture (channels,
  channel, thread) shot from a fresh Acme demo; scheduled tasks show the weekly summary a run wrote and guests a fuller
  Launch email chat (more fictional messages added to the demo before the shots); the session line separates team
  projects (shared with members) from Share (people or groups); new: files found by what they are (the nightly file
  list, with the 172 → 181 of 184 result from docs/AGENTS/plan/20261111-0630-file-list.md) and the in-app browser.
- Follow-up (founder, 11/19): a star request. Launch-time READMEs in the HN sample asked in 3% (top, mid and low
  alike); the 40 repos with the most stars now ask in 15%, near the top or at the end, "if it's useful, a star helps
  others find it", no rewards (GitHub's rules). An orange "Star Trina AX on GitHub" button with that line goes under
  the film, and one line opens Community.
- Follow-up (founder, 11/19): profile photos (the website's fictional people) on the team chat and guest pictures; eight
  team skills in the skills picture; the star button links to `?tab=readme-ov-file` (a link to the page itself keeps
  a signed-in visitor where they are, and `/stargazers` is 404 when signed out since GitHub closed stargazer lists) and
  says to press Star at the top of the page.
- Follow-up (founder, 11/19 afternoon): a thin divider with the Trina mark before every section (light and dark, no
  text, so one pair serves five languages); five team skills instead of eight, shot narrow so the text reads in a
  half-width cell; the usage picture without the admin side menu (`v4/usage.webp`, from the Acme demo); the team chat
  title says "like Slack, but with Trina AI".
