# The team logo comes from the company website's square icon, set once at the brand press and never over a logo

- Date: 2026-11-28
- Status: accepted
- Supersedes: none
- Branch: feat/team-icon-from-site (the owner, 2026-11-27; plan docs/AGENTS/plan/20261127-1422-team-icon-from-site.md)

- **Ask:** "우리 회사 홈페이지 같은거 받잖아. 거기서 로고 같은거나 favicon받으면 바로 회사 로고, 아이콘으로 설정해줄 수
  있어?" The 회사 소개 step already reads the website; the team logo (top left of the rail, Admin › 팀 설정 › 팀 로고)
  stayed the product's mark until an admin uploaded a file.
- **Rule, onboarding (automatic):** while the draft reads the website, the server picks one square icon from the first
  page it opened (server/src/onboarding/site-icon.ts) and stages it beside the website's pictures. "저장하고 계속"
  (`POST /api/onboarding/welcome/brand`) sets it as the team logo **only if the team has no logo at that moment**: the
  write is a hard link that fails when a logo appeared meanwhile, never a check and then a write. The staged icon is
  used once either way. The answer carries `teamIcon: { version }`; the web shows one toast "홈페이지 아이콘을 팀 로고로
  썼어요 · 되돌리기", and 되돌리기 is `DELETE /api/admin/team-icon?version=<v>`, which removes only that version (409 when
  the logo is another one now: "다른 로고로 이미 바뀌었어요"). Nothing found, or a logo already there: no toast, nothing
  said. Nothing new on the screen while reading or in the saved state. Only the owner's press sets it (not the
  server's own brand runs on a welcome read or before a skill install).
- **Rule, Admin (explicit):** Admin › 팀 설정 › 팀 로고 has "홈페이지에서 가져오기" when the saved company profile has a
  website (desktop button, phone list row). `POST /api/admin/team-icon/from-site` (admin) reads the **saved profile's
  website**, never an address from the request, runs the same picker on its home page and replaces the logo there,
  since the admin pressed for it. Found: "홈페이지 아이콘을 팀 로고로 바꿨어요". Nothing usable: one line "홈페이지에서 쓸
  만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요." (404, `params.reason: not_found`, the same for every failure).
  One run at a time per server (`busy`). Refused with "서버가 아직 준비 중이에요. 잠시 후 다시 눌러 주세요." (409
  `not_ready`) while the server does not know its own public exit address, unless the install turned that check off
  (`MYCEL_EXIT_ADDRESS_CHECK=off`, where web_fetch asks a person and this press is one).
- **Rule, which icon:** in order, the first that passes: the web app manifest's icons ("any" before "maskable", largest
  first); apple-touch-icon (largest first; the site root's `/apple-touch-icon.png` when the page names none);
  `<link rel="icon">` of at least 64 px or without sizes; the JSON-LD organization logo, `og:logo`, or an `<img>` in the
  page's first 400 tags whose class, id or file name says logo (never its alt text alone: QA found a portrait product
  photo described as "… Logo Embroidery Hoodie"); the page's `.ico` or the root `/favicon.ico`, its largest embedded PNG.
  Judged by the bytes only: PNG / JPEG / WebP, short side at least 64 px, long/short at most 1.25, at most 40 MP.
  **Never** SVG (decision 2: skipped in v1), og:image / twitter:image (banners), anything under 64 px (decision 3: no
  upscaling), a shared platform's page (a Naver blog, a smartstore: the icon is the platform's).
- **Rule, the picture:** the isolated, memory-capped ffmpeg crops it square, scales it to 256 px (never up), and writes
  a fresh PNG. A see-through mark (decision 6) goes on a tile by the mean luminance of its opaque pixels: below 0.6 on
  white `#ffffff`, else on near-black `#1d1916`, with about 10 % padding, so it reads in both themes. Without ffmpeg
  only an original that cannot be see-through and is at most 1 MiB is used; see-through ones are skipped. The result
  passes `checkTeamIcon` exactly as an upload, and `/team-icon` serves it as before (nosniff, CSP, exact type).
- **Rule, the network:** only `fetchBytes` with web_fetch's rules: http/https, ports 80/443, public addresses only, the
  server's own exit address refused, the connection pinned to the checked address, every redirect hop checked again
  (at most 3), no cookies. Only addresses the site's markup or manifest names plus its fixed root `/favicon.ico` and
  `/apple-touch-icon.png`; never an address the AI wrote. Budget per pick: one manifest (64 KiB), at most six images
  (6 MiB each on the wire), 12 s per fetch, 30 s in all; ICO directories at most 16 entries, every offset and length
  bounds-checked. Audit: `team_icon.set` with `detail.source: "site"` and the source address; the undo is
  `team_icon.remove` with `undo: true`.
- **Decision 4:** the Admin button may replace an uploaded logo (an explicit press; previews show it, 기본 아이콘으로
  되돌리기 is beside it). Onboarding never replaces one.
- **Decision 5:** no rule for site builders' default favicons in v1. QA 2026-11-28 on 23 public sites (Korean shops and
  builders, Indonesian and global companies): 14 got an icon, 8 none (only small favicons, SVG, a bot check or a slow
  site), the shared-platform address none by rule. The shops tested had their own icons; the builders' own icons
  (imweb, cafe24, Wix) are what a shop that never set one would get, and the toast's undo covers it. Revisit with
  numbers from live use.
- **Words** (en is the source; ko, id, ja, es, zh in web/src/i18n and server/src/admin/team-icon.ts):
  - "Get from the website" · 홈페이지에서 가져오기 · Ambil dari situs web · ホームページから取り込む · Tomar del sitio web · 从网站获取
  - "Used the website's icon as the team logo" · 홈페이지 아이콘을 팀 로고로 썼어요 · Ikon situs web dipakai sebagai logo
    tim · ホームページのアイコンをチームのロゴに使いました · Se usó el icono del sitio web como logo del equipo · 已使用网站图标作为团队标志
  - "Undo" · 되돌리기 · Urungkan · 元に戻す · Deshacer · 撤销
- **Left out (v1):** SVG rasterising, og:image, upscaling, a picker of several candidates, a background re-fetch after
  onboarding, the browser tab and app icons (they stay the product's: DECISIONS.md "Team logo as the tab icon").
- **Tests:** tests/unit/b-site-icon.test.ts (candidate order, manifest, sizes, `<base href>`, ICO entries and malformed
  directories, judging, the tile with and without ffmpeg, private / exit / redirect / oversize / slow / budget, the
  absent-only write and the versioned undo, the press, the admin route); web/test/e2e/team-icon-from-site.spec.ts
  (the toast and 되돌리기, an existing logo kept, the Admin button at 1440 light and 390 dark);
  tests/security/lib/team-icon-cases.ts (the new route by role).
- **Version impact:** minor (a new user-visible feature; two additive response fields, one new admin route, an optional
  query on the logo's DELETE).
