# A pasted link to something in the app shows its name

- Date (UTC): 2026-11-18 08:11
- Branch: `feat/named-app-links`
- Status: in progress
- Where: core (`server/src/link-names/`, `shared/src/api/link-names.ts`, `web/src/`). Why: rooms, chats, files and
  projects are core features (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new endpoint and a new look for links in messages

## Goal

A link to a chat (`/c/<id>`), a file link (`/f/<token>`), a project, a folder or a file in Files, or a room pasted into a
message shows as a raw address today. People want the thing's name, as Slack and Notion show internal links: a small
inline chip with the right icon and the name, still a link that opens inside the app.

## Scope

In:
- One pure matcher `web/src/lib/appLinks.ts`: an address on this page's host or the team address whose path is a known
  route: `/c/<chat>` (and `/c/<chat>/t/<message>`), `/projects/<id>` (and `/files`), `/rooms/<id>` (and
  `/rooms/<id>/t/<root>`, without `?m=`: message links keep their own chip and card), `/f/<token>` (not `/f/batch/`),
  `/files/view?path=<file>`, `/files?path=<folder>`.
- One endpoint `POST /api/link-names` that names a batch (at most 50, deduplicated) as the caller, using the checks the
  pages themselves use. No name for "no access" and "not there" alike.
- One chip (`web/src/components/AppLinkChip.tsx`) drawn by the shared link pieces: a person's message in rooms, DMs and
  threads (`RoomLink`), and AI answers (`Markdown.tsx`), only for a bare address. A `[label](url)` keeps its label.
  A client store batches lookups (one request per short burst), caches them for the signed-in person and forgets them on
  a switch of account.

Out:
- `/f/batch/<id>` (a list of several files, no single name), `/skills/share/<id>` (an admin's import page),
  `/scheduled/<id>`, `/activity/<id>`, admin and settings pages: plain links as before.
- The person's own question in an AI chat: drawn as plain text without links today; unchanged.
- Push, the rooms list's last line, search: they read the typed text, unchanged.

## Steps

1. Shared API contract + server resolver with unit tests (granted / denied / missing / guest / share link states).
2. Route module, registered after the chats and files modules.
3. Web matcher (unit tested), store, chip, wiring in RoomLink and Markdown.
4. i18n (en, ko, ja, zh, es, id), e2e spec, screenshots on a private copy of the QA team.
5. Docs: decision note, changelog fragment, API summary.

## Decisions

- `docs/decisions/20261118-named-app-links.md`: a name only when the viewer could open the thing now; the same generic
  chip for no access and for nothing there.

## Risks

Leaks: a name must never reach someone who could not open the thing. Each kind reuses the page's own check (chatFor,
canSeeProject, the share link's open(), authorize for Files, the room member row). No migration. Six languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new server and web unit tests (server under Bun
1.3.12), `tests/unit/c-reader-counters.test.ts`, the new Playwright spec, `bun run check:prepush`.

## Result

(filled in at the end)
