---
title: Quickstart
description: Run Trina AX on your computer with a fictional team in about 10 minutes, with no AI account.
---

The demo starts a fictional team with six starter skills. AI is off, so you need no AI account.

:::warning
The demo is not a production install. It has no OS isolation. Use fictional data only.
:::

## Before you begin

| You need | Version |
|---|---|
| macOS or Linux | Windows users open a prepared server in a browser |
| Git | any recent version |
| Bun | 1.3.12 (the CI pin) |
| Go | 1.27 or newer |
| Native build tools | Xcode command-line tools on macOS |
| A free port | 19760 |

## Start the demo

:::steps
#### Clone and install
```sh
git clone https://github.com/trina-app/trina-ax.git
cd trina-ax
bun install --frozen-lockfile
```

#### Start the demo
```sh
bun run demo
```
Leave this terminal running. It builds, starts on http://127.0.0.1:19760 and seeds the fictional team.

#### Sign in
Open http://127.0.0.1:19760 and sign in as `alice` with `teamax-demo-1`. The other accounts are `bob`, `admin1` and the owner `dion`. The password is public on purpose.

#### Check folder permissions
Open **Files → shared → 팀-용어집.md**. Then sign in as `bob` in a private window. Bob sees the finance group, but not the marketing group.
:::

:::tip
Use `127.0.0.1`, not `localhost`. They are different cookie origins, so sign-in would repeat.
:::

## Change the port, data folder or language

```sh
bun run demo --port 19761 --data "$HOME/.trina-evaluation-new" --locale ko
```

The data folder must not exist yet. A busy port or an existing folder is refused.

## Try the AI (optional)

The demo cannot call AI. For a development server that uses your own Claude Code or Codex login, stop the demo first and run:

```sh
TEAM_AX_DEV_DIR="$HOME/.trina-ai-evaluation-new" TEAM_AX_DEV_PORT=19761 bun run dev --no-relay
# In a second terminal, before you create a team:
TEAM_AX_DEV_DIR="$HOME/.trina-ai-evaluation-new" bun run demo:seed --base http://127.0.0.1:19761
```

:::warning
In development mode the engines run as your OS user, with no production isolation. Connect only accounts you may use this way.
:::

## Share a preview on your tailnet (optional)

To let teammates on your Tailscale network click through a preview, run a development server with the AI turned off and an extra allowed origin.

:::steps
#### Write a config with the AI off
Save this as `preview.json` in a new, short folder such as `~/.trina-preview`. It is the same config the demo writes.
```json
{"mode":"dev","listen":{"host":"127.0.0.1","port":19780},
 "engine":{"authMode":"local-login","claudeBin":"/nonexistent/trina-demo-no-ai","codexBin":""},
 "relay":{"url":null,"officialAvailable":false},"update":{"feedUrl":null,"auto":false}}
```

#### Start the server with your tailnet origin
Replace `<your-tailnet-host>` with the machine's Tailscale name.
```sh
MYCEL_CONFIG="$HOME/.trina-preview/preview.json" MYCEL_HOST=127.0.0.1 \
TEAM_AX_DEV_DIR="$HOME/.trina-preview" TEAM_AX_DEV_PORT=19780 \
MYCEL_PUBLIC_ORIGINS="https://<your-tailnet-host>:8443,http://127.0.0.1:19780" \
bun scripts/dev.ts --no-relay
```

#### Seed the fictional team
```sh
TEAM_AX_DEV_DIR="$HOME/.trina-preview" bun run demo:seed --base http://127.0.0.1:19780
```

#### Serve it on the tailnet only
```sh
tailscale serve --bg --https=8443 http://127.0.0.1:19780
```
Use `tailscale serve`, never `tailscale funnel`: funnel makes it public.

#### Change the demo passwords
The demo password is public. Change it for every account before you share the address.
:::

To stop: press Ctrl-C in the server terminal, then run `tailscale serve --https=8443 off`.

## Next steps

:::cards cols=2
- icon=book-open | [Key concepts](key-concepts.md) | The words the rest of these docs use.
- icon=terminal | [Local development](../develop/local-development.md) | Build, test and change the code.
:::
