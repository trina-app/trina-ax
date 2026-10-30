# HWP preview runtime

**HWP preview is the HWP Preview plugin** (`app.trina.hwp-preview`, [docs/PLUGINS.md](../../docs/PLUGINS.md)). This folder holds the pins core enforces (`manifest.json`: rhwp archive and executable SHA-256 per target, font identity) and the third-party bytes the plugin build packs: the font and the notices. Core keeps the `rhwp-v1` adapter, preflight, limits and isolation (`server/src/files/hwp-*.ts`); a package whose executable or font differs from these pins is refused.

**Release gate: still closed.** Server, office and desktop bundles never include the rhwp executable, this font or any plugin package. At runtime preview and `hwp_render` need the plugin turned on for the company **and** `MYCEL_HWP_PREVIEW=1` (internal review servers only); the plaintext write/edit protection and HWP text reading are always on. Before a public plugin release, resolve the exact-version notices, native Skia inventory and compiled font-metric provenance, complete native amd64 Linux/cgroup and Intel Mac execution, then record cleared targets in `clearance.json` (absent today, so `scripts/plugins/build-hwp.ts` builds test packages only).

Development: `bun run prepare:hwp` installs only the pinned CLI for the current OS/CPU into ignored `native/bin/hwp`. `bun run plugin:hwp` packs it with this font and notices into a test-signed `.trinaplugin` (developer test key outside the repository). Runtime never downloads software.

The upstream Linux 0.8.7 executables require **glibc >= 2.39** (Ubuntu 24.04 / Debian 13). Debian 12 ships glibc 2.36: **BLOCKED for previews** pending a reproducible native-skia build against that baseline, new executable checksums and smoke tests. The rest of Trina and original downloads remain available; startup verification fails closed. Do not claim Debian 12 preview support or change the product-wide OS floor to hide this limitation.

Pin updates require archive and executable hashes for every target, internal font identity checks, fixture/corruption/security/visual tests and notice review. The CLI archive alone does not contain its complete third-party notices. See notices/SOURCE-OFFER.txt for provenance and unresolved upstream inventory questions.

Limits and stable diagnostics: shared/src/hwp.ts. One active preview per server; requests over the limit receive busy and can retry. A fresh bounded process runs each preflight/info/page stage. Linux production requires its existing delegated converter cgroup and bwrap. macOS uses sandbox-exec plus RSS/work-directory watchdogs; those polling limits are not hard OS quotas.
