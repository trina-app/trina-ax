# Previews run team script files: libraries are put into the page like team images

- Date: 2026-11-20
- Status: accepted
- Supersedes: none. Extends [save_url and team images in previews](../DECISIONS.md#save_url-files-from-the-web-into-the-team-folder-team-images-in-previews-featsave-url-2026-11-01)
  to script files, and the save_url type list of
  [save_url saves Office, CSV and ZIP files](20261118-office-zip-from-the-web.md) to JavaScript files.
- Branch: ap080-artifact-team-scripts (AI parity QA AP-080, the owner chose this option)

- **Ask:** a chat asked for a 3D warehouse page made the page and a fallback card ("open /warehouse.html in Preview or
  download the standalone HTML"): the artifact panel runs only inline code, so a page that needs Three.js (about
  600 KB) did not run. claude.ai loads such libraries from a CDN.
- **Rule:** we keep the stricter rule (no outside connection from a frame) and do for scripts what we do for images.
  Before a page goes into a frame that runs scripts, each `<script src>` that names a team file (relative to the HTML
  file's folder, `/…` from the team root, never above it; an artifact from the team root) is fetched with the
  viewer's own permissions and the same `embedIn` rule as images (403 `embed_narrower`:
  `server/src/team-files/embed.ts`), and put into the page as a `data:` URL (`web/src/lib/frame-scripts.ts`). The
  frame's CSP does not change: it allowed `data:` scripts already.
- **ES modules:** `<script type="module">` (inline or `src`), static and dynamic imports, and bare names through the
  page's own import map (`imports`). A `data:` module cannot resolve a relative import, so every import of a team
  module is rewritten to the key `mycel-file:/<path>` (es-module-lexer, the pure-JS build: imports inside strings,
  comments, template text and regexes are not touched) and one import map, first in `<head>`, maps each key to the
  module as a `data:` URL. The page's own import map is removed. A module `src` becomes an inline module that imports
  its key, so a module is one copy however many import it; cycles work. A spike and the e2e test run this in the real
  receiver frame in Chromium and WebKit.
- **Caps:** only `.js`, `.mjs`, `.cjs` files; at most 5 MB of script files per page and 100 files, separate from the
  image caps.
- **Notes:** above the frame, web scripts that do not run and team scripts that could not be put in (missing, not
  allowed, not a .js file, over the cap), by name. A missing classic script and a classic web script become a script
  that throws an error which names it (the frame never asks for a web script); a web module import stays an address
  that the CSP blocks, as before.
- **Unchanged:** web scripts (CDN, any http/https host) stay blocked; no new outside connection. A static view (a
  confidential chat outside the desktop app) fetches no scripts. "Save as PDF" of an HTML file (the server's print)
  gets no team scripts.
- **save_url:** it also takes JavaScript files: the Content-Type (`text/javascript`, `application/javascript`, …) or a
  `.js` / `.mjs` / `.cjs` name says so, and the bytes are text (no NUL, not a page, not a `#!` program). The AI is
  told (artifact tool, save_url description, the system prompt line on previews) to save a library next to the page
  and reference it by a relative path, never a CDN.
- **Why no new leak:** a page's inline code could do everything an inlined library does; the library's bytes pass
  the same check as an image (everyone who can read the page can read the file), so a script never sees a file that a
  reader of the page could not open. The remaining channel (a host name a script makes the browser connect to) is the
  same as for any scripted page and stays closed by the confidential-chat rule.
- **Left out:** scripts that a running page adds itself (`document.createElement('script')`), import map `scopes`
  and `integrity`, import map keys that are not bare names.
- **Tests:** `web/test/unit/frame-scripts.test.ts`, `tests/unit/frame-embed.test.ts` (script files: 200, 403
  `embed_narrower`, 404, paths above the root), `tests/unit/c-office-from-web.test.ts` (save_url JavaScript),
  `web/test/e2e/frame-scripts.spec.ts` (Chromium and WebKit).
- **Version impact:** minor (a new feature).
