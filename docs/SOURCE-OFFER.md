# Source offer for an installed release

The default source repository is private and `SOURCE_CODE.published` remains `false`. Login and Settings → About offer a source-request email. A repository root, missing version, or invalid version is never represented as the source of an exact release.

An operator may configure a source URL for one release. This is metadata provided by the operator: the application validates its syntax and compares the declared version with the running server version. It does **not** establish permission to publish, verify that the URL can be downloaded, compare archive contents or hashes, or certify that source-delivery obligations have been fulfilled. The request email and source-download link remain separate.

## Server configuration

Add `sourceCode` to the installed server's existing JSON configuration (`--config` / `MYCEL_CONFIG`). This example uses a reserved, non-operational domain:

```json
{
  "sourceCode": {
    "requestEmail": "source@example.test",
    "release": {
      "version": "0.3.1",
      "url": "https://source.example.test/releases/0.3.1/source.tar.gz"
    }
  }
}
```

`requestEmail` is optional and defaults to the existing support mailbox. It must be one plain address, without extra recipients or mail headers. `release` is optional, but its `version` and `url` must be supplied together. An absent release provides only the request link. An invalid configured value fails configuration validation.

The version must exactly equal the version reported by the running server, including prerelease/build suffixes. The builders' existing `MYCEL_BUILD_VERSION` defines that runtime version; this feature does not infer a filtered-source revision from Git HEAD or add build metadata. After an update or rollback to a different version, a stale configured release produces no download link. Reusing a version for different binaries or archives defeats that distinction and must be avoided by the operator.

URLs must be fixed HTTPS URLs with a non-root path, at most 2,048 characters, without user information, query strings, fragments, control characters, backslashes, or traversal segments (including nested URL encoding). Cross-origin HTTPS hosting is allowed. The application never fetches the source URL; the user's link opens with `noopener noreferrer`. Query-token download URLs are intentionally unsupported. The current release pair should identify an approved immutable source artifact, rather than a repository home page.

## Office installation

Do not edit the generated `config/server.json`: the office supervisor rewrites it at every start. Set these values in the installation's existing `config/office.env`, then restart through the existing office control command:

```text
TEAMAX_SOURCE_REQUEST_EMAIL=source@example.test
TEAMAX_SOURCE_VERSION=0.3.1
TEAMAX_SOURCE_URL=https://source.example.test/releases/0.3.1/source.tar.gz
```

These values use the same validation as server JSON and survive office settings rewrites. Omit the version and URL together to retain only the request contact. No installer flags, source hosting service, export route, or automated archive publication are added.

## Health and UI lifecycle

The existing health response includes `sourceCode: { requestEmail, download }` only where it already exposes the running version. `download` is the matching `{ version, url }` pair or `null`. Anonymous health through an office tunnel retains exactly its liveness-only `{ ok, time }` shape.

The UI rechecks version equality and URL/contact validation. It does not cache the first anonymous health response globally. The current origin, user/session and existing WebSocket connection state key its displayed result; a changed key immediately falls back to the default request contact. Unmounted, aborted or superseded requests cannot restore previous metadata. Reconnection refreshes an About page left open after a server update; selecting another server navigates to its origin and creates a fresh app state. The API remains same-origin, and existing API `no-store` responses prevent persistent HTTP caching.

## Publication gate remains separate

Opt-in HWP review bundles ship the pinned rhwp 0.8.7 CLI (MIT) and the unchanged Noto Sans KR Regular font (OFL-1.1). Their source identity, build recipe, upstream notices and remaining native dependency/metric provenance questions are recorded in `resources/hwp/notices/SOURCE-OFFER.txt` and copied into each release's `licenses/hwp/`. Include the exact release's HWP manifest, adapter, preflight worker and packaging scripts in its corresponding source materials. Default release bundles exclude this renderer runtime, and preview is disabled unless separately opted in. This addition does not clear the existing publication gate.

Before an operator enters a real download URL, the responsible owner must approve publication rights, review the filtered corresponding-source tree and its build/install materials, publish that approved artifact, and verify direct access plus the release/content identity. Preserve the resulting revision, manifest/hash, and download evidence in the release review. A matching version and syntactically valid URL alone are not that evidence.

Never publish the original private repository, its history, local source archive, credentials, or customer/medical data through this feature. The release notice/bundle process is separate; this setting does not supply or approve its source revision. No real source URL or publication was configured as part of this implementation.
