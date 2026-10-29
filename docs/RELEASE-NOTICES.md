# Release notice evidence

The common collector is `scripts/release-notices.ts`. It copies existing license/notice text into distribution artifacts and records what was collected and what remains unknown. **Every manifest has `publicClear: false`. A successful build is a review artifact, not publication approval or a conclusion that license obligations have been met.**

The collector is offline: it reads the repository, its frozen-lock installation and the completed staging directory. It does not install packages, query registries, execute package scripts, infer a license grant from an SPDX identifier, or manufacture license text. It does not change any dependency version.

## Output and build order

Every artifact receives:

- `LICENSE`: the repository's exact root text; a missing root license stops the build.
- `NOTICE`: the repository's exact root notice, when present.
- `licenses/shared-cloud-protocol/LICENSE`: the separately scoped protocol license, when present. This is not a grant for `ee/cloud`.
- `licenses/packages/<name>@<version>-<content-id>/...`: original installed-package license, notice, copyright and licensing README files, retaining their relative names and bytes.
- `licenses/README.txt`: generated review status and explicit pending findings; this file is not a license.
- `licenses/manifest.json`: package identities, document hashes, payload hashes, input hashes, omissions and unresolved findings. Paths are relative; installation paths and raw package metadata are not published.

`build-bundle.ts` completes the macOS/Linux version folder, collects and verifies notices, writes the outer `manifest.json`, optionally signs that outer manifest, then packs the archive. Thus the root license, every notice, the notice manifest and web replicas are covered by the existing signed bundle manifest. No notice content is changed after that signature. Signing remains optional exactly as in the existing builder; the collector does not supply a production key.

`build-office.ts` completes `app/`, collects and verifies its notices, checks `bundleManifest()`, then creates the ZIP. Office ZIPs do not acquire a new signature mechanism from this change. Guide PDFs, kit-level installers and separately distributed desktop installers outside `app/` remain explicit pending coverage.

When a bundle contains the web app, all notice documents and the notice manifest are also copied into the installed web root's `licenses/` directory (`web/licenses` in version bundles, `app/web/dist/licenses` in office kits). The server's existing static file route can serve `/licenses/LICENSE`, `/licenses/README.txt`, `/licenses/manifest.json` and the package documents. The verifier checks those copies against the canonical bytes, including the entire manifest. There is no self-hash recursion: the notice manifest does not hash itself or its exact replica; the outer bundle manifest hashes both. This change does not add a UI link or certify the deployment's proxy/static-route configuration.

## Selection and identity

The default bundle/office roots are installed `server` dependencies and, when web assets are present, installed `web` dependencies plus the explicitly bundled `@tailwindcss/browser` vendor. Required dependencies, optional dependencies and peer dependencies are followed recursively. Dev dependencies are not generally included. This is a **declared dependency closure superset**, not an exact bundler graph: packages used only for types or code eliminated during bundling can be included. Conversely, copied binaries, embedded upstream code and non-package assets need separate attribution work.

Resolution uses each actual consumer's installed dependency tree, including nested versions and repository-contained Bun/pnpm store links. Package names and versions come from the resolved `package.json`, including npm aliases; they are never guessed from directory names. A hash of that metadata and collected/withheld document bytes distinguishes different installations of the same name and version. Raw `package.json`, registry URLs, `_where`, `_resolved` and auth fields are not copied.

For the known core workspaces `server`, `shared` and `web`, an explicit license declaration equal to the root package declaration references the copied root `LICENSE`. The collector does not automatically extend that grant to `ee/` or other workspaces. The shared protocol's separately scoped original is copied independently.

A missing optional package is recorded under `omitted`, rather than presented as a missing license for included code. Missing required packages remain pending. A missing installed package whose name is also a Node/Bun builtin has the distinct `builtin-name-without-installed-package` finding: it may resolve as a server builtin, but this tool does not assert browser polyfill coverage. Known installed packages without original grant text remain `license-text-missing`. Licensing README files remain review findings even when `package.json` names a familiar license; the collector does not resolve contradictory/custom commercial terms on the publisher's behalf.

## API for other common builders

```ts
import { writeReleaseNotices, verifyReleaseNotices, reportReleaseNotices } from './release-notices'

const evidence = writeReleaseNotices({
  repoRoot,
  artifactDir, // completed artifact; no credentials or private config belong here
  version: '0.2.2-review',
  target: 'browser', // darwin | linux | browser | win32 | portable
  arch: 'neutral',
  kind: 'web', // bundle | office | web | desktop
  roots: [{ directory: 'web' }, { directory: 'web', packages: ['@tailwindcss/browser'] }],
  includeWeb: true,
  includeNative: false,
})
reportReleaseNotices(evidence)
verifyReleaseNotices(artifactDir)
// Now produce the outer hash/signature/archive. Do not change the stage afterward.
```

`web` treats `artifactDir` as the static root: canonical `LICENSE` and `licenses/` are directly available there, with no nested mirror. `desktop` similarly places canonical notices in its JavaScript output. Both accept explicit `roots`/`packages` so callers can describe actual bundled vendors rather than all build dependencies. `includeNative: false` keeps payload hashes but excludes Go inputs/listing and the native-binary coverage finding; it is for standalone JavaScript distributions, not a way to declare native binaries cleared. Desktop output always retains `electron-packager-notices-not-verified`: runtime and installer notices emitted by Electron's packager need separate output verification.

The full web build (`bun run --cwd web build`) runs `web/scripts/build-notices.ts` after both Vite and vendor generation. `build:app` and `build:vendor` are partial builds: use the full build when a complete, current notice snapshot is needed. The common desktop builder runs collection after all `dist/` files and the existing Electron setup step, selecting the bundled `@mycel/shared`, `zod` and `electron-updater` dependency roots explicitly. Desktop JavaScript evidence uses `target: portable`, `arch: any`; the build host does not identify the eventual Electron package target. Existing packager selection of `dist/**/*` includes these notices, but actual ASAR, runtime license files and cross-target installer contents still require separate packaged-output checks. No successful JavaScript-stage check implies those Electron artifacts were built or verified.

`verifyReleaseNotices()` detects changed, missing and newly added staged files, stale/unlisted notice documents, altered web replicas and invalid file types. The only untracked outer files are the existing `manifest.json` and `manifest.sig`, generated after collection. Recollection removes the tool-owned `licenses/` directories before creating the new snapshot; do not store hand-maintained documents there. They should come from source inputs.

## Safety and unresolved scope

Original accepted text is preserved byte-for-byte, including line endings. Package notice links must resolve inside the selected package root; repository-contained installation-store links are supported. Output symlinks, including dangling links, and special files are rejected. Text/entry limits bound scanning. Recognizable credential/private-key material, NULs and local home paths in mandatory original notices cause a fixed-code build failure without original text or local paths in the error. An optional licensing README with such content is withheld in full, never rewritten: its relative name, original hash and size are recorded under `withheld`, with an explicit pending finding. A referenced `SEE LICENSE IN` document is mandatory and cannot use that optional-README exception. These checks are not a general secret scanner or a substitute for the publication scan.

The manifest hashes all actual staged payload files. A binary's optional version field is a declared pin from `versions.json` (or the release label for project helpers), **not** a runtime version probe. Native files are not executed. Declared `native/go.mod` module versions and input hashes are evidence, not a complete embedded-dependency/license inventory. Bun, Go/toolchain components, compiled engines, ONNX/native libraries, system/vendor tools and other binary contents still require verified original notices and redistribution review. Browser fonts/images/WASM and other copied assets retain separate pending coverage. macOS root-owned installer programs outside the version folder are also identified as unenumerated by this collector.

A complete release still needs approved source/rights review, the relevant native/asset/packager notices, corresponding-source obligations and exact final artifact checks. Neither a clean collector run, metadata license string, copied root license, signed manifest nor an operator source URL closes those gates. The G4 legal/publication gate therefore remains open. This common implementation must be carried through the approved filtered-core process into Trina AX, and adopted separately by the medical fork; this work does not mutate either existing deployment.

## Offline verification

```sh
bun test tests/unit/release-notices.test.ts tests/unit/office.test.ts tests/unit/g-bundle-linux.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The notice tests use synthetic packages and generated in-memory signing keys. They cover actual resolved/nested versions, aliases, internal/external/dangling links, unsafe text, missing/optional/builtin dependencies, workspace grant boundaries, unchanged original bytes, stale/added/modified files, web replicas, outer signed-manifest inclusion, and standalone web/desktop selection. The existing office/Linux manifest regressions check the required notice entries. No provider or registry calls are needed.

A separate local review exercised collection on a copy-on-write copy of a previously compiled macOS bundle, then generated a fixture Ed25519 signature, packed it and compared every packed notice to the signed manifest with OS networking denied. That validates the collection/pack path, not exact current-build provenance, production signing, native attribution completeness or permission to publish. The final filtered candidate must be rebuilt and reviewed with its actual installation and final source inputs.


## PowerPoint distribution notices (2026-10-29)

The package notice collector now includes subject-prefixed copyright/notice files under `licenses/`, so `@aiden0z/pptx-renderer`'s `licenses/ECMA-text-copyright-notice.txt` is included unchanged in built distribution inventories. Path, symlink and content checks still apply. A fixture verifies byte preservation and inventory validation; the built web artifact verifies the actual dependency notice.
