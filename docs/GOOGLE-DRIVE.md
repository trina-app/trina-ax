# Google Drive integration

The core server implements one personal connection per team user, Drives an admin shares with the team, and three read-only tools: `drive_search`, `drive_list`, `drive_read`. A configured OAuth client makes Drive available; it turns nothing on by itself (below). A configured OAuth client enables these tools at server startup. Missing or invalid configuration leaves the Google Drive card in Settings › App connectors unavailable ("Not available yet", Connect turned off) and the three tools are not offered. An admin can set the client up in Admin › App connectors (below); the tools are offered as soon as a client is there, without a restart. No Google client or account is provisioned by this code.

## Setting it up in Admin › App connectors

On a self-installed server with a public address (`tunnel.host`), an admin can set Google Drive up without the installer: Admin › App connectors › Google Drive › **Set up**. The dialog shows the redirect URI to register with the Google OAuth web client, `https://<tunnel.host>/api/integrations/google-drive/callback`, and takes the JSON file Google Cloud downloads for that client (its `redirect_uris` must list that URI) or the client ID and secret. The server (`server/src/integrations/google-drive/admin-setup.ts`, `PUT /api/admin/google-drive/client`, admins only):

- writes the same private file as the installer, `<secretsDir>/integrations/google-drive/client.json` (mode `0600`, a new file renamed into place, no links followed; the secrets directories are checked as below), reads it back with the same checks, and puts the earlier file back if that fails;
- records that the page set it (`settings` `integrations.googleDriveClientByApp`, the client's fingerprint) and audits `drive.client_set` with only `{ replaced }`: never the client ID or secret, which no response or log line carries either;
- offers the Drive tools from then on (`server/src/tools/drive.ts` registers them always, `available` while a client is set). Replacing the client makes connected members reconnect, as after an operator's change.

The page does not change: a hosted server (the hosting service owns its setup), a server without a public address, a client set through `MYCEL_GOOGLE_DRIVE_CLIENT_FILE`, or a `client.json` the installer or the operator wrote (shown as "Set in the server's own setup"). Only a client set on this page can be replaced there. `GET /api/admin/google-drive` says which applies (`blocked`) and how many active members are connected with the current client.

## What is on: the members' switch and team shares

A Google client only makes Drive available: Admin › Connectors › Google Drive says **Ready to set up** until an admin turns something on, and **On** once members may connect their own Drive or a Drive is shared with the team (`GET /api/admin/google-drive`: `membersCanConnect`, `sharesOn`).

- **Members can connect their own Google Drive** (`PUT /api/admin/google-drive/members`, settings `integrations.driveMembers`, audited `drive.members_switch`). On for a new team (no stored value means on). Migration 339 wrote the explicit value "off" for every team that existed before it and had none, so a team made earlier keeps what it had; migration 337 sets it on for a team whose members had already connected their own Drive, so nothing they use stops working. Off: Connect is turned off in Settings › Connectors, `authorize` and `complete` answer `drive_members_off`, and a connection made before is kept but not used (its row says the admin turned it off, Disconnect still works). The switch is for everyone's own Drive, admins included.

## Sharing a Drive with the team

An admin connects one Google account for the team (`server/src/integrations/google-drive/shares.ts`, `share-admin.ts`; migration 337):

1. **Share a Google Drive with the team** starts a Google sign-in with the server's own client and `drive.readonly` (`POST /api/admin/google-drive/shares/authorize`). It is the same PKCE flow as a person's own, held in `drive_oauth_flows` with `purpose = 'share'`, polled and cancelled the same way; the callback still needs the same signed-in admin in the browser. A personal flow cannot be completed as a share, nor a share flow as one's own Drive.
2. The admin confirms the account (`POST …/shares/flows/:id/complete`): the share is made with a name ("Company Drive"), no folders and nobody in its rule. Cancelling the dialog before the first Save stops it again.
3. The folder picker lists the account's top-level folders and shared drives, or folders and shared drives whose name has the search (`GET …/shares/:id/folders?q=`). The whole Drive is allowed only with a warning: everything the account can open, including files shared with it and its shared drives.
4. Who may use it is a rule like a team connection's (everyone / groups / people); being an admin is not one. `PATCH …/shares/:id` checks every chosen folder with Google (a folder this account can read, or a shared drive) and stores Google's names, never the request's.

Each share is a row: the account, its folders, who may use it and how many active people that is, and ⋯ (change folders or people, reconnect, stop sharing). **Stop sharing** (`DELETE …/shares/:id`) deletes the share, its rule and its tokens at once, aborts calls under way, then revokes the token at Google.

The tokens are sealed like a person's own, in their own key context (`drive-share:<id>`), and no response, log line or audit entry carries them. A member sees only the share's name and folders (`GET /api/integrations/google-drive` `teamShares`), never the account. Audit entries say who did what to which share: `drive.share_created`, `drive.share_folders_changed` (a count and whether it is the whole Drive), `drive.share_audience_changed` (counts), `drive.share_renamed`, `drive.share_reconnected`, `drive.share_stopped`, `drive.share_owner_gone`; never a file name, an email or a token.

When the admin whose Google account it is leaves, is disabled or stops being an admin, the share stops: its tokens are deleted (and revoked at Google), it says why, and every admin gets an Inbox notice (`drive.share_reconnect`, `drive_share_notices`) with a link to Google Drive's page, where another admin signs in again (its folders and rule stay). This is checked after any change of people (`admin/folders.ts` `afterAccessChange`), every minute, and on every use. Google refusing the sign-in (`invalid_grant`, a 401) or a new server client also asks for a new sign-in.

### How the tools use a share

`drive_search`, `drive_list` and `drive_read` take `source`: `"mine"` (the person's own Drive) or `"team:<name>"`. Left out, it is the person's own when it works, else the first team share they may use. Every result names its `source` and lists the `otherSources`, so the AI learns what is there; an unknown source answers with the sources there are. Labelled sources were chosen over merged results because a file ID belongs to one account: the AI reads a file through the source that listed it.

The folder limit is decided on the server for every call, never by the model or the browser (`read.ts` `FolderScope`, `Ancestry`):

- `drive_list` without a folder lists the shared folders; a folder is listed only when it is inside (it is a shared folder, or one of its parents is, all the way up); a shared drive only when it is one of the share's.
- `drive_search` searches the account and keeps only results inside: a file is inside when it is a shared folder, is in a shared drive of the share, or **any** of its parents is inside (a file in two folders is inside when either is). Each folder is looked up once a call, at most 200 lookups; a file not placed by then counts as outside and `incompleteSearch` is set.
- `drive_read` reads only a file inside; a shortcut is judged by its target. A file outside answers exactly like a file that is not there.
- The rule, the share (its version: a change of folders fences calls under way) and its admin are checked before and after each call. What a share returned is a `drive_share` read source: its viewers are the active people its rule includes today, so saving it where more people can see asks first (`chat/read-scope.ts`).

## Operator configuration

Put a server-owned, regular, single-link, mode `0600` JSON file at `<secretsDir>/integrations/google-drive/client.json`, or point `MYCEL_GOOGLE_DRIVE_CLIENT_FILE` to an equivalent private file outside the team folder. The configured secrets root and its `integrations/google-drive` directories must be owned by the server account, mode `0700`, and must not be symlinks. Installed office mode uses its existing `config` secrets root; other modes use `secrets` (see `system/layout.ts`). Restart after changing the client configuration by hand (a change made in Admin › App connectors applies at once).

On Linux, the installer does this: `sudo ./install-linux.sh repair --public-host HOST --google-drive-client FILE`. FILE is the JSON that Google Cloud downloads for a web client (`{"web": {...}}`, the installer picks the redirect URI of HOST) or the format below. The installer checks the file before it changes anything, writes `client.json` with the modes above, never prints the secret, and does not keep the file path: `repair` and `update` without the option leave the installed file as it is.

```json
{
  "clientId": "YOUR_GOOGLE_WEB_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_WEB_CLIENT_SECRET",
  "redirectUri": "https://YOUR_TEAM_HOST/api/integrations/google-drive/callback"
}
```

The redirect URI must be HTTPS with exactly that callback path and no credentials, query, or fragment. Register the exact URI with the organization's Google OAuth web client. The requested scope is only `https://www.googleapis.com/auth/drive.readonly`; it is a restricted scope. Deployment needs its own consent-screen, test-user/production, Workspace administrator, and any applicable Google verification decisions. “Internal” is an organization-owned Google project/app setting, not a blanket exception for all company software. See Google's [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), and [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

## Hosted teams: sign-in through the hosting service

A hosted team gets its address (`<team>.<team domain>`) automatically, and Google accepts only exact return addresses, so
a Google client per team does not scale. Instead the hosting service's control plane holds ONE Google client with ONE
return address on its console host and signs in for every hosted team (`server/src/integrations/google-drive/broker.ts`;
wire contract `shared/src/cloud-protocol/drive-broker.ts`, MIT; control plane: trina-cloud `docs/drive-broker.md`).

**When.** Only when the operator sets `MYCEL_GOOGLE_DRIVE_BROKER_URL` (the control plane's console origin, for example
`https://account.trina.app`; https, or http to this machine) on a hosted server (`deployment: "hosted"`) that has NO
Google client of its own (no `client.json`, no `MYCEL_GOOGLE_DRIVE_CLIENT_FILE`). Without the variable nothing changes:
the server makes no call to the hosting service. A server with its own client keeps the direct flow above, unchanged.
Even with the variable, Drive turns on only after the control plane answers that it serves this team (a signed
`/status`, at start, then every 10 minutes, every minute while it says no). Admin › Connectors › Google Drive then shows
`source: "service"` ("Google sign-in comes from the hosting service. Nothing to set up or upload."), and the members'
switch and team shares work as described above.

**Flow.** `POST /api/integrations/google-drive/authorize` (and the share authorize) asks the control plane to start
(`begin()`): the same flow row, state and PKCE verifier as the direct flow, but the control plane makes the Google
address. Google returns to the control plane, which sends the browser to this server's own callback with `state` and a
one-time `handoff` (never a Google code or token). The callback checks the same signed-in person in the browser as the
direct flow, then redeems the handoff with this flow's verifier. Refresh and revoke go to the control plane, never to
Google's token endpoint.

**The first page.** A control plane that has its own start page answers `start` with a `connectUrl` too:
`<console origin>/drive-broker/connect?state=…`. It names the team, says that Trina reads Drive read-only, explains
Google's screen for an unverified app, and links on to Google. The server passes `connectUrl` on only when it is exactly
that page on `MYCEL_GOOGLE_DRIVE_BROKER_URL` (`driveBrokerConnectUrl`), and the web opens it in the sign-in window
(`web/src/lib/driveSignIn.ts`, which checks the shape again). The phone app keeps opening Google directly: its browser
hand-off accepts only `accounts.google.com`. With an older control plane there is no `connectUrl` and the web opens
Google, as before.

**Trust boundaries.**
- Every call to the control plane is signed with this server's relay team key (`<data>/relay/team-key.pem`, Ed25519,
  with a timestamp and a nonce). The control plane serves only the key it recorded for a hosted team at enroll.
- The control plane sends the browser only to this team's own address (its records, never a request field).
- The refresh token this server keeps is sealed by the control plane with this team's id as associated data: useless to
  Google without the control plane's client secret, and refused for any other team. It is sealed again here like a
  direct token. A start answer that is not `https://accounts.google.com/...` is refused.
- Folder limits, audiences, stop sharing and an admin who leaves work exactly as above: only where the tokens come from
  changes.

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

Reads verify metadata and `capabilities.canDownload`, resolve at most five shortcut hops with cycle detection, and use fixed Google API URLs with no redirects. Google Docs export to text; Sheets export to XLSX so all tabs use the existing spreadsheet converter; Slides export to PPTX. Other Google-native formats fail as unsupported. Uploaded PDF, HWP/HWPX, Office and text files use the existing extraction path, without OCR: a PDF gives its text layer, with a note when some pages have none (scans). Images (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP) reach the model as image blocks through the same switch, engine check, per-turn budget and isolated converter as team-folder reads. There is no Drive upload/write API or full-drive ingestion/indexing.

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

Focused tests are `tests/unit/c-drive-{api,oauth,store,tools,transport,registration,shares}.test.ts` with `tests/lib/fake-google-drive.ts`. `c-drive-shares` covers team shares: only admins create, change or stop one; a member outside the rule gets nothing; nothing outside the shared folders (search filtered, list and read refused, also through a shortcut and a file in two folders); tokens never returned; stop sharing revokes; a gone admin stops the share and the admins get a notice; the members' switch. They use synthetic users, PKCE exchanges, file bytes, rotated tokens, provider errors, cancellation, and revocation barriers entirely in process. They check account/session isolation and authorization-URL phishing, ciphertext/AAD and AI/Drive key-rotation separation, absence of secret canaries in DB/log/API output, shared-drive query escaping, bounded responses, private read scope/taint, spreadsheet multi-tab and Google document extraction, registration in MCP/turn tool paths, and generic reconnect notification deduplication.

No actual Google/provider request, OAuth registration, account consent, mobile device authorization, or production key operation is part of those tests. PDF/Office/OCR converter installation checks and whole-product browser/type/build validation are separate from these focused fake-provider checks. HWPX and XLSX fixtures exercise the in-process conversion path here.
