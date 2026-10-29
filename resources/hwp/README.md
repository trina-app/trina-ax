# HWP preview runtime

Development: `bun run prepare:hwp` installs only the pinned CLI for the current OS/CPU into ignored `native/bin/hwp`. Runtime never downloads software. Release builds call `scripts/hwp-bundle.ts` for Linux amd64/arm64 or both macOS architectures, copy this font/notice bundle, and build `hwp-preflight.js` alongside the server.

The upstream Linux 0.8.7 executables require **glibc >= 2.39** (Ubuntu 24.04 / Debian 13). Debian 12 ships glibc 2.36: **BLOCKED for previews** pending a reproducible native-skia build against that baseline, new executable checksums and smoke tests. The rest of Trina and original downloads remain available; startup verification fails closed. Do not claim Debian 12 preview support or change the product-wide OS floor to hide this limitation.

Pin updates require archive and executable hashes for every target, internal font identity checks, fixture/corruption/security/visual tests and notice review. The CLI archive alone does not contain its complete third-party notices. See notices/SOURCE-OFFER.txt for provenance and unresolved upstream inventory questions.

Limits and stable diagnostics: shared/src/hwp.ts. One active preview per server; requests over the limit receive busy and can retry. A fresh bounded process runs each preflight/info/page stage. Linux production requires its existing delegated converter cgroup and bwrap. macOS uses sandbox-exec plus RSS/work-directory watchdogs; those polling limits are not hard OS quotas.
