# The free-roam demo's Gmail, Drive and Higgsfield are fakes in the server process, and nothing else goes out

- Date: 2026-11-19
- Status: accepted
- Supersedes: none
- Branch: feat/demo-free-roam-b (free-roam demo plan, owner OK 2026-11-19, PR B)

- **Ask:** in the free-roam demo a visitor uses a real instance, with Gmail, Google Drive and Higgsfield connected, but
  without any real account behind them. Nothing a visitor does may leave the machine.
- **Rule:** a demo file with `fakes` (`DemoFile.fakes`, optional `content` folder) turns on `server/src/demo/fakes/` at
  the server's start (main.ts). Then:
  - **Gmail:** the Google Workspace library is a fake that is always ready (no Python program). Its MCP calls
    (google-apps/transport.ts) are answered in the process with the catalog's tool names. A send or a draft is stored in
    `<dataDir>/demo-fakes/state.json` and answered with an id ("Email sent! Message ID: …"); nothing is sent. The send
    still asks on the product's own confirm card, because the tool list marks it as a change.
  - **Google's addresses** (token, revoke, userinfo, Drive v3) are answered by a fake that stands in for every
    `GoogleTransport` (google-drive/client.ts `setDemoGoogleFetch`). Tokens last a year. A Google app refresh is
    answered locally (google-apps/tokens.ts).
  - **Higgsfield:** the MCP connection's address is answered through the `answer` hook of connections/net.ts, with a
    small tool list (generate_image, generate_video, job_display, show_generations, balance). A picture is a canned one
    from `<content>/higgsfield/`, picked by the words of its file name (built-in: a gradient). It comes inline and at a
    download address only the fake answers (tools/download.ts). A video is refused: "Video isn't available in the demo".
  - **Everything else is refused before a name lookup or a socket.** The seams check first (net.ts, web-fetch.ts
    resolveTarget, download.ts, slack/api.ts, proxy/connect.ts). A process-wide backstop (demo/fakes/offline.ts) patches
    global fetch and WebSocket, node:dns and node:dns/promises, net.connect / createConnection, tls.connect and
    http(s).request / get, so a call we did not list is refused too. Loopback and unix sockets still work (the model
    proxy, the gate, the app's own listeners).
  - Content: `<content>/gmail.json` (`{ me, messages }`), `<content>/drive.json` (`{ me, files }`),
    `<content>/higgsfield/*.png|jpg|webp`. Without them, built-in fictional data (Steepling, `.example` addresses).
- **net.ts `answerForTests` becomes `answer`:** the same hook, documented as set only by this server's own code (the
  demo's fakes and offline tests), never from HTTP, a file or model input. It may now say "not mine" (null).
- **Why in-process and not fake servers on ports:** the connection code above the seams (tool lists, cards, external
  data marks, media, refresh) stays exactly the product's. No extra process or port per visitor, and no way for a
  visitor's AI to reach a fake by address.
- **Why a process-wide backstop:** the server has many direct `fetch` and `dns.lookup` calls (update feed, relay,
  push, speech, Slack, plugins, API engines). Each is off in the demo by its own setting, but one missed setting must not
  reach the internet. The backstop is installed only on a demo server with fakes and is removed when it closes.
- **Not covered here:** the engine is another process (the host's egress rules cover it); `Bun.connect` is not patched
  (only the office CLI uses it, on 127.0.0.1).
- **Tests:** tests/unit/demo-fakes.test.ts (every Google, Drive and Higgsfield call answered, a send stored and not
  sent, the confirm card raised, unknown hosts refused with DNS and socket stubs that fail if reached, loopback works,
  the fence goes away on close).
- **Version impact:** none for customers (nothing changes without a demo file with `fakes`).
