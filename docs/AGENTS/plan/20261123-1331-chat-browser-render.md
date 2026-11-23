# AI runs can start the bundled headless browser (HyperFrames, Puppeteer, Playwright)

- Date (UTC): 2026-11-23 13:31
- Branch: `fix/chat-browser-render`
- Status: done
- Where: Team AX core, `server/src/devenv`. Why: the run environment of the dev environment is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in what a run is told and given; no root update (the browser group is already on the list, and the list does not change)

## Goal

An AI chat that was asked for a HyperFrames video gave up: "the browser stops as soon as it starts". The AI ran Debian's
chromium, which aborts in a run because srt's seccomp filter refuses `socket(AF_UNIX)` (ProcessSingleton). The pinned
chrome-headless-shell has no ProcessSingleton and works in the same run, but nothing tells a run about it.

## Scope

In: the run's environment names the pinned browser; the box_shell text says how to use it and what to offer if a render fails; one attack line that keeps the AF_UNIX block.
Out: any change to seccomp, the network, the folders or the limits of a run; a converter-isolation render path.

## Steps

1. `runEnv`: on Linux, when the pinned browser is installed, set TRINA_BROWSER, HYPERFRAMES_BROWSER_PATH, PUPPETEER_EXECUTABLE_PATH and CHROME_PATH.
2. box_shell text (private and shared): use that browser, never download one, the ffmpeg route if a render really fails.
3. Tests: unit (env, text), attack suite (AF_UNIX still refused), a real MP4 from a real srt run.

## Decisions

docs/decisions/20261123-chat-browser-render.md

## Result

A real srt 0.0.81 run (Debian, arm64) rendered a 3.0 s MP4 with HyperFrames 0.9.85 using only the new environment, with `socket(AF_UNIX)` still refused. Puppeteer works from the variable; Playwright with `executablePath`. Attack suite: 136 attacks, 19 sub-agent cases and 8 work-folder cases held, including the new A16b. amd64 was not run with a browser.
