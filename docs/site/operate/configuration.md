---
title: Configuration
description: The server.json file, the MYCEL_ environment variables, and the Anthropic-compatible gateway.
---

Use the installer and the Admin screens first. `server.json` is for the operator's deployment settings, not for team documents or secrets.

- The schema is in [`server/src/app-config.ts`](../../../server/src/app-config.ts).
- Environment variables win over the file.
- On Linux the file is `/var/lib/mycel/config/server.json`. Restart with `sudo systemctl restart mycel-server` after a change.

## Common settings

Settings come from two places. Environment variables win over the file.

:::tabs
@tab Environment variables
| Variable | What it does |
|---|---|
| `MYCEL_CONFIG` or `--config` | The server JSON path. Prevents picking another installation by accident. |
| `MYCEL_MODE` | `dev` or `prod`. Changing it alone does not install OS isolation. |
| `MYCEL_HOST`, `MYCEL_PORT` | Where the server listens. Loopback by default. |
| `MYCEL_DATA_DIR`, `MYCEL_TEAM_ROOT` | The database and private runtime folder, and the team-file folder. Keep them separate. |
| `MYCEL_PUBLIC_ORIGINS` | Comma-separated browser origins of the installation. A wrong host or port causes cookie and origin errors. |
| `MYCEL_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. |
| `MYCEL_EXIT_ADDRESS_CHECK` | `off` stops the server asking the release feed for its own public address. Then every web address the AI opens needs a person. |

On Linux, put environment overrides in `/etc/default/mycel`.

@tab server.json
| Key | What it does |
|---|---|
| `engine.authMode` | `local-login` uses the OS user's CLI login. `managed` uses AI connections behind the model proxy. |
| `engine.credentialKinds` | Narrows which connection kinds the team may add. |
| `engine.anthropicGateway` | Runs Claude Code on other models. See below. |
| `appConnectors` | `true` with `tunnel.host` turns on the [MCP connector](../agents/mcp-connector.md). |
| `relay`, `tunnel`, `update` | Address and update-feed settings. Keep what the installer wrote. |
:::

[See every variable and key](../reference/environment.md).

## Anthropic-compatible gateway

Claude Code can answer with other companies' models through an address that speaks Anthropic's Messages API: OpenRouter, or the Anthropic-compatible APIs of DeepSeek, Moonshot (Kimi) and Zhipu (GLM). The sandbox and folder permissions stay the same. Only the model behind the proxy changes.

```json
"engine": {
  "authMode": "managed",
  "anthropicGateway": {
    "baseUrl": "https://openrouter.ai/api",
    "label": "OpenRouter",
    "models": { "default": "deepseek/deepseek-v4-pro", "haiku": "deepseek/deepseek-v4-flash" }
  }
}
```

:::warning
With a gateway, every Claude Code request goes to the gateway provider and the model's vendor. Claude subscription connections are off while it is set. Check both providers' terms and tell the team.
:::

Then add the gateway's key in **Admin › AI accounts** (Add account under Claude Code). Full rules: [Configuration](../../CONFIGURATION.md).

## Names you will see

The product is **Trina AX**. Some technical names stay for compatibility:

| Name | Why it stays |
|---|---|
| `mycel`, `MYCEL_*`, `/var/lib/mycel` | Runtime identifiers and the Linux data layout |
| `~/TeamAX`, `teamax` | Office installations and their command |
| `axserver`, `axagent` | Service accounts and file ownership |
| `@mycel/*`, `TEAM_AX_DEV_*` | Source packages and development settings |
