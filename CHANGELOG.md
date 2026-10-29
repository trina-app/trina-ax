# Changelog

Published artifacts and authoritative release notes are in [GitHub Releases](https://github.com/trina-app/trina-ax/releases).
This file summarizes user-visible changes; it is not a list of every commit.

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
