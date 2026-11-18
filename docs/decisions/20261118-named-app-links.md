# A pasted app link shows its name only to someone who could open it

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: feat/named-app-links (the owner; plan docs/AGENTS/plan/20261118-0811-named-app-links.md)

- **Ask:** a link to something in our own app pasted into a message (`/c/<chat>`, `/f/<file link>`, a project, a folder
  or a file, a room) shows its name instead of the raw address, as Slack and Notion show internal links.
- **Rule:** the web app draws a bare address on this page's host or the team address whose path is a known page as a
  small inline chip (the place's icon and a name), still a link that opens inside the app. The name comes from
  `POST /api/link-names` (`server/src/link-names/resolve.ts`), decided for the signed-in viewer on every ask with the
  check the thing's own page makes, never a weaker one:
  - chat: `chatFor(…, 'view')` as `GET /api/chats/:id`, deleted chats left out; the title as that page shows it
    (stored connection secrets hidden).
  - project: `canSeeProject` as `GET /api/projects/:id` without `?manage`: members of its folder. An owner or admin who
    only manages it gets no name.
  - room: a member row of a room that is not archived, a DM still open to its two (`dmPairOk`), as `GET /api/rooms/:id`;
    named as the rooms list names it to them.
  - file link (`/f/<token>`): the link page's own `open()`: a name only when the link opens for the viewer today (live,
    its file in place, by the folder rules or by a grant while its owner still edits the file). Never for a guest
    (links give guests nothing). Stopped, dead, trashed or stale: no name, the owner included. `open()` changes
    nothing; the page's "mark the shared-with-you notice read" is not called.
  - folder / file in Files: `authorize()` as the Files screen (`list` for a folder, `read` for a regular file); a
    hidden or impossible name never.
  - Guests use the same checks with their own, narrower access.
- **No trace:** no access, not there, a malformed id and a check that throws all answer `name: null`. The chip then says
  only the kind of thing ("Trina chat", "Trina file") with the hover line "Only people who can open it see its name.",
  the same words for every reason. Only a name is returned (one line, control and bidi-override characters removed, at
  most 120 characters), never a path; the web draws it as plain text.
- **Kept as before:** a Markdown link with its own label keeps the author's words; an address in code stays code; message links
  (`/rooms/<id>?m=<message>`) keep their own chip and card (docs/DECISIONS.md "Message links and their previews");
  another site and an unknown page stay plain links; in a room, an AI answer's link to a team file keeps its lock-or-copy
  rule. Push, the rooms list's last line, search and every AI read the typed text only.
- **Batching:** the web asks once per short burst of chips on a screen, each link once, at most 50 per request; answers
  are kept for 3 minutes and dropped on a switch of account.
- **Why:** the names are what the viewer can already see by opening the link, so a chip shows nothing new. Reusing each
  page's own check means a later change to who may open a thing changes its chip too.
- **Left out:** `/f/batch/<id>` (several files, no single name), `/skills/share/<id>`, `/scheduled/<id>`, admin and
  settings pages; the person's own question in an AI chat, which is plain text without links today. No rate limit:
  the endpoint answers only what the viewer could read through the pages' own endpoints.
- **Tests:** `tests/unit/b-link-names.test.ts` (granted, denied, missing per kind; file link live, stopped, trashed,
  guest; no side effect on notices; batch cap; clean names), `web/test/unit/app-links.test.tsx` (the matcher, chips,
  labels, code), `web/test/e2e/room-app-links.spec.ts`.
- **Version impact:** minor (a new endpoint and a new look for links in messages).
