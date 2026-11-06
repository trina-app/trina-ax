---
title: Testing
description: Which checks to run for which change, and how the test suites are organized.
---

Run the checks that match your change first. The full suites have extra OS and account needs.

## Checks by change

| You changed | Run |
|---|---|
| Any TypeScript | `bun run typecheck` |
| Server code | `bun run test:unit`, or the related files in `tests/unit/` |
| Web code | `bun run test:web`, `bun run build:web`, then the related e2e specs |
| App strings | `bun run check:i18n` |
| Docs | `bun run check:docs` and `bun run docs:build` |
| Native Go code | `bun run build:native`, and `go test` in `native/` |

## Test suites

| Suite | Where | Command |
|---|---|---|
| Server unit | `tests/unit/` | `bun run test:unit` |
| Web unit | `web/test/unit/` | `bun run test:web` |
| Web e2e (Playwright) | `web/test/e2e/` | `bun run e2e:web` |
| Fast fuzz | `tests/fuzz/` | `bun run test:fuzz:fast` |
| Relay | `tests/relay/` | `bun run test:relay` |
| Linux install and isolation | `tests/linux/` | CI on systemd hosts |

To run one e2e spec:

```sh
bun run --cwd web build
cd web && bunx playwright test -c playwright.config.ts test/e2e/a11y.spec.ts
```

## Accessibility

`web/test/e2e/a11y.spec.ts` runs an axe check on the main screens in light and dark themes and at phone width. Add new screens to it.

## Good habits

- Use fictional data in fixtures and screenshots. Never commit keys or customer data.
- Compare a failure with an untouched checkout before blaming your change. Some tests need converters or native helpers.
- Do not run real-engine, deployment or account-changing tests without the right credentials and permission.

CI runs typecheck, `check:docs`, native builds, unit, fuzz, web and relay tests, and Linux install tests. See [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml).
