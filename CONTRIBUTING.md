# Contributing to Trina AX

Bug reports, documentation fixes and small, focused improvements are welcome in English or Korean.
Read the [code of conduct](CODE_OF_CONDUCT.md) and [repository rules](docs/REPOSITORY-RULES.md) first.

## Report a problem or suggest a change

Search [existing issues](https://github.com/trina-app/trina-ax/issues) before opening a report. Include your version,
OS, deployment mode, client and minimal steps with synthetic files. Explain the expected and actual result.
For a larger change, describe the problem in an issue before investing in an implementation.

Use [SECURITY.md](SECURITY.md) for suspected vulnerabilities. Never attach customer files, real conversations,
account names, private hostnames, setup/invite links, tokens, API keys, cookies, database copies or unredacted logs.
Reproduce with invented data and review screenshots before sharing them.

## Work locally

Follow the [quickstart](docs/QUICKSTART.md) or [full Mac setup](docs/INSTALL.md). Production Linux setup is documented
[separately](docs/INSTALL-LINUX.md); development mode is for synthetic data.

```sh
bun install --frozen-lockfile
ARCHS="arm64 amd64" bun run build:native
bun run typecheck
bun run test:unit
```

Use the Bun version pinned in [CI](.github/workflows/ci.yml) and the Go version in [native/go.mod](native/go.mod).
Some unit tests use native helpers or document converters listed in the installation guide. Run the tests relevant
to your change first. For web changes, also run `bun run test:web` and `bun run build:web`.
Do not run real-engine, deployment or account-changing tests without the relevant credentials and authorization.

For documentation changes, check relative links and commands, preserve license/source notices, and run:

```sh
bun run typecheck
bun test tests/unit/release-notices.test.ts tests/unit/source-code-offer.test.ts tests/unit/edition-source.test.ts tests/unit/cloud-protocol.test.ts
```

## Send a focused pull request

1. Create a branch from current `main` in your fork or checkout.
2. Explain the problem, change and validation. Include a synthetic screenshot for visible UI changes.
3. Update the relevant documentation alongside behavior changes. Keep unrelated formatting out of the diff.
4. Preserve existing copyright, license and source-offer notices. Contributions follow the applicable repository or component license; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The shared Team AX core is maintained upstream. Maintainers may route general server, client, permission or engine
changes through the core before bringing them here. Trina branding belongs in `editions/trina/branding/`.
Customer deployments, billing/hosting operations and credentials do not belong in this public repository.

## A first contribution

Try a reproducible installation-doc correction, a broken documentation link, or an English/Korean wording fix.
If an issue is labelled `good first issue`, confirm its scope with a maintainer before starting. A label is not a
promise that every issue is suitable for a first contribution. Reports with clear reproduction steps help too.
