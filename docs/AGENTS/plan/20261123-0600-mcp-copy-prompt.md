# Trina AX MCP settings: a clearer lead and a ready prompt to copy

- Date (UTC): 2026-11-23 06:00
- Branch: `feat/mcp-copy-prompt`
- Status: done
- Where: web (Settings › Trina AX MCP, `components/integrations/AiAppConnect.tsx`, i18n). Why: the page explained too little for people who are not developers (docs/REPOSITORY-RULES.md)
- Version impact: patch, new wording and a copy button, no API or data change

## Goal

The owner found Settings › Trina AX MCP too thin: "이 앱들에서 내 권한 그대로 팀 파일을 써요." does not say what it is for,
and the terminal steps are hard for someone who is not a developer. People should read what it does in one line, and
for agent apps copy one ready prompt, paste it into the app, and let the app do the setup.

## Scope

In:
- `aiApps.lead`: one or two plain sentences with an example ask.
- Connect dialog for Claude Code, Codex and Other apps: one "Copy prompt" button above the steps. The prompt holds this
  server's real command (the same builders the steps show, moved into exported functions so steps and prompt cannot
  drift), says how to finish sign-in (`/mcp` for Claude Code, `codex mcp login` for Codex) and asks the app to check by
  listing the team folder. The steps stay below for people who want to do it by hand.
- Connect dialog for Claude: the steps stay (a prompt cannot add a connector there); after them a "Try this" example
  ask with Copy.
- Strings in en (source), ko and the other four languages; docs/site/agents/mcp-connector.md one sentence.

Out: a Copy prompt on the page rows (the dialog is leaner: one button per row stays, and the prompt sits next to the
steps it replaces), changes to the commands themselves, the admin page.

## Steps

1. Export `connectorCommands(resource)` (add, login) and `connectPrompt(app, resource, t)` / `tryPrompt` from
   AiAppConnect.tsx; the steps use the same commands.
2. `CopyButton` (text button, Copied for 1.5 s) for the prompt; `CopyLine` for Try this.
3. i18n keys in en.ts, ko.ts, id/ja/es/zh; `bun run check:i18n`.
4. Unit test `web/test/unit/ai-app-prompt.test.ts`: each app's prompt has the real URL, server name and command.
5. Screenshots 1440/390, light/dark, ko/en on a local dev server.
6. changes/mcp-copy-prompt.md; typecheck, web unit tests, check:prepush; PR into dev.

## Decisions

None.

## Risks

Prompts are text sent to an AI: id/es words follow the voice rules (Anda, usted). Claude Code loads a new MCP server only
in a new session, so the prompt tells the person to start it again before `/mcp`. Phones do not show the dialog (the
page says to set up on a computer), so no phone change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run --cwd web test`, `bun run check:prepush`.

## Result

Built as planned: lead text, Copy prompt (primary button with a one-line hint above the steps) in the Claude Code,
Codex and Other apps dialogs, and a "Try this" line with Copy after the Claude steps (`CopyLine prose`). The commands
moved to `connectorCommands`, which both the steps and the prompts use. Korean prompts avoid a particle after the
product name (`Trina AX` cannot be told by the particle helper). Tests: `web/test/unit/ai-app-prompt.test.ts`, one case
in `web/test/e2e/ai-apps.spec.ts`. Review: the Claude Code command now adds `--scope user` (the default local scope works
only in the folder where it ran), so the step and the prompt work in every folder.
