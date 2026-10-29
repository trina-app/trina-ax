# web — Trina AX web client (component D)

React + Vite + TypeScript + Tailwind. Built to `web/dist` and served by the team server (`server/src/routes/web.ts`);
the desktop app and the PWA load the same build. Talks to the server only through the shared contract
(`@mycel/shared/api`: `ApiClient` for REST, `ws.ts` for the WebSocket).

```sh
bun run --cwd web dev        # Vite on http://localhost:19140, proxies /api (+ WebSocket) and /vendor to 127.0.0.1:19100
bun run --cwd web build      # vite build + scripts/build-vendor.ts (artifact libraries → dist/vendor)
bun run --cwd web typecheck
bun run --cwd web test       # unit tests (bun test test/unit)
bun run --cwd web e2e        # Playwright against the mock team server (test/mock), needs a build first
bun run --cwd web mock       # the mock server by itself on :19143 (sign in as olga / "correct horse battery")
```

Layout:

```
src/lib/        api client, WebSocket client (resume / backoff / ping), uploads (chunked, resumable), artifacts
                (sandbox + CSP), markdown rules, desktop bridge, browser relay, PWA, formats
src/store/      zustand stores: session, chats (+ pure thread reducers), jobs, live (WebSocket → stores), ui
src/i18n/       ko (source, default) / en / id — same keys, checked by TypeScript and test/unit/i18n.test.ts
src/components/ layout, sidebar, markdown, artifact panel, file previews, composer, messages, …
src/pages/      sign-in / setup / invite, home, chat, files, projects, settings, admin/*
scripts/        build-vendor.ts (artifact libraries), make-icons.ts (PWA icons from favicon.svg)
test/unit/      bun tests; test/mock/ mock server (contract-checked); test/e2e/ Playwright
```

Security rules from design tab 5 that live here: artifacts and HTML/SVG previews run in `sandbox="allow-scripts"`
frames that load the team server's receiver `/sandbox/frame` (its CSP blocks every request except `/vendor/` of the
team server) and get their document by postMessage, never srcdoc; the app page itself allows no inline script; links
in Office previews are http(s) only and ask first; external images in answers are never loaded by themselves; the
service worker caches only hashed files.
