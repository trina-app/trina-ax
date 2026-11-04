---
title: Environment and server.json
description: The environment variables and server.json keys operators and developers set.
---

Environment variables win over `server.json`. The full schema is in [`server/src/app-config.ts`](../../../server/src/app-config.ts).

## Environment variables

| Variable | Purpose |
|---|---|
| `MYCEL_CONFIG` | Path of the server JSON |
| `MYCEL_MODE` | `dev` or `prod` |
| `MYCEL_HOST`, `MYCEL_PORT` | Listen address and port. Loopback by default. |
| `MYCEL_DATA_DIR` | Database and private runtime folder |
| `MYCEL_TEAM_ROOT` | Team-file folder |
| `MYCEL_PUBLIC_ORIGINS` | Comma-separated browser origins of the installation |
| `MYCEL_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `MYCEL_EXIT_ADDRESS_CHECK` | `off` stops the public-address check against the release feed |
| `MYCEL_REMOTE_MCP_ORIGIN` | Public origin for the [MCP connector](../agents/mcp-connector.md). Wins over `server.json`. |
| `MYCEL_RELAY_URL` | Relay address for development (`bun run dev:server:relay`) |
| `TEAM_AX_DEV_DIR`, `TEAM_AX_DEV_PORT` | Development supervisor folder and port. Not for production. |

Other `MYCEL_*` variables in the code are for tests, packaging or internal helpers. Do not set them in production.

On Linux, put environment overrides in `/etc/default/mycel`.

## server.json keys

| Key | Purpose |
|---|---|
| `mode` | `dev` or `prod` |
| `listen.host`, `listen.port` | Where the server listens |
| `engine.authMode` | `local-login` (the OS user's CLI login) or `managed` (AI connections behind the proxy) |
| `engine.credentialKinds` | Narrow which AI connection kinds the team may add |
| `engine.anthropicGateway` | Claude Code on other models. [See configuration](../operate/configuration.md). |
| `appConnectors` | `true` with `tunnel.host` turns on the MCP connector |
| `relay`, `tunnel` | Public address settings |
| `update` | Update feed and automatic updates |

:::warning
`engine.modelUpstreams`, fake upstreams and native-path overrides are for tests. Never point a live credential proxy at an untrusted address.
:::
