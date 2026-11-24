# Apps on the computer: Playwright and Chrome DevTools as listed connectors

- Date (UTC): 2026-11-24 08:00
- Branch: `feat/local-app-presets-playwright-devtools`
- Status: done
- Where: shared (`LOCAL_APP_PRESETS`, `LOCAL_APP_TOOLS`), web (`lib/localApps.ts`, `pages/Connectors.tsx`, i18n), logos and notices.
- Version impact: minor (two new cards in Settings › Connectors; no API change)

## Goal

Connector research 2026-11-24, recommendation #6: Playwright MCP and Chrome DevTools MCP are the two most downloaded
MCP servers people run on their own computer (npm, 2026-11-16..22: 11.29M and 2.04M a week). Trina already runs them as
"a program on this computer", but a person had to type the command. They now have their own cards, like Aside and
ego lite.

## Change

- Presets: `npx -y @playwright/mcp@0.0.86` and `npx -y chrome-devtools-mcp@1.13.0`.
  - Pinned: the one-time confirm covers the command, so a new version asks again. Never `@latest`.
  - `-y`: without it npx stops at "Ok to proceed?" on the first run and reads the JSON-RPC as the answer.
  - No `reads`: both mark every tool with `readOnlyHint` (tools/list: 25 and 33 tools).
- `notOn: ['win32']`: on Windows npx is `npx.cmd`, and a `.cmd` does not start with `shell: false` (Node `EINVAL`,
  reproduced on Windows 11 with Node 24). The cards do not show in the Windows desktop app. A typed `.cmd` command has
  the same limit; that is a separate finding.
- Cards: logo, one line and an install line ("Needs Node.js … Not on Windows yet") in the six languages.
- A team may recommend both (`LOCAL_APP_TOOLS`).

## Checked

On the office Mac mini (macOS 26.2, Node from Homebrew), with the spawn options the desktop app uses (`shell: false`,
cwd = home, PATH = the GUI PATH plus `defaultSearchPath` extras) and an empty npx cache:

| Preset | First run (download) | Warm | Tools |
|---|---|---|---|
| Playwright MCP 0.0.86 | initialize 2.1 s | 0.6 s | 25, all with readOnlyHint |
| Chrome DevTools MCP 1.13.0 | initialize 1.3 s | | 33, all with readOnlyHint |

Not checked: a Connect from the desktop app end to end, a slow network (the Settings check's initialize ends at 88 s,
#506), Node installed only through nvm (not on a GUI app's PATH), and the browsers themselves (Playwright downloads its
own; Chrome DevTools needs Google Chrome).

## Tests

`tests/unit/local-app-presets.test.ts`: pinned version and `-y`, `notOn` Windows, no `reads`, unique ids and commands,
every preset recommendable.
