# Team logo from the company website

- Date (UTC): 2026-11-27 14:22
- Branch: `plan/team-icon-from-site` (build branch: `feat/team-icon-from-site`)
- Status: done
- Where: server/src/onboarding (new `site-icon.ts`), server/src/admin/team-icon.ts, routes, web Welcome step and
  Admin › Team settings. Why: onboarding already reads the company website; its icon can become the team logo without
  the owner finding and uploading a file (docs/REPOSITORY-RULES.md: onboarding and admin areas).
- Version impact: minor. A new user-visible feature (the team logo is set from the website); no API removed, two
  additive response fields.

## Goal

Owner (2026-11-27): "우리 회사 홈페이지 같은거 받잖아. 거기서 로고 같은거나 favicon받으면 바로 회사 로고, 아이콘으로
설정해줄 수 있어?"

The 회사 소개 step already asks for the website and the server already opens its pages (onboarding/draft.ts, with
brand-assets.ts collecting a logo, pictures and colours). Today the team logo (top left of the rail, `/team-icon`,
Admin › 팀 설정 › 팀 로고) stays the product's mark until an admin uploads a file. After this change, a team whose
website has a usable square icon gets it as the team logo when the owner saves the 회사 소개 step, with one undo.

## What exists (origin/dev 23daebcff)

- `shared/src/team-icon.ts` `checkTeamIcon`: PNG / JPEG / WebP only (never SVG: it could run scripts from the team's
  address), type must match the first bytes, ≤ `TEAM_ICON_MAX_BYTES` (1 MiB), `TEAM_ICON_MIN_PX` 32 to
  `TEAM_ICON_MAX_PX` 4096 a side. Non-square logos are shown center-cropped (`object-cover`). No image library.
- `server/src/admin/team-icon.ts`: one file `<data>/team-icon`, written atomically, version = SHA-256 prefix; the
  `PUT/DELETE /api/admin/team-icon` routes audit `team_icon.set/remove` and publish `TEAM_ICON_CHANGED`. `/team-icon`
  is public, served with `nosniff`, a CSP and its exact type.
- `server/src/onboarding/brand-assets.ts` `BrandCollector`: for every page the draft's web_fetch opened, it parses the
  markup (`extractPageAssets`: apple-touch-icon, `rel=icon` ≥ 96 px, JSON-LD / og:logo, `<img>` named logo) and fetches
  the best "logo" with `fetchBytes` (web_fetch's SSRF rules: public addresses only, the server's exit address refused,
  pinned connection, every redirect hop re-checked, ≤ 3 hops, 12 s, byte cap). It stages one logo (short side ≥ 64)
  for the brand folder. That logo is ranked for a **document** (a JSON-LD wordmark beats the app icon), which is often
  wide: wrong for a 36 px square. The table's `kind` has a CHECK constraint (`logo|image|page|color`).
- Isolated ffmpeg helpers (`shrinkPicture`, `rawRgba`, `uploads/image.ts seeThrough`), present when ffmpeg is installed
  (`scripts/system/packages.json` "media": always on Linux and hosted; maybe absent on an office Mac).
- Welcome step (web/src/pages/Welcome.tsx `ProfileWizardStep`): the reading is auto-saved ("이렇게 이해했어요 … ·
  고치기"); "저장하고 계속" calls `POST /api/onboarding/welcome/brand` (`placeBrand`), which puts the website's pictures
  in the brand folder. The rail logo is `size-9` (36 CSS px, 72–108 device px).

## Scope

In:
1. A square-icon picker for the team logo, separate from the document logo.
2. Onboarding: set it automatically at "저장하고 계속" when the team has no logo; a toast with 되돌리기.
3. Admin › 팀 설정 › 팀 로고: one "홈페이지에서 가져오기" button when the saved profile has a website.

Out: SVG rasterising, og:image, upscaling tiny favicons, the browser tab / app icons (they stay the product's by
decision "Team logo as the tab icon"), a background re-fetch after onboarding, a picker of several candidates.

## 1. Where to look, in order

The page is the one the draft already opened (the address the owner typed, with its HTML); nothing new is read for
onboarding except at most one manifest and a handful of images. The first candidate that passes wins.

| # | Source | Notes |
|---|--------|-------|
| 1 | Web app manifest (`<link rel=manifest>`) `icons[]` | One JSON fetch, ≤ 64 KiB, parsed with `JSON.parse` in a try. Prefer `purpose` "any" over "maskable" (maskable has a safe-zone margin; still usable as a fallback). Largest `sizes` first, PNG/WebP `type` or none. Manifest on another public host allowed (CDNs), same fetch rules. |
| 2 | `apple-touch-icon` / `-precomposed` | Largest `sizes` first (none = 180). Opaque by Apple's rules: the best fit for a tile. Also try `/apple-touch-icon.png` at the site root when the page names none (one try). |
| 3 | `<link rel="icon">` / `shortcut icon` with `sizes` ≥ 64 or no `sizes` | PNG / WebP by URL or bytes. `sizes="any"` is usually SVG: skipped. |
| 4 | JSON-LD `Organization.logo`, `og:logo`, `<img>` named logo | Only when near-square (long/short ≤ 1.25 by the bytes). A wordmark is skipped here; it stays the brand-folder logo. |
| 5 | `/favicon.ico` (the page's `rel=icon` .ico or the root one) | Parse the ICO directory (pure bytes, bounds-checked, ≤ 16 entries) and take the largest **embedded PNG** entry ≥ 64 px. BMP-only ICOs (16/32/48 px) are skipped. |
| — | SVG (`.svg`, `image/svg+xml`, bytes starting `<`) | Skipped. The pipeline refuses SVG and rasterising an untrusted SVG needs a renderer we will not run on it in v1. |
| — | `og:image` / `twitter:image` | Never: a banner or a product photo, not a logo, even when square. |

Judging is by the **bytes**, never the URL or content type (`imageInfo`): PNG / JPEG / WebP, short side ≥ 64 px (our
floor; 32 px passes `checkTeamIcon` but is blurry at 72 device px), long/short ≤ 1.25, ≤ 40 MP before any decode.
**No upscaling**: a site with only a 16–48 px favicon gets no automatic logo (the browser would scale it the same, and a
blurry logo looks worse than the product's mark).

Budget per reading: 1 manifest + at most 6 image fetches, the collector's 12 s per fetch, 30 s in all, run in the
collector's background queue so the reading is never slower.

Normalising (when ffmpeg is there, isolated, memory-capped): center-crop to a square, scale to 256 × 256 (never up:
a 64–255 px icon keeps its size), flatten see-through pixels onto a tile (below), write a fresh PNG (no metadata, no
polyglot bytes survive). Then `checkTeamIcon` exactly as an upload. Without ffmpeg: the original bytes are used only
when they are already near-square, ≤ 1 MiB and cannot be see-through (`mayHaveAlpha` false, e.g. JPEG or an opaque
PNG); otherwise that candidate is skipped.

Staging: the picked icon is written to `<data>/onboarding-assets/<chat>/site-icon.png` (+ a tiny `site-icon.json`:
source URL, size). A file, not a table row: the `kind` CHECK would need a table rebuild migration; the existing sweep
already removes the folder. `brandAssetsOf` adds `icon: boolean` (optional field of the draft state, additive).

## 2. UX (recommended: set automatically, with undo)

Onboarding, Welcome › 회사 소개:
- Nothing new on the screen while reading or in the saved state (owner-prefers-lean-ui: no card, no extra button).
- "저장하고 계속" (`placeBrand`) also sets the staged icon as the team logo **only if the team has no logo** at that
  moment. The response gains `teamIcon: { version } | null` (set by this press).
- When set: the rail's top-left logo changes at once (`TEAM_ICON_CHANGED`) and one toast:
  "홈페이지 아이콘을 팀 로고로 썼어요 · 되돌리기". 되돌리기 removes it only if it is still that version
  (`DELETE /api/admin/team-icon?version=<v>`; a newer logo is never removed: toast "다른 로고로 이미 바뀌었어요").
- Nothing found or a logo already there: no toast, no message (nothing went wrong from the owner's view).

Why not a confirm card ("팀 아이콘으로 쓸게요 [바꾸기]"): the step already auto-saves the reading with "고치기", the owner
asked for "바로 설정", and a card adds a decision and a box to a step that should be one press. The rail shows the
result itself; the undo is one tap; replacing it lives where it always lives (Admin › 팀 설정 › 팀 로고).

Admin › 팀 설정 › 팀 로고 (`TeamIconRow`):
- One more button beside 로고 올리기/바꾸기: "홈페이지에서 가져오기", only when the saved company profile has a website.
  On a phone, one more `PhoneListRow`.
- It reads the **saved profile's website** on the server (never an address from the request), runs the same picker
  (home page fetch with web_fetch rules → candidates → judge → normalise) and replaces the logo, since the admin pressed
  for it. Toast "홈페이지 아이콘을 팀 로고로 바꿨어요"; the light/dark previews show it. Not found: inline error
  "홈페이지에서 쓸 만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요."
- Busy state on the button (up to ~30 s), one run at a time per server.

Never overwritten: onboarding writes with an "only if absent" write (temp file + `fs.linkSync` to `<data>/team-icon`,
which fails atomically if a logo appeared meanwhile, then unlink the temp), not a check-then-write.

## 3. Safety

- Network: only `fetchBytes` / `resolveTarget` / `pinnedGet` from tools/web-fetch.ts with `blockedIps` from
  `egressOf(ctx)`: http/https, ports 80/443, public unicast only, no local names, pinned IP (no DNS rebinding), each
  redirect hop re-checked, ≤ 3 hops, no cookies or credentials, the server's own exit address refused.
- Exit address not known yet (`egressOf(ctx).known` false and the check not turned off): the admin button refuses with
  "서버가 아직 준비 중이에요. 잠시 후 다시 눌러 주세요" (web_fetch would have asked a person; here nobody is asked). In
  onboarding the collector only follows pages the reading already opened under the same rule.
- Inputs: only URLs the site's own markup or manifest names, plus the fixed `/favicon.ico` and `/apple-touch-icon.png`
  of the site. Never a URL the AI wrote. The admin endpoint takes no URL.
- Limits: manifest ≤ 64 KiB, each image ≤ `BRAND_IMAGE_BYTES` (6 MiB) on the wire and ≤ 1 MiB stored, decompression
  capped (`decode`), ≤ 40 MP checked from the header before ffmpeg, ICO ≤ 16 entries with every offset and length
  inside the buffer, 7 fetches and 30 s in all.
- Content: decided by the bytes (`imageInfo`), never `content-type` or the extension; SVG, GIF, HTML, AVIF refused.
  ffmpeg only via `runIsolated` with the existing memory cap; output re-encoded PNG; final `checkTeamIcon` identical to
  an upload. Served as today (`nosniff`, CSP, exact type).
- Who: onboarding is the owner's `welcomeBrand` press; the admin route is `auth: 'admin'`, audited as
  `team_icon.set` with `detail.source: 'site'` and the source URL; 되돌리기 is audited `team_icon.remove`.
- Errors: the admin route returns one generic "not found" for every failure (no fetch error text: no probing oracle).
  Server log keeps the reason at warn level without the page content.
- Shared platforms: when the website's scope is a path on a shared platform (`webScope().prefix`, e.g. a Naver blog or
  a smartstore page), no icon is taken: the icon there is the platform's, not the company's.

## 4. Hosted, self-installed, offline

- Hosted teams (one server per team) and Linux self-installs: ffmpeg is in the always-installed "media" group, so
  normalising works; the exit address is learned from the relay or the release feed.
- Office Mac / dev: ffmpeg may be missing → only opaque near-square originals are used (apple-touch-icon, JPEG). The
  rest is skipped silently in onboarding; the admin button says it found nothing usable.
- Offline, a demo with fakes (`demoOffline`), or no relay on a dev server: the reading itself fails or opens nothing,
  so nothing is staged; the admin button gives the "not found" (or "not ready") line. No retries in the background.
- Older clients: the new response fields are optional; an older web build simply shows no toast.

## 5. Edge cases

- **No icon found** → nothing set, nothing said in onboarding; admin button: the "not found" line with upload as the
  way on.
- **Banner-shaped image** (long/short > 1.25) → skipped, never cropped: a cropped wordmark reads as random letters at
  36 px. The next candidate is tried. It still goes to the brand folder as the document logo, as today.
- **Transparent background** → flattened onto a tile: the mark's opaque pixels are sampled (`rawRgba` 32 × 32); a dark
  mark (mean luminance < 0.6) goes on white `#ffffff`, a light mark on near-black `#1d1916`, with ~10 % padding. The
  tile then reads in both themes. Without ffmpeg, see-through candidates are skipped.
- **Dark logo in dark mode** → covered by the tile; opaque icons already carry their own background (apple-touch). The
  admin previews (light / dark) show it.
- **Cloudflare or a bot check** → the home page fetch gets a challenge page or 403 (the reading already reports the
  site as unreadable); we try `/favicon.ico` and `/apple-touch-icon.png` once each (often served outside the challenge)
  with `pinnedGetEither`'s second agent; no headless browser, no bypass. Else nothing.
- **Non-English site** → icons come from markup, not words; IDN hosts work through `URL` (punycode). The toast and
  admin strings are added in all six locales (ko, en, id, ja, es, zh).
- **Site-builder default favicon** (imweb, cafe24, Wix, sixshop sites that never set one) → would set the builder's
  icon. v1: undo covers it; QA measures how often on 20 Korean SMB sites before any rule (see decision 5).
- **The owner reads a second, different website** → the latest draft's staged icon is used (as `placeBrand` uses the
  latest draft's pictures).
- **A logo uploaded between the reading and the press** → the absent-only link fails; nothing changes, no toast.

## Steps

1. `server/src/onboarding/site-icon.ts`: `iconCandidates(html, base)` (pure: manifest link, apple-touch, rel=icon,
   logos, root fallbacks), `manifestIcons(json, base)`, `icoPngEntry(bytes)`, `judgeIcon(bytes)` (size, ratio, floor),
   `normaliseIcon(bytes, ffmpeg)` (crop, scale, tile, PNG), `pickSiteIcon(candidates, net)` (budget, order),
   `fetchSiteIcon(website, net)` (home page → pick, for the admin button).
2. `BrandCollector.page`: for the first page with HTML (and not a shared-platform scope), queue `pickSiteIcon` once;
   stage `site-icon.png` + `.json`. `brandAssetsOf` → `icon`.
3. `admin/team-icon.ts`: `saveTeamIconIfAbsent(dataDir, bytes)` (link-based), `removeTeamIcon(dataDir, version?)`.
4. `placeBrand`: after the pictures, apply the staged icon if absent; audit; publish `TEAM_ICON_CHANGED`; return
   `teamIcon`. `WelcomeBrandResult.teamIcon` optional.
5. Routes: `POST /api/admin/team-icon/from-site` (admin, no body, single-flight); `DELETE /api/admin/team-icon` takes
   an optional `version` query (409 when it differs). `bun run docs:api`.
6. Web: Welcome `brand()` toasts with 되돌리기 when `teamIcon` is set; `TeamIconRow` button (desktop + phone row);
   mock server support for both routes; i18n in six locales.
7. Decision file `docs/decisions/20261127-team-logo-from-website.md`; `changes/team-logo-from-website.md`.

## Decisions

New: `docs/decisions/20261127-team-logo-from-website.md` (automatic at the brand press, never overwrite, square
icons only, no SVG / og:image / upscaling, tile for see-through marks). Builds on DECISIONS.md "Team logo as the tab
icon" (tab and app icons stay the product's: unchanged) and "N — The first result is the company's card news".

## Risks

- No migration (staged as a file). If the build later needs a row, check the highest number on dev (703 today).
- Public repo: test fixtures are generated bytes and fictional `*.example` sites, no real company icons.
- Wrong logo set without asking (builder default, a parked domain's icon): mitigated by square + size floor, the
  shared-platform rule, undo in the toast, and the admin row.
- `/team-icon` is public: the icon was public on the company's own site already.
- Phone and desktop: the admin row on both layouts; Welcome toast on both.

## Tests

Unit (`tests/unit/`):
- `site-icon.test.ts`: candidate order (manifest > apple > rel=icon > square logo > ico), `sizes` parsing incl. "any"
  and lists, relative URLs and `<base href>`, maskable vs any, SVG / og:image never chosen, wordmark (3:1) skipped,
  48 px favicon skipped (no upscale), 64 px accepted, ICO with a PNG entry → that PNG, BMP-only ICO → none, malformed
  ICO (entry count 0xffff, offsets past the end) → none without throwing, manifest > 64 KiB or bad JSON → ignored.
- Fetch rules with the local test server (`testAllow`): an icon URL on 127.0.0.1 / 169.254.169.254 / the exit address
  / a redirect into a private address is refused; HTML served as `image/png` refused; an SVG named `.png` refused;
  > 6 MiB refused; a slow server stops at the deadline; at most 7 fetches.
- `team-icon` writes: absent-only write keeps an uploaded logo (race: upload between check and link); remove with a
  stale version → 409 and the file stays.
- `placeBrand`: sets the staged icon when none, leaves an existing one, returns `teamIcon`; shared-platform scope stages
  nothing; normalise without ffmpeg skips a see-through PNG and keeps a JPEG.
- Admin route: member 403, no website → 409, exit address unknown → refusal, single flight.
- `normaliseIcon` (when ffmpeg is there): a transparent dark mark lands on white, a light one on dark, output 256 px
  PNG passing `checkTeamIcon`.
Web: e2e (mock) — Welcome press shows the toast and 되돌리기 restores the product mark; Admin button on desktop and
390 px, light and dark. Checks: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run
check:prepush`, the onboarding + admin unit tests, web e2e for the two screens.

## Review

Read as the non-developer owner:
- "바로 설정" is met: one press they already make sets it; the rail shows it. Fixed: the first draft had a preview card
  in the saved state; cut (one more box, and the owner did not ask to approve it).
- Wording: the UI calls it 팀 로고 everywhere (Admin row title); the toast says "홈페이지 아이콘을 팀 로고로 썼어요" so it
  is clear where it came from. No "favicon", "manifest" or "px" on screen.
- Fixed: silent failure is right in onboarding, but the admin button must say why nothing happened and what to do
  (upload), so it has one plain line.
- Worry "it picked the wrong thing": undo in the toast, and the admin previews in light and dark.

Read as a security reviewer:
- Fixed: the first draft let the admin button take a URL; now it reads the saved profile's website only, so the route
  is not a fetch proxy.
- Fixed: "check no logo, then write" was a race; now an atomic absent-only link, and undo removes only its own version.
- Fixed: exit address unknown → the server refuses instead of fetching unconfirmed (web_fetch would have asked a
  person).
- SVG never decoded or rasterised; ffmpeg isolated and only after the pixel cap; output re-encoded; final check is the
  upload's. ICO parsing bounds-checked. Errors are generic to the client.
- Residual: an attacker-controlled site can choose what image the team logo becomes — only for the team whose owner
  typed that site, visible at once, and undoable.

## Open decisions (one recommendation each)

1. Automatic with undo, or a confirm card? **Automatic at "저장하고 계속", toast with 되돌리기.**
2. SVG-only sites (common on newer sites): **skip in v1**; revisit if the QA sample shows many sites with only SVG,
   then rasterise in the isolated ffmpeg (librsvg, no external references) or the headless shell.
3. Tiny favicon only (< 64 px): **skip, no upscale**; the product mark stays.
4. Admin "홈페이지에서 가져오기" replaces a logo an admin uploaded? **Yes, it is an explicit press**; previews show the
   result and 기본 아이콘으로 되돌리기 is beside it. (Onboarding never replaces.)
5. Site-builder default favicons: **no rule in v1**; QA checks 20 Korean SMB sites (imweb, cafe24, Wix, sixshop) and
   we add a general rule only if the rate is high (owner-fix-general-not-case-specific).
6. Transparent marks: **put on a white or near-black tile by the mark's brightness**; without ffmpeg skip them.

## Result

Built as planned on `feat/team-icon-from-site`; decision `docs/decisions/20261128-team-icon-from-site.md` (named by the
branch, dated the day it was written), note `changes/team-icon-from-site.md`.

- Picker `server/src/onboarding/site-icon.ts`; staged as `<chat>/site-icon.{png,jpg,webp}` + `site-icon.json` by the
  collector (first page with markup, not on a shared platform's page); `assets.icon: true` only when staged.
- Onboarding: `placeBrand(..., { siteIcon: true })` from the owner's press only, before the sweep; `applySiteIcon` uses
  the staged icon once (an undo stays undone). `saveTeamIconIfAbsent` links a temp file; `removeTeamIcon(dir, version)`
  returns `stale` (409 on the route).
- Admin: `POST /api/admin/team-icon/from-site` (admin/team-icon-site.ts): saved website only, single flight, generic
  "not found", refused while the exit address is unknown unless `MYCEL_EXIT_ADDRESS_CHECK=off` (there web_fetch asks
  a person, and this press is one).
- Changed from the plan after QA: `<img>` logos count only by class, id or file name, never alt text alone, and only
  in the page's first 400 tags (a portrait product photo with alt "… Logo Embroidery Hoodie" passed the 1.25 ratio).
- QA (2026-11-28, private dev copy with its local relay, the real route): 23 public sites, 14 icons, 8 none, the shared
  platform none by rule; screenshots at 1440 / 390, light / dark, all readable. No shop tested got a builder's default.

