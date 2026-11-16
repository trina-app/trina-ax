# A request through the public address keeps Bun's own request object; only its URL is set to https

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/tunnel-request-body-memory (P0: uploads through the Cloudflare Tunnel took the Linux QA server down,
  build cb360fb2e, 2026-11-16)

- **What broke:** `server/src/http/tunnel.ts` built `new Request("https://<host>/...", req)` around every request that
  came through the public address (cloudflared on the server delivers it to the loopback app port), so the app saw the
  https URL. Under Bun 1.3.12 (the Bun that server builds ship) the copy's body is a JavaScript stream in which every
  socket read becomes its own buffer that garbage collection does not count, and much of it is never given back after
  an early 413. cloudflared forwards a chunked body in small pieces (median about 5 KB, many 1415 bytes), which makes
  it far worse. On the QA server (4 GB, no swap) one chunked 100 MB upload took the server from 209 MB to 1.3 GB, still
  1.3 GB 20 minutes later; three hung the machine. The same requests on the server's own address left nothing.
- **Measured locally** (Bun 1.3.12, the real app through `Bun.serve` + `directFetch` as `main.ts` wires them, multipart
  `POST /api/files/upload`, chunked 1415-byte writes paced one per timer turn, memory after 6 forced collections):
  | request | own address | public address, before | public address, after |
  |---|---|---|---|
  | 3 MB | +17 MiB | +550 MiB | +2 MiB |
  | 20 MB | +4 MiB | +3,142 MiB | +1 MiB |
  | 52 MB → 413 (unpaced writes) | +7 MiB | +60 MiB | +1 MiB |
- **Rule 1 (no copy):** `directFetch` hands the app the request object Bun gave it. For a request through the public
  address `withPublicUrl` sets an own, fixed `url` property on that object (`Object.defineProperty`, not writable, not
  configurable) that shadows `Request.prototype.url`. Every reader of the URL — Hono's routing and `c.req.url`, the
  `__Host-` Secure cookie name (`auth/service.ts`), the CSRF and WebSocket Origin checks (`http/middleware.ts`,
  `realtime/hub.ts`), the https redirect, invite links (`system/connection.ts`), remote MCP — reads exactly the same
  https string as before, and the body stays Bun's own. Bun upgrades a WebSocket on the same object, so
  `env.upgradeReq` is only set in the fallback. Checked on Bun 1.3.12 and 1.4.4: routing, params, query, `new
  URL(req.url)`, `server.upgrade`, and `new Request(req).url` all see the https URL. Only Bun's native `req.clone()`
  would drop it; nothing in `server/src` clones a request, and a test keeps it that way.
- **Why not a separate "public URL" in the request context:** the URL is read from the Request object in about fifteen
  security-relevant places, several of them outside Hono's context (`sessions.resolve(req)`, the hub's upgrade
  checks). Moving each to a context value is a wide change in which one missed place silently turns the Secure cookie
  or the CSRF origin back to http. Setting the property keeps every place as it was.
- **Fallback:** if a Bun ever refuses the property (`req.url` not the https URL afterwards), `withPublicUrl` warns once
  and makes the old copy: correct, but with the memory cost. Never the http URL.
- **Rule 2 (end the connection after an early refusal):** Bun 1.3.12 ignores `Connection: close` on a response. After
  a 413 it keeps the socket, reads and throws away whatever the client still sends (measured: 227 MB in 8 s, still
  open) and then serves the next request on it. A request refused before its body ended is now marked
  (`endConnectionAfter`: `boundedBody`'s two limits, a refused multipart upload in `http/route.ts`, the upload link's
  declared size, a room app's body limit and body timeout), and `directFetch` then calls `server.timeout(req, 1)`: the
  socket ends about 4 s after the answer on 1.3.12 (at once on 1.4). Only marked requests: the timeout also cuts a
  response still being sent, so `Connection: close` alone does not trigger it. Requests refused without reading the
  body (401, 403, 421) are not marked; after rule 1 the body Bun discards costs no memory.
- **Not affected:** hosted teams reach their server through the relay (`server/src/relay-client/client.ts`), which
  builds its Request around its own pull stream of relay frames, not around a Bun request; measured the same shape on
  Bun 1.3.12: 9 MB in 1415-byte pieces +27 MiB, 90 MB +55 MiB, an early stop +17 MiB. The office Tailscale listener and
  the LAN TLS port never took the copy; they get rule 2.
- **Safety net:** the Linux server unit's memory limit is a separate pull request (branch
  fix/server-unit-memory-cap), because a unit change is a root release and the app's own updater would hold this fix
  back for it.
- **Tests:** `tests/unit/tunnel-body-memory.test.ts`: the app gets the same object with the https URL, which cannot be
  changed again; other requests untouched; only a marked request gets `server.timeout`; no `new Request(` in
  `tunnel.ts` outside the fallback and no `.clone()` of a request in `server/src`; and over a real socket against a
  child server (`tests/fixtures/tunnel-body-memory/server.ts`, its own process so its memory is only its own): two 3 MB
  bodies in 1415-byte writes leave less than 150 MiB (the old code: 929 MB), and a body refused after 1 MiB ends its
  connection within 15 s (the old code: still open after 60 s). `tests/unit/office-tunnel.test.ts` is updated for the
  new `tunnelRequest` result.
- **Version impact:** none for stored data or clients. App-only: no root file changes.
