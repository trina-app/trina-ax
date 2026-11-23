# The obvious browser command works in an AI run

- Date (UTC): 2026-11-23 16:02
- Branch: `fix/box-browser-default`
- Status: done
- Where: Team AX core, `server/src/devenv`. Why: the run environment of the dev environment is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in what a run is given and told; no root update (the package list does not change)

## Goal

QA TC-8350: "take a screenshot of https://example.com" still failed. The AI ran Debian's `chromium`, which aborts in a run, and said it was blocked. The rule that names the working browser sits about 3,000 characters into the box_shell text. Measured on the pinned engine (Claude Code 2.1.305): a tool description is cut at 4,096 characters; the API engine cuts at 1,024 (`api-agent.ts`).
QA TC-8351: crash dumps of a failed Chromium stay in the person's home with the run's (dead) proxy login in them.

## Scope

In: `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable` and `chrome` in the server's read-only run bin folder start the pinned shell, with the flags a run needs and the proxy login handled by a small relay inside the run; a short rule in the first 1,024 characters of the tool text; no crash reporting; dumps swept at run end.
Out: any change to seccomp, the network rules, mounts or limits.

## Steps

1. Wrapper and relay, written by the server like the git wrapper; removed when the browser is off (`MYCEL_HTML_PDF_BROWSER=none`).
2. `TRINA_BROWSER`, `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH` name the wrapper; HyperFrames keeps the real shell.
3. Short rule at the top of the text, with a test on its position.
4. Sweep crash dumps with the profile rules.
5. Real srt run, attack cases, unit tests.

## Decisions

docs/decisions/20261123-box-browser-default.md

## Result

In a real srt 0.0.81 run (Debian, arm64): plain `chromium --headless --screenshot` of an allowed site wrote a 141 KB PNG; all five names work; Puppeteer with a default launch and Playwright with `executablePath: TRINA_BROWSER` load an allowed page; a site off the list stays refused; HyperFrames still renders an MP4; no relay is left after the browser ends. amd64 was not run here.
