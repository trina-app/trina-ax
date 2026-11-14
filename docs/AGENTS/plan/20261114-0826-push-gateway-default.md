# Trina team servers send phone pushes through push.trina.app by default

- Date (UTC): 2026-11-14
- Branch: `feat/push-gateway-default`
- Status: in progress
- Where: `editions/trina/branding/service.json`, `scripts/edition-service.ts`, `shared/src/service-hosts.ts`,
  `server/src/app-config.ts`, Settings › Notifications copy. Why: edition addresses live in the edition's service.json
  and are written into `SERVICE_HOSTS` (docs/EDITION-BRANDING.md); the server reads its config in app-config.ts.
- Version impact: minor: Trina team servers turn phone push on without a setting; no API or data change.

## Goal

The store app's Apple and Google keys live only on push.trina.app, so a self-hosted Trina team server sends no phone
push until its operator finds and sets `MYCEL_PUSH_GATEWAY`. The owner (2026-11-14, "저거 해보자"): Trina team servers
use push.trina.app by default, so self-hosted teams with the store app get phone pushes.

## Scope

In:
- `service.json` gets `pushGatewayUrl` (optional; `""` = no default). Trina: `https://push.trina.app`. The neutral core
  keeps `""`.
- app-config: unset env and no `push.gatewayUrl` in server.json → the edition default, on installed servers (`mode:
  "prod"`) and office Macs only; a developer's dev server keeps none, so local runs and tests never reach the real
  gateway.
- Explicit off: `MYCEL_PUSH_GATEWAY=''` or `off`; `push.gatewayUrl` `null`, `""` or `"off"` in server.json. Unset env
  falls through to server.json, then the default.
- Settings › Notifications "off" line: true whether nothing is set or the operator turned it off.
- Docs: DECISIONS, push-gateway/README.md, install docs (docs/INSTALL-LINUX*.md, docs/site/operate/install.md),
  EDITION-BRANDING, mobile docs; changes fragment.

Out: a UI switch for the gateway; changes to the gateway itself.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/push-native.test.ts,
tests/unit/edition-service.test.ts.
