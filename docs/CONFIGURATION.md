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
| `MYCEL_EXIT_ADDRESS_CHECK` | `off` stops the server from asking the release feed (`https://updates.trina.app/ip`) for its own public address. Without that address (and without a relay that reports it) every web address the AI opens needs a person, and scheduled tasks open none |
| `TEAM_AX_DEV_DIR`, `TEAM_AX_DEV_PORT` | Development supervisor directory and server port; not production installer settings |
| `engine.authMode` | `local-login` uses the OS user's CLI login; `managed` uses configured AI connections behind the proxy |
| `engine.credentialKinds` | Operator can narrow permitted connection kinds; team settings cannot grant forbidden kinds |
| `relay`, `tunnel`, `update` | Address and feed configuration; preserve the installer's settings and trust checks |

`engine.modelUpstreams`, fake upstream URLs, native-path overrides and response-validation controls are test/advanced development tools, not recommended onboarding settings. Never point a live credential proxy at an untrusted endpoint.

## Why names differ from Trina AX

| Identifier | Why it remains |
|---|---|
| `mycel`, `MYCEL_*`, `/var/lib/mycel` | Compatible runtime identifiers and Linux data layout |
| `~/TeamAX`, `teamax` | Existing office installations and command wrapper |
| `_axserver` / `axserver`, engine accounts | Installed service identities and file ownership |
| `app.treesoop.*`, `app.team-ax.*` | Existing launchd labels; renaming would disconnect services |
| `@mycel/*`, `TEAM_AX_DEV_*` | Source package and development interfaces |

These are technical identifiers, not additional products. User-facing name: **Trina AX**. Public update origin: `https://updates.trina.app`. Do not mass-rename paths, database keys or service labels to match branding.
