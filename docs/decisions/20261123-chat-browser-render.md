# A run uses the pinned headless browser; the block on unix sockets stays

- Date: 2026-11-23
- Status: accepted
- Supersedes: the line "For chromium use --headless --no-sandbox" of the box_shell text

- **Ask:** an AI chat fetched HyperFrames, built the video and gave up: "the browser stops as soon as it starts". Owner: "이걸 왜 못한다고 하지?"
- **Cause:** srt's seccomp filter refuses `socket(AF_UNIX)`. Debian's chromium aborts on it in ProcessSingleton (`process_singleton_posix.cc:297`). The pinned chrome-headless-shell has no ProcessSingleton and starts in the same run, but a run was never told it exists, and the tool text pointed at chromium. HyperFrames' own download stops too: it does not trust `/`, which shows as another account's in the run's user namespace (it is read-only, not a mount fault).
- **Rule:** on Linux, when the browser group's shell is installed, every run gets `TRINA_BROWSER`, `HYPERFRAMES_BROWSER_PATH`, `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Playwright reads no such variable: the tool text says to pass `executablePath`. The text also says not to download a browser, to use a job for a render, and to offer ffmpeg with the exact error if a render still fails.
- **Remote pages:** the run's proxy takes a login from the `HTTPS_PROXY` address, and Chromium ignores a login in a proxy address, so a page answers 407 until the program logs in (Puppeteer `page.authenticate`, Playwright `proxy`; the tool text gives both and says never to print the values). With it, an allowed site is 200, a site off the list 403 over http and `ERR_TUNNEL_CONNECTION_FAILED` over https. HyperFrames fetches a composition's remote files by itself (checked with a remote script, image and CSS background).
- **Off switch:** `MYCEL_HTML_PDF_BROWSER=none` also means no browser in runs: no variables, and the text says there is none.
- **Leftovers:** a killed browser's profile in a private chat's TMPDIR is removed when the run ends, unless another live run can write that folder, or a run of the same person is tracked again after a server restart (its tracked folders do not name the TMPDIR, so this fails closed) (`browser-profiles.ts`; a link is never followed).
- **Security:** seccomp, network, folders and limits do not change. The browser runs as the run's own process, inside the run's sandbox, from read-only `/opt/trina`. Attack A16b checks that a new unix socket, by path or abstract, stays refused; BR1-BR7 run the real browser against the proxy rules and a denied file.
- **Not done:** a converter-isolation render path (not needed); a `chromium` command that points at the shell.
- **Tests:** `tests/unit/dev-env-srt.test.ts`, `tests/linux/srt-attack.ts` A16b and BR1-BR7; a real MP4 from a real srt run (see the PR).
- **Version impact:** patch. No root update: the package list does not change.
