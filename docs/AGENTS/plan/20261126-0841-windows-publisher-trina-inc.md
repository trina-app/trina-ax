# Windows publisher shows "Trina Inc.", not "TreeSoop"

- Date (UTC): 2026-11-26 08:41
- Branch: `fix/windows-publisher-trina-inc`
- Status: done
- Where: desktop/package.json, desktop/electron-builder.config.ts, tests/unit. Why: the installer is signed by Trina Inc. but Apps & features names TreeSoop.
- Version impact: patch (installer metadata text only; no API, data or format change)

## Goal
Windows "Apps & features" Publisher, the exe's CompanyName and LegalCopyright, and the NSIS installer name Trina Inc., the
same as the Authenticode signer. electron-builder takes all of these from `author` in desktop/package.json (`TreeSoop`)
and `copyright` in electron-builder.config.ts.

## Scope
In: `author`, `copyright` (also the Mac Info.plist copyright), Linux `.deb` maintainer, a unit test.
Out: `com.treesoop.mycel` app id (identity, must not change), treesoop.com team-address domain, desktop/package.json
`homepage`, LICENSE/NOTICE, the Microsoft Store identity Publisher CN (already "Trina Inc." display name; CN comes from Partner Center).
Not touched: desktop/build.ts (batch #629/#632).

## Steps
1. Set author and copyright to Trina Inc., maintainer to `Trina Inc. <contact@trina.app>`.
2. Test: the publisher strings are Trina Inc. and none says TreeSoop.

## Decisions
none

## Risks
None for updates: the NSIS GUID comes from appId, not the publisher.

## Tests
`bun run typecheck`, `bun run check:prepush`, desktop/branding unit tests.

## Result
author, copyright and the .deb maintainer now say Trina Inc.; test added in tests/unit/e-desktop-linux.test.ts.
