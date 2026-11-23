# A run uses the pinned headless browser; the block on unix sockets stays

- Date: 2026-11-23
- Status: accepted
- Supersedes: the line "For chromium use --headless --no-sandbox" of the box_shell text

- **Ask:** an AI chat fetched HyperFrames, built the video and gave up: "the browser stops as soon as it starts". Owner: "이걸 왜 못한다고 하지?"
- **Cause:** srt's seccomp filter refuses `socket(AF_UNIX)`. Debian's chromium aborts on it in ProcessSingleton (`process_singleton_posix.cc:297`). The pinned chrome-headless-shell has no ProcessSingleton and starts in the same run, but a run was never told it exists, and the tool text pointed at chromium. HyperFrames' own download stops too: it does not trust `/`, which shows as another account's in the run's user namespace (it is read-only, not a mount fault).
- **Rule:** on Linux, when the browser group's shell is installed, every run gets `TRINA_BROWSER`, `HYPERFRAMES_BROWSER_PATH`, `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Playwright reads no such variable: the tool text says to pass `executablePath`. The text also says not to download a browser, to use a job for a render, and to offer ffmpeg with the exact error if a render still fails.
- **Security:** seccomp, network, folders and limits do not change. The browser runs as the run's own process, inside the run's sandbox, from read-only `/opt/trina`. Attack A16b checks that a new unix socket, by path or abstract, stays refused.
- **Not done:** a converter-isolation render path (not needed); a `chromium` command that points at the shell.
- **Tests:** `tests/unit/dev-env-srt.test.ts`, `tests/linux/srt-attack.ts` A16b; a real MP4 from a real srt run (see the PR).
- **Version impact:** patch. No root update: the package list does not change.
