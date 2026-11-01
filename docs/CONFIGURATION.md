# Configuration and retained identifiers

[IT guide](for-admins.md) · [Troubleshooting](TROUBLESHOOTING.md)

Use the installer and Admin settings first. `server.json` is operator-owned deployment configuration; it is not a place for team documents or API secrets. See [the schema](../server/src/app-config.ts) for exact fields. Environment overrides win over the file.

| Setting | Purpose / scope |
|---|---|
| `MYCEL_CONFIG` or `--config` | Explicit server JSON path; prevents selecting another installation accidentally |
| `MYCEL_MODE` | `dev` or `prod`; changing this alone does not install OS isolation |
| `MYCEL_HOST`, `MYCEL_PORT` | Listener; loopback by default. Public access requires configured HTTPS infrastructure |
| `MYCEL_DATA_DIR`, `MYCEL_TEAM_ROOT` | Database/private runtime and team-file roots; preserve ownership and keep them separate |
| `MYCEL_PUBLIC_ORIGINS` | Comma-separated browser origins for the actual installation; wrong host/port causes cookie/origin problems |
| `MYCEL_LOG_LEVEL` | debug/info/warn/error; inspect logs locally and redact before sharing |
| `MYCEL_EXIT_ADDRESS_CHECK` | `off` stops the server from asking the release feed (`https://updates.trina.app/ip`) for its own public address. Without that address (and without a relay that reports it) every web address the AI opens needs a person, and scheduled tasks open none. Admin > System > Diagnostics shows whether the server knows it ("Public address of the server"; never the address) |
| `TEAM_AX_DEV_DIR`, `TEAM_AX_DEV_PORT` | Development supervisor directory and server port; not production installer settings |
| `engine.authMode` | `local-login` uses the OS user's CLI login; `managed` uses configured AI connections behind the proxy |
| `engine.credentialKinds` | Operator can narrow permitted connection kinds; team settings cannot grant forbidden kinds |
| `engine.anthropicGateway` | Self-hosted, managed mode: Claude Code on another company's models through an Anthropic-compatible address (OpenRouter, DeepSeek, Kimi, GLM). See [below](#anthropic-compatible-gateway) |
| `relay`, `tunnel`, `update` | Address and feed configuration; preserve the installer's settings and trust checks |

`engine.modelUpstreams`, fake upstream URLs, native-path overrides and response-validation controls are test/advanced development tools, not recommended onboarding settings. Never point a live credential proxy at an untrusted endpoint. To run Claude Code on other models, use `engine.anthropicGateway` (below), not `modelUpstreams`.

## Anthropic-compatible gateway

The real Claude Code engine can answer with another company's models through an address that speaks Anthropic's
Messages API: OpenRouter, or the Anthropic-compatible APIs of DeepSeek, Moonshot (Kimi) and Zhipu (GLM). The engine
lockdown, the sandbox and every person's folder permissions stay as they are; only the model behind the model proxy
changes. It needs `engine.authMode` `"managed"` (Linux server, role-account Mac); there is no setting for it in the
admin screens. Edit `server.json` (Linux: `/var/lib/mycel/config/server.json`) and restart the server (Linux:
`sudo systemctl restart mycel-server`).

```json
"engine": {
  "authMode": "managed",
  "anthropicGateway": {
    "baseUrl": "https://openrouter.ai/api",
    "label": "OpenRouter",
    "models": { "default": "deepseek/deepseek-v4-pro", "haiku": "deepseek/deepseek-v4-flash" },
    "prices": { "deepseek/deepseek-v4-pro": { "input": 1.6, "output": 3.2 } }
  }
}
```

| key | meaning |
|---|---|
| `baseUrl` | https, without `/v1` (the proxy adds `/v1/messages`, like Claude Code's `ANTHROPIC_BASE_URL`). OpenRouter: `https://openrouter.ai/api`; another provider: the address it documents for Claude Code's `ANTHROPIC_BASE_URL`. |
| `models.default` | required: the model of a turn nobody chose one for. |
| `models.opus`, `models.sonnet`, `models.haiku` | optional: what Claude Code's aliases and its small fast model (side requests) become; a missing one is `default`. |
| `label` | optional: the name the add-connection dialog shows (default: the address's host). |
| `prices` | optional: USD per million tokens per model id, `{ "input", "output", "cacheRead"?, "cacheWrite"? }` (cache prices default to `input`). |

While it is set:

- **Models.** The proxy forwards exactly the ids in `models`; any other id, and any `claude-*` id (Anthropic's own
  name, which a gateway passes on to Anthropic at Anthropic's price), is refused. The file may not name a `claude-*` id
  either; for Claude through OpenRouter use its own id (`anthropic/…`). Admin > AI engines lists these models for Claude
  Code, and the team default model can be one of them.
- **Connections.** Add the gateway's key in Admin > AI connections as "API key for <label>" (20–300 letters, digits,
  `.`, `_`, `-`; never an `sk-ant-` key or token). An OpenRouter key is checked on `GET /api/v1/key`; another gateway's
  on `GET <baseUrl>/v1/models` when that list needs a key, else it is "checked on the first question". A key added for
  the gateway is only ever sent there.
- **Claude subscriptions are off.** Claude subscription connections cannot be added, and existing ones, like Claude API
  keys added for Anthropic, show as "off on this server": nothing is sent with them, not even a check. They are kept and
  work again when the setting is removed (a gateway key is then off). Replacing the key of an Anthropic key connection
  with a gateway key moves that connection to the gateway.
- **Data.** Every Claude Code request (the conversation, the file contents the AI reads, tool results, web searches)
  goes to the gateway provider and from there to the model's vendor, under their terms and in their countries. Check
  both before you turn it on, and tell the team.
- **Cost.** With OpenRouter, the amount it reports it charged (`usage.cost`) counts when it is above 0 (not for
  requests on your own provider key, "BYOK", where it is only OpenRouter's fee). Otherwise the `prices` above. A model
  without a price is counted at the most expensive Claude price (budgets fill early), logged once ("a model has no
  price") and recorded in the audit log (`credential.unknown_price`).
- **Token counting.** A gateway without `/v1/messages/count_tokens` (OpenRouter answers 404) gets that 404 passed back
  to Claude Code as it came; it is not counted as a failure of the connection.
- The server refuses to start when `anthropicGateway` is set together with `modelUpstreams.anthropic` (or
  `modelUpstream`), outside managed mode, or with a model id it cannot take.

## Why names differ from Trina AX

| Identifier | Why it remains |
|---|---|
| `mycel`, `MYCEL_*`, `/var/lib/mycel` | Compatible runtime identifiers and Linux data layout |
| `~/TeamAX`, `teamax` | Existing office installations and command wrapper |
| `_axserver` / `axserver`, engine accounts | Installed service identities and file ownership |
| `app.treesoop.*`, `app.team-ax.*` | Existing launchd labels; renaming would disconnect services |
| `@mycel/*`, `TEAM_AX_DEV_*` | Source package and development interfaces |

These are technical identifiers, not additional products. User-facing name: **Trina AX**. Public update origin: `https://updates.trina.app`. Do not mass-rename paths, database keys or service labels to match branding.
