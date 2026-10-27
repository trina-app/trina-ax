# Personal Google Drive integration

The core server implements one personal connection per team user and three read-only tools: `drive_search`, `drive_list`, `drive_read`. A configured OAuth client enables these tools at server startup. Missing or invalid configuration leaves Settings disabled and does not register the tools. No Google client or account is provisioned by this code.

## Operator configuration

Put a server-owned, regular, single-link, mode `0600` JSON file at `<secretsDir>/integrations/google-drive/client.json`, or point `MYCEL_GOOGLE_DRIVE_CLIENT_FILE` to an equivalent private file outside the team folder. The configured secrets root and its `integrations/google-drive` directories must be owned by the server account, mode `0700`, and must not be symlinks. Installed office mode uses its existing `config` secrets root; other modes use `secrets` (see `system/layout.ts`). Restart after changing the client configuration.

```json
{
  "clientId": "YOUR_GOOGLE_WEB_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_WEB_CLIENT_SECRET",
  "redirectUri": "https://YOUR_TEAM_HOST/api/integrations/google-drive/callback"
}
```

The redirect URI must be HTTPS with exactly that callback path and no credentials, query, or fragment. Register the exact URI with the organization's Google OAuth web client. The requested scope is only `https://www.googleapis.com/auth/drive.readonly`; it is a restricted scope. Deployment needs its own consent-screen, test-user/production, Workspace administrator, and any applicable Google verification decisions. “Internal” is an organization-owned Google project/app setting, not a blanket exception for all company software. See Google's [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), and [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

## Authentication and privacy boundaries

`POST /api/integrations/google-drive/authorize` creates a 10-minute flow bound to the authenticated team user and session. State is random and stored hashed; the PKCE S256 verifier is encrypted. Authorization uses offline access and consent. Starting another flow supersedes earlier pending flows. Polling, cancellation, and explicit account confirmation require the original live session. Connecting displays the Google account before confirmation and never returns tokens through the API.

The callback also requires a live browser session for the **same team user**. An attacker must not be able to create an authorization URL, send it to a victim, and claim the victim's consent merely by polling the attacker's original session. Anonymous and other-user browser callbacks fail before any code exchange. The failure page has only a static same-origin `/login` link; no authorization code or state is copied into a return URL, app deep link, response body, or application log. Callback responses use `no-store`, `no-referrer`, and a restrictive CSP.

The original app session and the callback browser session may differ, but both must belong to the same team user and remain valid. This means a native external browser must already be signed into that team account. A fully automatic native OAuth handoff is **not implemented or validated**. WebView cookies must not be assumed to transfer to the system browser. Real Google consent and iOS/Android return behavior remain deployment/device validation work.

OAuth access/refresh tokens and pending verifier/token payloads are AES-256-GCM encrypted using the existing Vault primitive in the **dedicated Drive key directory**. AAD binds each payload to its team user and connection/flow ID. Google account display name/email, scope, and connection state are metadata in the database and are returned only to that owner. Ordinary DB backups contain ciphertext, not its key; restoration without the dedicated keys requires reconnection. The AI credential escrow command does not export Drive keys.

`admin.js drive-rekey` rotates Drive connection and pending-flow secrets in one immediate database transaction. It does not rotate AI credentials; `credentials-rekey` cannot delete Drive keys. Live Drive stores detect the new key version before writes. Old Drive keys are retained for in-flight readers and older encrypted backups; retiring old keys requires a separate deliberate operator procedure after accounting for backups. Rotation alone does not revoke Google's remote grant.

Disconnect deletes local connections and flows before attempting Google revocation. It cancels outstanding tool/refresh operations and fences late results by connection identity. A failed remote revocation is reported as `unavailable`; local access stays disconnected. Reauthorization is blocked while the same running server is revoking. Refresh is shared per connection within one server process and preserves omitted refresh tokens, adopts rotated tokens, and treats `invalid_grant` as a persistent reconnect requirement. The supported deployment has one active app server per team; distributed OAuth locking across multiple active replicas is not provided.

No user, admin role, model argument, service account, or team-folder path can select another person's Drive token. Disabled/deleted users and ended authorization sessions fail closed. Reconnect notifications contain a generic code and opaque connection ID, with durable transition time for deduplication; account details, document names, and tokens are omitted.

## Tool behavior and limits

All three tools require a live running turn owned by the current user. A successful result adds the caller's private user scope to the chat and marks it externally tainted before delivery. This uses the existing `confirmWidening` and `remember` confirmation behavior; it does not create a shared folder copy. The external data wrapper warns the model not to treat document text as instructions. Existing chat history/step retention still applies to results; disconnecting does not erase messages already delivered.

Search accepts plain text, escapes Drive query syntax, and never accepts raw `q`. Listing defaults to the My Drive root. Shared drives use `supportsAllDrives`/`includeItemsFromAllDrives`, with optional explicit `driveId`; the Google token remains the only upstream authority. Folder search/list pagination is explicit, defaults to 50, and is capped at 100 results per call. `incompleteSearch` and `nextPageToken` remain visible to the caller. See [shared-drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).

Reads verify metadata and `capabilities.canDownload`, resolve at most five shortcut hops with cycle detection, and use fixed Google API URLs with no redirects. Google Docs export to text; Sheets export to XLSX so all tabs use the existing spreadsheet converter; Slides export to PPTX. Other Google-native formats fail as unsupported. Uploaded PDF, HWP/HWPX, Office, text, and supported OCR images use the existing extraction path. There is no Drive upload/write API or full-drive ingestion/indexing.

| Boundary | Limit |
| --- | --- |
| Authorization flow | 10 minutes, 20 creations per user/hour |
| Provider request | 20 seconds, no redirects |
| Metadata / list response | 32 KiB / 1 MiB |
| Download | minimum of installation `readMaxBytes()` and 32 MiB |
| Google-native export | additionally capped at 10 MiB |
| Output text | default 40,000 characters; maximum 100,000, explicit truncation |
| Retry | one 401 refresh; at most two short retries for 429/5xx |

Body limits are enforced while streaming even without Content-Length. Stop/disconnect aborts network reads and isolated converters. Spreadsheet/HWP parsers run in process under the existing size limit and cannot be interrupted mid-synchronous parse; cancellation is rechecked before delivering their output. PDF/OCR and Office subprocess support depends on the installation's converter binaries. Google's [download/export guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads) documents the export limit and download capabilities.

## Offline validation

Focused tests are `tests/unit/c-drive-{api,oauth,store,tools,transport,registration}.test.ts` with `tests/lib/fake-google-drive.ts`. They use synthetic users, PKCE exchanges, file bytes, rotated tokens, provider errors, cancellation, and revocation barriers entirely in process. They check account/session isolation and authorization-URL phishing, ciphertext/AAD and AI/Drive key-rotation separation, absence of secret canaries in DB/log/API output, shared-drive query escaping, bounded responses, private read scope/taint, spreadsheet multi-tab and Google document extraction, registration in MCP/turn tool paths, and generic reconnect notification deduplication.

No actual Google/provider request, OAuth registration, account consent, mobile device authorization, or production key operation is part of those tests. PDF/Office/OCR converter installation checks and whole-product browser/type/build validation are separate from these focused fake-provider checks. HWPX and XLSX fixtures exercise the in-process conversion path here.
