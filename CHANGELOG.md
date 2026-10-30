# Changelog

Published artifacts and authoritative release notes are in [GitHub Releases](https://github.com/trina-app/trina-ax/releases).
This file summarizes user-visible changes; it is not a list of every commit.

## Unreleased

**Upgrade note:** migrations 214, 215 and 322 are additive (reader 1). Personal connections set to "run without asking" ask again. Scheduled tasks made before this release open web addresses only after a person confirms, which an unattended run cannot do: recreate such a task in a chat.

- Sub-agents: like Claude Code's Agent tool, the AI can hand parts of a big request to up to 4 helper AIs at once. They work as the same person (same tools except asking the person, memories, schedules and the browser; the same access checks, cards and activity records) and their steps show under a "Sub-task" row. On by default; Admin > Team settings can turn it off. The model proxy now checks the tool names of every request, and the engine starts with `--restricted` and every unused built-in denied. Migration 214 (reader 1).
- Scheduled tasks: when the AI creates one, a card shows the title, the schedule, the whole instruction and the web addresses in it; only those addresses open without asking in its runs, and a run's message no longer counts as typed by the person.
- Web pages and search results: the AI opens at most 8 of their links per answer and 30 per conversation without asking; then each new one asks.
- web_fetch and the in-app browser look a web address up only after the person allowed it; the desktop browser cancels requests it blocks without looking the name up.
- Connected services: the card before a change shows everything that is sent, where it goes first; "run without asking" is for team connections only, and runs in a scheduled task only if its card allowed it.
- Codex web search uses its cached index (no live page loads), enforced by the model proxy.
- "Ask the AI to fix it" no longer carries web addresses from the artifact's title or key.
- Security: artifacts and HTML / SVG previews can no longer open WebRTC or WebTransport connections, including through nested frames, shadow roots or `document.write`; inside them, `document.write`/`open`, `setHTMLUnsafe`, `window.open` and nested iframes are turned off. In confidential chats (Safe operations 1A) they are shown without running scripts except in the desktop app, with a notice in ko/en/id/ja/es. Other chats work as before. See docs/DECISIONS.md "Artifact frames: no direct connections".
- AI connections: a ChatGPT (Codex) connection now counts its use (tokens, requests, last used) in Admin > AI connections, so its monthly limit works; chatgpt.com sends its answer stream with no content type, and the model proxy read it as a plain reply. The server log no longer warns about Codex's background calls or about the Stop button (logged as the person's stop).

## 0.2.11 — 2026-10-30

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.11).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4). `MYCEL_HWP_PREVIEW` no longer does anything; you can remove it from the environment file. Linux servers no longer use tesseract: new installs do not install it, and a copy that is already installed is not used.

- HWP Preview is available: the first official plugin, cleared by the founder on 2026-10-30 (the font-width tables inside rhwp are accepted as a known risk while edwardkim/rhwp#8387 is open). An owner or admin installs it from Admin > Plugins > Official plugins > Install; the server downloads the pinned build for its platform from `https://updates.trina.app` (so it needs outbound https there), checks it and shows the permission prompt. Hosted servers, self-installed servers and office Macs all install it this way; a self-installed server or office Mac without internet access can take the same file through Install from file or `<data folder>/plugins/import/`. It runs on macOS (Apple silicon and Intel), Ubuntu 24.04 and Debian 13; Linux with glibc older than 2.39 (Debian 12) shows "Not supported on this server" and downloads nothing. Turning the plugin on is the only switch. HWP/HWPX text reading, search, original downloads and the write guard stay built in without the plugin.
- The AI sees images and PDF pages, like Claude Code's Read: photos, screenshots and other images reach the AI as images, and a PDF is read by pages (at most 20 per read; a page without a text layer, such as a scan, comes as a page image). On by default; owners and admins can turn it off in Admin > Team settings > "Send images and PDF pages to the AI". Images go to the AI provider like other file content. Linux servers no longer run OCR, so scanned documents and photos are not text-searchable there; a Mac server keeps Apple Vision for the search index of scanned PDFs.
- Chat: while the AI waits for the answer to its question, sending from the message box answers it (the typed text, plus what is ticked on a several-answers card) instead of waiting until the answer is done; the box says so. The server's own safety checks still take only their buttons, and the server now refuses any other answer to them.
- Chat: a step that was still running when an answer paused at its time limit shows as paused, not as a failed step.
- Plugins: official plugins no longer need a separate plugin signing key. The official list in each signed release pins each official package's manifest digest per version and platform; a matching package shows as Official (matches the official list). A later release can withdraw a build: it is turned off at start and refused. The plugin package and list format is frozen as schemaVersion 1. The server reads the official list only from its verified version folder. Korean Admin > Plugins and HWP texts now use 해요체, and the install prompt says that optional permissions start ticked. See docs/PLUGINS.md.

## 0.2.10 — 2026-10-30

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.10).

**Upgrade note:** migrations 318–320 raise the schema reader level to 4. After the update, 0.2.9 cannot open the database. Roll back only from a backup that you made before the update.

- Settings > Apps: a guide shows how to install Trina as an app (PWA) on phones and computers (#9).
- Skills: a skill in a skills/ subfolder is visible only to people who can read that folder. Personal skills live in users/<me>/skills/ and only the owner sees them; they come first in the prompt skill index (#10).
- Chat: when a long conversation reaches the AI only in part (a fresh session gets 40,000 characters of history), the newest answer says so in a small note. Migration 213 (reader 1).
- Chat: an answer that reaches the per-answer limit (tool calls or time) pauses with "이어서 하기" instead of ending as an error; the AI is told where it stopped. Migration 212 (reader 1).
- Chat: messages typed while an answer runs wait under the conversation (edit or remove them) and are sent together when the answer is done; Stop keeps them, paused, with "Send now".
- Add plugins (Admin > Plugins, company scope, owners/admins): signed packages with a permission prompt, install from a file or the official list, turn on/off, update, roll back, remove, all audited. HWP preview becomes the first plugin and still needs its release gate; HWP text reading and the write guard stay built in. Default release bundles carry no renderer or plugin package. See docs/PLUGINS.md.
- Third safe-ops review: retain direct search for empty quarantine ledgers with a durable first-publication guard; bind Office search caches to source/text hashes. Migration 320 requires reader 4. Existing quarantined tenants retain immutable input admission.

### Safe operations 1A — second review fixes

- Admit immutable, hash-leased search inputs before raw/CP949 ripgrep, Office sidecar search and semantic embedding; keep quarantine active with the feature off.
- Narrow policy epoch UPDATE triggers to changed authority fields; keep revocation/restore detection while excluding session and sync accounting. New migrations 318–319 require reader 3.
- Document bounded search snapshots, conflicting-registration retry and offline crash-lease recovery. Independent release approval remains pending.

- Security re-review: exclude quarantined files from semantic ingestion and historical browser previews; index durable safe-ops lookups. Require explicit versioned reads of grep-only sources before publication.

- Safe operations 1A review fixes (default off): generated files are download-only; native no-replace publication,
  durable approval/source/cleanup records, fail-closed workflow budgets and Linux openat2 mount-safe sources.
  ko/en/id/ja/es quarantine notices; older schema readers must restore matching pre-enable DB and files to roll back.

- Safe operations 1A (opt-in, qualified Linux): image pixels with OCR fallback for Claude Code/Codex, bounded PowerPoint with bundled layouts, fresh delivery authorization, and isolated output validation. Uploaded templates, ZIP and the new Excel writer remain deferred.
- Fix desktop worker startup so offline recovery can initialize without hanging; retain the browser frame security checks.

- Refresh the desktop team name and identity after sign-in even when an earlier anonymous lookup is still pending.

- Keep experimental HWP previews disabled and exclude their native runtime from default release bundles pending licence/platform review; document Debian 12 availability in System and installation guidance. Restrict HWP macOS file reads to runtime and authorized job inputs.

- Add guarded HWP/HWPX server PNG previews and the AI `hwp_render` page tool, with pinned engine/fonts and original downloads.

- Add Japanese (日本語) and Spanish (Español) across the app, notifications, offline recovery and desktop, with localized dates and numbers.
### Team-first onboarding / 팀 중심 도입 안내

- Team leads get matching EN/KO/JA/ES entry pages, role examples, realistic permission boundaries and hosted/self-host choices. / 팀장용 4개 언어 안내·업무 예제·권한 경계·호스팅과 직접 설치 경로.
- Evaluators can run `bun run demo` for a loopback-only, model-free fictional team with six loadable starter skills. / 한 명령으로 AI를 끈 가상 팀·스킬 체험.
- Administrators get corrected release filenames, EN/KO Linux/office guides and backup/restore instructions. Both office guides travel with the next ZIP; PDFs are optional. / 파일명 수정·영한 운영 안내·복구 안내, 다음 ZIP에 두 언어 사무실 가이드 포함.
- Connection notices distinguish the existing default-on setting from provider authorization. No default is changed. / 기본 켜짐과 제공사 사용 허가를 구분하며 설정 기본값은 바꾸지 않습니다.

Real AI screenshots and full replacement-host recovery still need authorized operational validation. HWP preview remains off and its release gate is unchanged. These source changes do not publish new installers. / 실 AI 화면·새 장비 전체 복구는 별도 검증이 필요합니다. HWP 미리보기는 기본 꺼짐과 기존 출시 조건을 유지하며, 이 소스 변경만으로 새 설치 파일을 배포하지 않습니다.

## 0.2.9 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.9).

- Files: search the contents of files (text, PDF and Office through the text cache, Korean CP949 too) with the same
  permissions as the person. Office documents that are not indexed yet are indexed in the background, fairly per person.
- Files: HEIC/HEIF photos from iPhones show in the preview (converted on the server, with limits per person).

## 0.2.8 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.8).

- Shared subscriptions are on by default. One team connection that an admin adds lets the whole team use the AI; a
  person who adds their own connection uses it first.
- The note on the shared-subscription setting is shorter and easier to read.

## 0.2.7 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.7).

- Files: a file that has no preview (HWP, HWPX, ZIP and others) opens a panel with a notice and a Download button. It
  does not download at once. Spreadsheet previews say when only the first 5,000 rows show, and mark hidden sheets.
- The AI reads Word headers, footers and comments, PowerPoint speaker notes and chart values, and Korean CP949/EUC-KR
  text files. The AI does not edit a file in a legacy encoding; it can write a UTF-8 copy.
- New chat home shows the team's popular skills.
- Chat titles hide key-like strings such as test API keys.
- The AI tries the write when a folder is read-only, so the server can offer "save in my folder".
- Admin: Korean texts use one name for the owner role; Activity log date filter; owner transfer.
- Team skills: warnings for a broken SKILL.md or a name that does not match its folder; skill suggestions stay in
  the notification inbox.
- make_file xlsx: a cell that starts with "=" and parses as a formula becomes a formula (unsafe functions and external
  links are refused). Artifacts offer "ask the AI to fix it" for build errors too.

## 0.2.6 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.6).

- Linux installer: `--public-host HOST` (the team's public address, for example a Cloudflare Tunnel),
  `--app-connectors` (people connect their own Claude to the server) and `--google-drive-client FILE` (the Google
  Drive OAuth client, in the JSON format that Google Cloud downloads). `repair` and `update` keep the first two.
- App connectors can now be turned on in `server.json` (`appConnectors: true` with `tunnel.host`). The environment
  variable `MYCEL_REMOTE_MCP_ORIGIN` still works and wins.
- Linux: after an update, AI turns had no team tools (files, memory, Drive) until the launcher restarted. The launcher
  now finds the current team-tools bridge for each turn.
- Usage: amounts are labelled as an estimate of the equivalent API cost, not a bill. Each row shows its share in
  percent, and the shares add up to 100%.
- Chat: when the AI model refuses and the turn retries with another model, only the retry's answer stays.
- Chat: the "save in my folder" button after a read-only refusal puts a draft in the composer and does not send it.
- Chat: the notice about a refused write shows only text in the person's language.
- Dialogs opened from a menu (files, chats, credentials) give the focus back to the menu button when they close.
- Members: a cancelled invite leaves the list at once.
- Desktop and web: the offline page uses the person's language.
- Admin › AI engines: Codex shows the version of the CLI that the turns really run.

## 0.2.5 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.5).
The first release that servers get through the Trina update feed (`updates.trina.app`).

- Spreadsheets and Hangul files (xlsx, xls, ods, hwp, hwpx) are read in a separate, limited process. A crafted file
  can no longer slow down or stop the server.
- A stored key or token of the person is hidden as `[hidden key]` in AI answers, steps, chat titles and exports.
- PowerPoint files from the AI: the slide count and speaker notes are checked against the request.
- File history shows who made each version, the current version, and moves and renames.
- Scheduled runs show their real outcome: succeeded, finished with problems, or failed. Problem runs send the
  failure notification.
- Admin › Team settings: the number of days that deleted chats stay in the chat trash.
- API engine: correct cost, clearer errors, status check and label.
- App connector (remote MCP): `upload_file` and `create_upload_link` for uploads from Claude Code and other clients.
- Desktop and admin fixes from QA.

## 0.2.4 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.4).
Also on the Trina update feed since 2026-10-29.

- Voice input is now optional and off by default. Admins choose it in Admin › Team settings › Voice input: OpenRouter
  speech-to-text (cloud, `openai/whisper-large-v3-turbo`, zero data retention requested) with the team's own OpenRouter
  API key, or local whisper on the server (private). Members do not see the mic while voice input is off.
- Upgrade note: teams that used local whisper choose "On this server" once.

## 0.2.3 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.3).
Available on GitHub Releases only; the Trina update feed is not live. Assets include Linux kits (amd64/arm64),
a Mac office server ZIP, the Windows installer, SHA256SUMS and its signature. There is no Mac desktop DMG.

- Personal and team external-service connections: MCP servers and HTTP APIs, with access rules and write approval.
- File operations: select multiple files; AI tools to move, copy and rename files of any type.
- Chat titles generated after the answering AI's response, and team logos used as the tab icon.
- PDF preview data files included for scanned pages and Korean text with non-embedded fonts; WebM previews retain video tracks.
- Clearer scheduled-task dates and one-time task behavior; validation of automatic update windows.
- Language and usability fixes for chat errors, push notifications, offline reloads, keyboard focus, name validation and deletion guidance.
- Codex local-login startup improvements, stricter integration secret handling and write approvals, and renewed identity/file-audience checks.
- Nested PowerPoint distribution notices included. Incomplete voice-provider selection was reverted before this version.

See [design and validation records](docs/DECISIONS.md) for implementation details.

## 0.2.2 — 2026-10-28

[First public release](https://github.com/trina-app/trina-ax/releases/tag/v0.2.2).

- Linux server kits for amd64 and arm64, Mac office bundle, Windows desktop installer, and release checksum/signature files.
- Failed sign-ins from a shared address no longer lock out the whole team.
- Desktop in-app browser cookies and allowed sites are scoped to one person and cleared on sign-out or account changes.
- PowerPoint previews use `@aiden0z/pptx-renderer` (Apache-2.0).
- Linux PDF/Office text extraction works under the systemd service.
- Trina branding, Signal Orange colors and application icons.

The Mac desktop DMG is not included: Apple signing and notarization are pending. Release checksum signatures are
separate from operating-system application signing.
