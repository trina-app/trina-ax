# `chromium` in a run starts the pinned browser

- Date: 2026-11-23
- Status: accepted
- Supersedes: the guidance-only part of [A run uses the pinned headless browser](20261123-chat-browser-render.md)

- **Ask:** QA TC-8350: "take a screenshot of https://example.com" failed twice. The AI ran Debian's `chromium`, which aborts in a run, and said it was blocked. TC-8351: dumps of those crashes stayed in the person's home with the run's proxy login in them.
- **Measured:** the pinned engine (Claude Code 2.1.305) cuts a tool description at 4,096 characters, by a local stand-in API that recorded the request; the API engine cuts at 1,024 (`api-agent.ts`). The private `box_shell` text is longer than both, and the browser rule sat far into it.
- **Rule:** on Linux with the pinned shell and not `MYCEL_HTML_PDF_BROWSER=none`, the server writes `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable` and `chrome` into its bin folder, first on a run's PATH and read-only there. They start the shell with the flags a run needs and no crash reporting. `TRINA_BROWSER`, `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH` name that command; HyperFrames keeps the real shell. A short rule is now inside the first 1,024 characters of the tool text.
- **Proxy login:** Chromium ignores a login in a proxy address. When the command names no proxy, a relay for that one browser listens on 127.0.0.1 in the run's own network namespace, forwards only to the run's proxy (every site rule stays there), adds the login, and ends with the browser. The login is only in the environment, never in an argument.
- **Crash dumps:** no crash reporting in the command; Chromium's crash folders in a private home are removed when the run ends, with the profile rules (no link followed, not while another live run may use them). A shared chat's home goes as a whole already.
- **Security:** seccomp, network rules, mounts and limits do not change. The relay has the rights of the run that started it and adds no new destination. Attacks BR8-BR12.
- **Not done:** the rest of the private `box_shell` text is still longer than 4,096 characters, so its last part does not reach the AI (a separate change).
- **Version impact:** patch. No root update: the package list does not change.
