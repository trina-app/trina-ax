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

In: the run's environment names the pinned browser; the box_shell text says how to use it and what to offer if a render fails; the proxy login for remote pages; the admin's off switch; a sweep of a killed browser's profile; attack cases with the real browser.
Out: any change to seccomp, the network, the folders or the limits of a run; a converter-isolation render path.

## Steps

1. `runEnv`: on Linux, when the pinned browser is installed, set TRINA_BROWSER, HYPERFRAMES_BROWSER_PATH, PUPPETEER_EXECUTABLE_PATH and CHROME_PATH.
2. box_shell text (private and shared): use that browser, never download one, the ffmpeg route if a render really fails.
3. Tests: unit (env, text), attack suite (AF_UNIX still refused), a real MP4 from a real srt run.

## Decisions

docs/decisions/20261123-chat-browser-render.md

## Result

A real srt 0.0.81 run (Debian, arm64) rendered a 3.0 s MP4 with HyperFrames 0.9.85 and a remote image, using only the new environment, with `socket(AF_UNIX)` still refused. With the proxy login, Puppeteer and Playwright load an allowed page (200); a site off the list is 403. Attack suite on arm64: 143 attacks (A16b, BR1-BR7 with the real browser), 19 sub-agent and 8 work-folder cases held. amd64 is not verified here: bwrap cannot make its namespaces under Docker's emulation. CI's Linux attack job runs both architectures on the push to dev, not in the merge queue.
