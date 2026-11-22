# Web pages keep versions, and the AI checks that a page it made renders

- Date (UTC): 2026-11-22 08:17
- Branch: `feat/page-versions-render-check` (off `batch/20261122-i` cc98820f1)
- Status: in progress
- Where: server (tools/artifact.ts, tools/index.ts, a new tools/artifact-check.ts, chat/turn.ts, chat/prompt.ts,
  routes, migration), shared (ArtifactInput, ArtifactSummary, step labels), web (ArtifactPanel). Why: scenario QA
  S-033 and S-102 (cases-v2.md).
- Version impact: minor (people and the AI can restore earlier versions of a page; the AI's page tool gains two actions
  and a render check; one migration adds two columns)

## Goal

1. **S-033**: in a shared chat, "글자 크게 해줘" on a page the AI made gave a new page card each time (every card "v1"),
   and the AI said it could not load the earlier code, so "준호님이 고치기 전 버전 보여줘" had no answer. An edit of an
   existing page must become a new version of the same page, as with chat files; earlier versions can be opened and
   restored by people and by the AI, and each version records who asked.
2. **S-102 / dashboard**: a page opened blank with "Uncaught SyntaxError: Identifier 'top' has already been declared",
   and the AI said it was done without opening it. When the AI creates or edits a web page, the server opens it in the
   headless browser the box already has and tells the AI the console errors and whether the page is empty, so it fixes
   them before reporting.

## Root causes (read from the code)

- Artifacts already keep versions per `key` (tools/artifact.ts, one row per version; the panel has ‹ v2 / 3 ›). But the
  AI has no way to read a page's content: `update` needs the exact `old` text and `rewrite` the whole page. A turn that
  does not hold the page in its own session (every other person's turn in a shared chat, a fresh session, Codex, the
  API engine) cannot do either, so it makes a new page under a new key (a new card, v1). Nothing tells that turn which
  pages the chat has or under which keys.
- No restore exists, for people or the AI, and a version does not say who asked for it (only the message id; a turn's
  user is two joins away and is not in the API).
- The artifact tool saves and returns "saved as version N"; nothing opens the page.

## Scope

In:
1. **AI reads and restores pages** (shared/src/tools.ts ArtifactInput, tools/artifact.ts):
   - `action: "read"` (optional `version`): the page's content (newest, or that version) with a header line: key,
     title, type, "version N of M", who asked for it, and the version list (number, who asked, restored from). Long
     content is cut at 200,000 characters with a note (pages are usually far smaller; the cap keeps a tool result
     sane). Read-only: no row, no event, no card.
   - `action: "restore"` with `version`: a new version with that version's content, type, title and language
     (`restored_from` = n); nothing is deleted. Same limits as any new version (size, count, per-chat bytes, storage).
   - `type` becomes optional in the schema; create and rewrite still need it (ToolError).
   - Hidden versions (chat/shared-answers.ts via `hiddenVersions`) stay hidden: read and restore of a version hidden
     from the runner answer "no such version", like update does today.
2. **Who asked** (migration `439_b_artifact_versions.sql`): `artifacts.asked_by TEXT` (the person: the turn's user for
   an AI version, the person for a restore in the panel) and `restored_from INTEGER`. Older rows fall back to the turn of
   their message. `ArtifactSummary` gains optional `byName`, `ai` (true: the AI made it at that person's request) and
   `restoredFrom` (older clients ignore them).
3. **Pages of this chat in every turn** (chat/turn.ts message, a small builder in tools/artifact.ts): when the turn has
   the artifact tool and the chat has pages visible to the runner, the message carries a `<chat_pages>` block: each
   key with type, title (cleaned, clipped), how many versions, newest by whom. One line of guidance: to change one, use
   its key (read it first, then update or rewrite); a new key makes a separate page; to go back, restore. At most 20
   keys (newest first). Not for a restricted turn (drafts, judges) or a guest without the tool.
4. **Prompt and tool text** (tools/index.ts description, chat/prompt.ts lines 1294 and 1522): name read and restore;
   "a page someone asks to change is a new version of the same key, never a new key".
5. **People restore** (routes/artifacts.ts, `POST /api/artifacts/:id/restore`): who sees the chat (the same
   `ownChat` rule as GET) and the version is not hidden from them; the chat is not in the trash. Makes a new version
   (message_id NULL, asked_by = person) and sends `artifact.updated` to everyone who sees the chat now (each only when
   the new version is not hidden from them). docs/site/reference/http-api.md via `bun run docs:api`.
6. **Panel** (web ArtifactPanel): with more than one version, a strip under the header "Version n · Trina for 박준호 ·
   3 minutes ago"; on an older version, [Restore this version] and [Back to newest]. Reuses the chat-file strings
   (`chatFile.viewing`, `chatFile.byAi`, `chatFile.restore`, `chatFile.backToNewest`, `chatFile.restored`): no new
   strings in the five languages. Not for a promo video or an intro deck (server-built; their versions stay as now).
7. **Render check** (new server/src/tools/artifact-check.ts, called from the artifact tool after create, update,
   rewrite and restore of an `html` page):
   - The browser is HTML to PDF's (files/html-pdf.ts `runBrowser`, the pinned chrome-headless-shell of
     scripts/system/packages.json found by `findPdfBrowser`, in the converters' isolation with no network, never root,
     killed with its processes). JavaScript on, as tools/page-render.ts does, since running the page is the point.
   - The page is served at a reserved origin; every request is answered by the server: team pictures, stylesheets and
     fonts the person may read (authorize, quarantine check), team scripts too except in a shared chat (the preview
     withholds team scripts there: web/src/lib/frame-scripts.ts), the same as the panel shows. Everything else
     (web addresses, fetch/XHR: the preview's CSP has connect-src 'none') is refused, and the refusal is reported as
     an error the AI can act on ("a web address does not load in the preview: save it with save_url").
   - Collected: uncaught exceptions (`Runtime.exceptionThrown`, with line), `console.error`, failed loads
     (`Log.entryAdded` level error); deduplicated, at most 10, each cut to 300 characters. "Empty": after load, no
     visible text and no visible picture, canvas, svg, video or form control with an area.
   - One time limit for the whole check, 5 s (browser start included). Past it, no browser, no isolation, root, or the
     print slots busy (`tryRenderSlot`, never waits): "could not check (reason)", and the AI is told not to say it
     checked.
   - The result is appended to the tool's text: OK ("opened in a browser: no errors, it shows N characters of text"),
     problems ("fix these with update on this key, then tell the person; do not say it is done before"), or not
     checked. The step summary (audit) gets `check ok|errors N|empty|skipped`.
   - React artifacts and other types are not checked (they are compiled in the person's browser; out of scope).

Out: checking React artifacts; a phone-width render; screenshots for the AI; making artifacts chat files (the
artifacts table already is a per-key version chain; moving pages into chat:files would change previews, sharing and
the panel at once); the "기준: 엑셀 ○월 ○일 버전" line of S-102 (a prompt matter, not this change).

## Steps

1. This plan (first commit); independent plan review; apply.
2. Server: migration, Artifacts read/restore/asked_by/list fields, tool schema and text, `<chat_pages>` block, prompt.
3. Render check module and its call; unit tests with a fake CDP where possible and a real-browser test that skips
   without one.
4. Route + web panel strip; web unit test.
5. Bun 1.3.12 on the Mac mini: typecheck, check:prepush, area tests (artifacts, prompt pins, step labels, tools), web
   unit, docs:api.
6. Real check on a private QA copy (Linux container, claude-code engine, QA OAuth token read only inside scripts):
   S-033 end to end; a dashboard with a deliberate duplicate `let top` that the AI must see and fix.
7. Independent code review; apply; one PR into dev with "reviews done", not queued.

## Decisions

None new. Follows the chat-file version rules (docs/decisions/20261121-ai-edits-chat-files.md: every change is a new
version, nothing is deleted, restore brings one back as the newest).

## Risks

- Migration 439 (dev's highest is 435, batch/20261122-i has 436-438): checked again before the PR.
- Security: the check runs AI-written JavaScript in the same locked-down browser as page-render (no network, isolation,
  limits, killed after). It serves only files the person may read and, in a shared chat, no team scripts (as the
  preview). Restore follows the same visibility as GET; hidden versions stay hidden for read, restore, list and events.
- Time: the check adds at most ~5 s per page save, and only for html.
- Prompt pins (tests/fixtures/engine-prompt-pin) change with the tool schema and texts: re-recorded.
- Five app languages: no new strings (chat-file strings reused); step labels for read/restore in all six.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, tests/unit for artifacts
(versions, read, restore, hidden, route, chat pages block, check text), prompt pins, step labels, web unit
(ArtifactPanel), and the real check above.

## Result

(filled in at the end)
