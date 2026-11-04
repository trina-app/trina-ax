---
title: Local development
description: Set up a development server, run the web app with hot reload, and work with fictional data.
---

You can develop on macOS or Linux. Windows desktop builds exist, but a Windows development server is not supported.

## Tools

| Tool | Version |
|---|---|
| Bun | 1.3.12 (the CI pin) |
| Go | from `native/go.mod` |
| Native build tools | Xcode command-line tools on macOS |
| Optional | ripgrep, poppler and pandoc for document tests |

## First build

```sh
bun install --frozen-lockfile
bun run build:native
bun run typecheck
```

## Run a development server

:::steps
#### Build the web app
```sh
bun run build:web
```

#### Start the dev supervisor
Use a new, short data folder and a free port.
```sh
TEAM_AX_DEV_DIR="$HOME/.trina-dev-new" TEAM_AX_DEV_PORT=19761 bun run dev --no-relay
```

#### Seed fictional data (optional)
In a second terminal, before you create a team:
```sh
TEAM_AX_DEV_DIR="$HOME/.trina-dev-new" bun run demo:seed --base http://127.0.0.1:19761
```
:::

:::warning
The development server uses your OS user's CLI logins and has no production isolation. Use fictional data only. Stop it with Ctrl-C.
:::

## Work on the web app

```sh
bun run --cwd web dev     # Vite on port 19140
bun run --cwd web mock    # a mock API server for the UI
```

The e2e tests run the web app against the mock server in `web/test/mock/`, so most UI work needs no real server.

## Useful scripts

| Script | What it does |
|---|---|
| `bun run demo` | Model-free demo with a fictional team |
| `bun run dev` | Development supervisor (server, web build, optional relay) |
| `bun run build:native` | Build the Go helpers |
| `bun run build:web` | Build the web app |
| `bun run typecheck` | Type-check server, web and desktop |
| `bun run check:i18n` | Check strings in all five languages |
| `bun run check:docs` | Check the entry docs and this site's links |
| `bun run docs:build` | Build this documentation site |

Next: [run the tests](testing.md).
