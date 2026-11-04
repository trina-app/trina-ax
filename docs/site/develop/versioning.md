---
title: Versioning
description: How Trina AX picks version numbers with Semantic Versioning 2.0.0, and how every pull request states its impact.
---

Versions follow [Semantic Versioning 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH`.

## Which number to raise

| What changed | Raise | Example |
|---|---|---|
| Only backward-compatible bug fixes. Nothing new, nothing looks or works differently. | PATCH | 0.2.21 → 0.2.22 |
| A backward-compatible feature or a visible UI/UX change, or something marked deprecated. PATCH goes to 0. | MINOR | 0.2.22 → 0.3.0 |
| Something that worked for an installed team stops working unless they act. MINOR and PATCH go to 0. | MAJOR | 1.4.2 → 2.0.0 |

## Rules

- **A release** takes the highest level of everything merged since the last tag.
- **Every pull request** states its version impact: `patch`, `minor`, `major` or `none` (docs or tests only), with one reason.
- **While the version is 0.x**, a breaking change may ship as MINOR, but the release note must say plainly what breaks and what to do. From 1.0.0 it must be MAJOR.
- **Pre-releases** use `X.Y.Z-beta.N` or `X.Y.Z-rc.N` and go to the beta channel. `1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`.
- **A released version never changes.** A fix is a new version. Tags are never moved.

## What counts as the public API

A change to any of these can affect installed teams:

- The HTTP API, including what desktop apps, phone apps and the MCP connector need from the server
- The commands `mycel-ctl` and `teamax`
- Plugin, skill (`SKILL.md`) and connection formats
- Settings people chose: team settings, `server.json`, `MYCEL_*` variables
- Data on disk and in the database, and the team folder layout
- The update feed format

Source of truth: [`docs/RELEASE-CI.md`](../../RELEASE-CI.md), section "Version numbers".
