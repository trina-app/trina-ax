# Changelog

Published artifacts and authoritative release notes are in [GitHub Releases](https://github.com/trina-app/trina-ax/releases).
This file summarizes user-visible changes; it is not a list of every commit.

## Unreleased

- Chat: an answer that reaches the per-answer limit (tool calls or time) pauses with "이어서 하기" instead of ending as an error; the AI is told where it stopped. Migration 212 (reader 1).
- Chat: messages typed while an answer runs wait under the conversation (edit or remove them) and are sent together when the answer is done; Stop keeps them, paused, with "Send now".
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
