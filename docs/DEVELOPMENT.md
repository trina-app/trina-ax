# Develop and contribute

Submit issues and pull requests to this public repository. You do not need access to a private core repository; maintainers handle upstream routing. [Contribution policy](../CONTRIBUTING.md).

Use macOS or Linux with Git, the CI Bun pin (1.3.12), Go from `native/go.mod`, and native build tools. The prepared Mac demo was exercised; production Linux behavior is tested separately on suitable systemd hosts. Windows desktop client builds are not a Windows server development guarantee.

```sh
bun install --frozen-lockfile
bun run build:native
bun run typecheck
bun run check:docs
bun test tests/unit/onboarding-docs.test.ts tests/unit/demo-start.test.ts tests/unit/demo-seed.test.ts tests/unit/skills.test.ts tests/unit/skill-issues.test.ts
```

For an optional local-login AI development environment, build the web app, use a new short data directory and a free port, and start `TEAM_AX_DEV_DIR="$HOME/.trina-dev-new" TEAM_AX_DEV_PORT=19761 bun run dev --no-relay`. This uses the server OS user's CLI logins and is **not production isolation**. Only connect accounts authorized for your intended use. Do not use customer data. Stop it with Ctrl-C.

The focused checks above cover onboarding and skills; they are not the full suite. `bun run test:unit` includes converters/native dependencies. Install ripgrep, poppler and pandoc where relevant. Web changes need `bun run test:web` and `bun run build:web`. Full relay, privileged Linux, production installer and real-engine suites have additional OS/account requirements; do not run them against shared services or consume credentials casually. CI describes those separately in [.github/workflows/ci.yml](../.github/workflows/ci.yml).

Changing defaults, artifact names or release contents requires reviewing README language parity, FAQ, llms.txt and bundled office instructions. Preserve source-offer/license boundaries and never put secrets in fixtures or screenshots.
