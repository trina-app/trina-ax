# Team AX (code id `mycel`)

A team AI workspace that runs on one Mac mini: a chat app on top of a shared team folder, where every member's AI sees only the folders that member may see. Licensed AGPL-3.0 (`ee/` is reserved for enterprise features).

Stage 1 ("permission groundwork") is in place: the permission function, the file tools the AI uses, the native tool gate and engine launcher, locked engine runners for Claude Code and the Codex CLI, and the test suites.

```
shared/   zod contracts: tool inputs/outputs, engine events, launcher protocol, product name
server/   Bun + bun:sqlite: permission function, file tools (ripgrep), MCP over a Unix socket, turn tokens,
          engine runners (Claude Code, Codex CLI), model proxy, audit logs
native/   Go: mycel-gate (peer credentials), mycel-bridge (MCP stdio <-> socket), mycel-launcher (runs engine turns)
tests/    unit, path fuzzer, ReDoS, 20k-file grep benchmark, Linux Docker job, engine lockdown regressions, e2e
web/ desktop/ relay/ menubar/   later stages
```

## Run

```sh
bun install
bun run build:native          # needs Go (brew install go)
bun run test:stage1           # everything; real engines need local claude / codex logins
bun run test:stage1 -- --no-claude --no-docker   # offline parts only
```

Needs `rg`, `pandoc`, `pdftotext` (Homebrew), Docker for the Linux job. Decisions and deviations from the design are in [docs/DECISIONS.md](docs/DECISIONS.md).
