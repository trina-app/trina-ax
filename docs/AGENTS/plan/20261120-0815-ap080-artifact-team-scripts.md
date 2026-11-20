# Team script files run inside HTML previews and artifacts (AP-080)

- Date (UTC): 2026-11-20 08:15
- Branch: `ap080-artifact-team-scripts`
- Status: in progress
- Where: web (lib/frame-files.ts, a new lib/frame-scripts.ts, the panels), server (save_url file kinds, AI tool words).
  Why: the artifact panel runs only inline code, so a page that needs a library (Three.js) does not run (AI parity QA
  AP-080).
- Version impact: minor. A new feature: pages can use script files from the team folder; save_url accepts JavaScript.

## Goal

An AI asked for a 3D warehouse page made the page and a fallback card ("open /warehouse.html in Preview or download
the standalone HTML"), because the frame blocks every script from outside the page. claude.ai loads libraries from a
CDN. We keep the stricter rule (no outside connection) and do for scripts what we do for images today: a
`<script src="…">` that names a team file is read with the viewer's permissions and put into the page before the
page goes into the frame.

## Scope

In:
- Classic `<script src>` with a team path (relative to the HTML file's folder, `/…` from the team root, never above
  it): the file becomes a `data:` URL in the `src`. The frame's CSP already allows `data:` scripts; it does not change.
- ES modules: `<script type="module">` (inline or `src`), static and dynamic `import` of team files, and bare names
  (`import 'three'`) through the page's own import map. Each team module becomes a `data:` URL behind one import map
  key `mycel-file:/<path>`; the import specifiers in the modules are rewritten with es-module-lexer (pure-JS build).
  A spike showed that this runs in the real receiver frame in Chromium and WebKit.
- The same server check as images: `embedIn` (403 `embed_narrower`) and the viewer's own read permission.
- Caps separate from the image caps: 5 MB of script files per page, 100 script files.
- A note above the frame: web scripts that do not run, and team scripts that could not be put in (missing, not
  allowed, not a .js file, over the cap). A missing classic script becomes a script that throws a clear error.
- Static views (a confidential chat outside the desktop app) fetch no scripts: unchanged.
- save_url accepts JavaScript files (Content-Type or .js / .mjs name, text bytes), so the AI can save a library.
- AI words: artifact tool, save_url rule and the save_url accepted list: save libraries as team files next to the
  page, reference them by relative path, never a CDN.

Out:
- Scripts a running page makes itself (`document.createElement('script')` with a team path): they stay blocked.
- Import map `scopes`, `integrity`, and import map keys that are not bare names.
- "Save as PDF" of an HTML file (server print) gets no team scripts in this version.

## Steps

1. Plan (this file).
2. web/src/lib/frame-scripts.ts: find scripts, resolve, fetch with embedIn, rewrite modules, build the import map.
   Wire it into resolveFrameFiles / useFrameFiles behind a `scripts` flag; notes in ArtifactPanel and FileBody.
3. i18n keys in every locale.
4. save_url JavaScript kind (server/src/tools/sniff.ts) and the AI words.
5. Tests: web unit (frame-scripts), server unit (frame-embed .js cases, sniff JS kind), e2e (team scripts in a file
   preview, Chromium and WebKit), manual Three.js check with a screenshot.
6. Decision file, changes/ fragment.

## Decisions

- New: `docs/decisions/20261120-team-scripts-in-previews.md`. Extends DECISIONS "previews show only team files" and
  the artifact preview sections (images inlined as data: URLs) to script files.

## Risks

- Security: no new connection. CSP unchanged. An inlined library can do only what inline page code can do already;
  the bytes pass the same embedIn rule as images. The confidential-chat rule (no scripts outside the desktop app)
  stays.
- Memory: a 5 MB cap; base64 makes the page about 7 MB, sent once through postMessage.
- No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, web unit tests
(frame-files, frame-scripts), server unit tests (frame-embed, sniff / save-url), e2e frame-files and the new spec.

## Result

(at the end)
