# Safe operations 1A

> **2026-10-30 (feat/vision-read):** AI reads of images and PDF pages no longer use this flag. They are a default-on
> path with its own converter isolation, per-turn budget, delivery re-check and admin switch ("Send images and PDF
> pages to the AI"), and they never mark a conversation confidential ([DECISIONS](DECISIONS.md), "AI sees images and
> PDF pages"). The flag still gates the bundled-layout PowerPoint workflow, its quarantine and its confidential lock.
> The qualified image converter below now serves only the images embedded in that PowerPoint; the "Image read"
> limits describe it, not `read`. Linux has no OCR fallback any more.

This is a fixed-operation, Linux-only rollout behind `MYCEL_SAFE_OPS_1A=1` (default off).
There is no new shell, script, Python or general execution tool. The administrator enabling it
must authorize the configured model provider to receive document contents **including pixels**.
Metadata removal does not remove sensitive text in pixels. Medical deployments remain disabled
pending their separate provider/retention/purpose and clinical-output review.

While the flag is on, every conversation is confidential: it retains only local file, memory and
conversation tools; browser, connectors, web fetch and provider/CLI web search are disabled.
A conversation in which a 1A workflow was admitted stays confidential for good, including after
the flag is turned off; the mark is written at admission, before the workflow reads anything.
Other conversations get their tools back when the flag is off (2026-10-30, DECISIONS "Safe
operations 1A on a standard Linux install"). Use a new conversation for this workflow; already
delivered data cannot be recalled. Other API engines
retain text/OCR only. Actual pinned Claude/Codex release qualification remains a release gate;
the automated integration tests exercise fake engines through the real MCP bridge and socket.

### Administrator rollout

After the release gates below have been approved, on the Linux systemd installation run
`sudo mycel-ctl safe-ops on` (`status` shows the state, `off` disables). It:

1. checks the machine: at least 2304 MiB of memory (a hosted tenant's plan.json counts);
2. puts root's own copies of `mycel-safeops` and `pandoc` into `<base>/root/safe-ops/` when they
   are missing or from another version: from the installed version after checking its release
   signature and each copy's hash (an unsigned development install needs
   `sudo ./install-linux.sh update --from <kit>` instead);
3. sets `MYCEL_SAFE_OPS_1A=1` in `/etc/default/<installation-id>` (other lines stay), which the
   server unit reads; an unset variable, `0`, or any value other than exactly `1` leaves new
   PPTX operations disabled;
4. renders `<installation-id>.slice` with the bounded limits below and restarts the server and the
   launcher in a fresh slice (running replies stop; it waits up to `--max-wait` seconds, default 120).

The bounds while 1A is on: `MemoryMax = min(4096, machine − 512) MiB`, `MemoryHigh = MemoryMax − 768 MiB`,
`MemorySwapMax=0`, `TasksMax=512`, `CPUQuota = min(4, CPUs) × 100%`. They cover the server, its
converters and every engine turn together, so on a larger machine the team uses at most 4 GiB and
four CPUs while 1A is on. With 1A off the slice has no limits. The installer and upgrades render the
slice from the flag, so a flag set by hand gets its slice with the next upgrade; `safe-ops on` is
still the supported way. Admin › System › Diagnostics shows "Safe PowerPoint (1A)": ready, or what
is missing.

Qualification is still required on every converter job; the switch never bypasses it. Test a
synthetic image and presentation on the target host before admitting confidential work.
`sudo mycel-ctl safe-ops off` disables the feature. Conversations that ran a 1A workflow keep their
egress restrictions. This procedure does not approve medical use or replace the real pinned CLI
and host qualification gates.

## Fixed operations and limits

- Image read: PNG, JPEG, WebP and HEIC/HEIF, 8 MiB compressed, 32 million decoded pixels,
  single frame, longest side 1536, canonical JPEG at most 1 MiB. Alpha is flattened to white;
  JPEG EXIF orientation is applied; metadata/GPS is not copied. HEIC uses the existing libheif
  executable inside the same sandbox; a 64 MiB intermediate and all job limits apply even
  before its decoded dimension check. Animated/multiple-image exports are refused.
- (Before feat/vision-read: at most 4 MiB image blocks per turn, with OCR as the fallback.) A corrupt/over-limit
  qualified decode fails instead of retrying a weaker decoder.
- PPTX: bundled reference only, Markdown at most 100,000 characters, 20 images, 30 slides,
  32 MiB generated archive. Layout names are explicit in `expected_layouts`; slide level is
  selected by the existing `deckShape` contract. `expected_slides` and `expected_notes` reuse
  the existing mismatch check. Raw markup, arbitrary attributes, external links and uploaded
  reference templates are refused. Every image is independently authorized and normalized.
- Validation before publication: ZIP central directory at most 1 MiB, 512 entries, 8 MiB each,
  48 MiB expanded total, bounded ratio/names/XML depth/nodes, no ambiguous paths, active parts,
  external relationships or unknown layouts. Every embedded image is decoded with the image
  limits. The validator returns only bounded slide/layout/notes JSON. This is structural
  validation, not a guarantee of visual correctness or arbitrary Office safety.

## Qualified converter boundary

Each operation has a new private workspace and cgroup leaf. The runner reads back effective
aggregate and per-job limits; the native helper checks membership and limits **after joining**.
The per-job and safe-operations parent limits are 512 MiB memory, zero swap, 64 pids, one CPU;
20 s wall time, 25 s CPU rlimit, 64 MiB file-size rlimit, 128 descriptors, 64 MiB scratch tmpfs.
The existing converter parent remains the aggregate memory reservation. Legacy jobs use its
separate `legacy` leaf. One safe operation is admitted at a time, with no retained wait queue.

Bubblewrap supplies private PID/network/user namespaces, no capabilities, read-only root and
only private `/work`, `/proc`, null/urandom, staged read-only inputs and exact runtime dependency
files. Executables, dependency files and their containing paths must be root-owned and not
writable by other users. An install keeps root's own copies of `mycel-safeops` and `pandoc` in
`<base>/root/safe-ops/` (the server unit's `MYCEL_SAFE_OPS_BIN`): the version folders belong to the
server account. The installer, `mycel-ctl update` (a release that changes either program needs
root) and `mycel-ctl safe-ops on` install them only from a verified release; a job refuses copies
from another version than the running server's. The helper applies required Landlock execution restrictions and the
engine seccomp profile (a deny-list, not a measured syscall allow-list). Private namespaces
provide signal/network separation on Landlock ABI 1–5; ABI 6 scopes are used when available.
No broad executable/runtime/home/team-directory binds, warm workers or shared writable caches.
The HEIC plugin allowance is the libde265 decoder and its exact dependencies only.

Cancellation and timeouts kill the entire cgroup. The broker awaits exit, checks that population
is zero, and requires removal of both the leaf and staging directory. Any failure makes the
runner unhealthy, retains a 128 MiB reservation as cleanup debt, and refuses all subsequent
workflows. The reservation covers staged input (up to 32 MiB), scratch (64 MiB) and output
(up to 32 MiB). It is conservative accounting, not a filesystem quota for the broker process.
Mac, missing controls, ineffective limits, missing Landlock/bwrap or `MYCEL_ISOLATION=none`
fail closed. Mac can still use original-source OCR and flag-off legacy PowerPoint creation.
Normalized JPEG output is never passed to that OCR path.

## Workflow admission and recovery

Admission covers the complete image read or PPTX operation, including validation and approval,
with one workflow globally and no retained queue. SQLite admission also prevents two server
processes from admitting workflows simultaneously. Limits are four workflows per user/turn,
eight per user in a rolling hour, and 24 converter jobs, 600 reserved CPU-seconds (25 per job),
and 512 MiB reserved input/output transfers per user/turn in that hour. A workflow has a 120 s
wall deadline, including approval. The per-user and per-turn workflow counts include running
workflows and those that started at least one converter job; a try refused before any conversion
(not ready, a bad source or option) uses no slot, and converter work stays charged by the
cumulative job/CPU/transfer budget. A null turn shares one user/hour bucket. This is bounded rejection admission, **not a fair queue or an I/O bandwidth controller**.
The one-CPU job quota plus wall timeout bounds the whole job tree; the CPU accounting is a
worst-case reservation, not measured usage. Inputs retained for a presentation are capped at
32 MiB. No downstream indexing/preview worker is admitted for a generated artifact.

Jobs and reservations are recorded before creating their cgroup/staging directory. Restart
reconciliation kills dead-owner cgroups and removes staging; a populated leaf, inaccessible
path or failed removal remains charged and blocks admission. PID reuse conservatively blocks
recovery. An administrator must investigate a live-owner or persistent debt condition with the
feature disabled; never delete the journal merely to regain admission. Reconciliation runs at server initialization and on
workflow admission. Startup waits up to 500 ms for each killed leaf to empty; unresolved debt stays unhealthy. A restart does not automatically rerun a workflow or publication.

Every job also requires a finite common cgroup ancestor of the authenticated live engine PID,
server and converter tree: at most 4 GiB memory, zero swap, 512 pids and four CPUs, with at
least 640 MiB current memory headroom before admission. Missing engine membership or an
unbounded common ancestor fails closed. The trusted turn registry supplies the engine PID;
tool arguments cannot supply it. The systemd install runs the launcher and the server in
`<installation-id>.slice`; `mycel-ctl safe-ops on` bounds it (above). Qualify it on the target host. This bounds their combined
resource use; it is not a per-turn engine scheduler, measured host I/O rate or tenant fairness.
The headroom check is an admission snapshot, not an exclusive reservation against other tenants;
the common ancestor hard limit remains enforced by the kernel.

## Sources and approved connected-root contract

The only approved root for 1A is the configured team directory opened as a directory FD. Linux
1A image/presentation source access uses the native broker's `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`. There is no fallback when that syscall or these flags
are unavailable. Same-device bind mounts are also refused. Files must be regular, singly
linked and bounded. Native device/inode/size/mtime/ctime identity, hash, user/turn, source scope
and monotonic policy generation are persisted; reads re-open the path to reject moves or
replacement. Authorization and source versions are rechecked before publication/delivery.

No arbitrary connected mount root is approved in 1A. Existing connected-folder **copies**
already imported into the team tree may be read under their normal folder rules if they pass
the same no-mount walk. This is approval of the imported version, not authority to walk the
connector's external root. Direct NAS/bind/other-device mounts must first be imported through
the existing authorized copy workflow. A future connected-root implementation needs an explicit
administrator registry of held root identities, policy generations, mount lifetimes and revocation;
a path string or equal `st_dev` is insufficient. Team-root and directory topology remain under
trusted server/administrator control; hostile host administrators are outside this boundary.

Image delivery retains source scope and persisted versions, and rechecks at socket drain.
Queued output is discarded after revocation; bytes already accepted by the socket cannot be recalled.
The configured model provider remains an explicit authorized pixel recipient.

## Immutable publication and download-only quarantine

The chosen 1A option is **new immutable files**, never replacement of a mutable destination.
The broker copies the final validated bytes, hashes them, determines the final destination and
active audience, and binds widening approval to that hash, destination, audience, policy
generation and a unique publication ID. Artifact approvals bypass the legacy directory-level
approval cache. Normal policy approval suffices when there is no audience widening. Saving
under `skills/` is refused in this path; the old wildcard skill approval is not used.

Destination folders must already exist; safe publication does not create directories during approval.
If a requested name already exists, a new explicit `(conflict <UUID>)` file is approved. A writer
that wins the name after approval receives no overwrite: native `linkat` fails with `EEXIST`;
the operation fails and a new user/tool attempt needs a new final-target approval. The native
helper writes a hidden exclusive spool, verifies its hash, fsyncs it, links it without replacement,
removes the spool and fsyncs the held parent. Files are mode 0400 and application write/rename
operations refuse quarantined files. This is application/broker immutability; a trusted OS owner
or root can still chmod or replace files outside the application.

The journal (SQLite FULL synchronous) records source versions, historical chat scope, policy,
audience and cleanup state before disclosure. The final checks and native publication hold a
SQLite write transaction, serializing concurrent database policy writers. Policy triggers detect
revoke-and-restore changes too. A crash leaves a possibly-published journal entry: recovery
removes only its deterministic hidden spool, marks the result interrupted and never publishes it
again, overwrites a competing file, or infers ownership from equal content. A visible file may
remain after a crash before the success event; it stays quarantined. Failed recovery is debt.
The hash quarantine is durable before linkat, so a rollback of the final transaction is safe.
Broker-only native helpers require the expected server parent PID and arm Linux parent-death
SIGKILL on a locked OS thread; an orphan cannot continue a held operation after server exit.

Generated PPTX and normalized JPEG bytes are quarantined by hash. Published paths and observed
inodes are also protected; byte-identical copies/uploads and renamed extensions remain blocked.
There is **no automatic indexing, text extraction, AI read, thumbnail or in-app preview** of these
files. The file panel explains download-only status in ko/en/id/ja/es. Authorized downloads retain the
existing attachment and CSP protections. Normalized image blocks may go directly to the configured
model provider via the guarded MCP route; they never go through legacy OCR. Downloading a file
for an external Office/image application remains the user's action; validation does not certify
that application's parser. There is no qualified in-app consumer or preview origin yet.

Quarantine survives feature disable and restart. Schema reader level 4 prevents rollback to a server that omits current search admission and cache provenance. If an older binary is required, restore a matching **database
and team-file snapshot from before enablement**, not just the DB; otherwise generated files
would lose their quarantine records. Protect journal/source metadata with the same tenant DB
access/backup policy. A dedicated metadata retention/purge UI is deferred; do not erase quarantine
hashes while corresponding files or copies may remain.

The legacy flag-off PPTX count parser still runs in a separate bounded child. In a source checkout
its first build can synchronously block for up to 30 s; installed bundles contain the worker.
HWP rendering from the latest main retains its own opt-in and limits; its source admission
also refuses quarantined copies, including renamed extensions.

## Deferred work

**1B (ZIP):** no archive listing/extraction tool is added. Require selected-entry IDs, immutable
archive provenance, streaming metadata/entry/ratio budgets, inode/total workspace quotas, no
recursive extraction, independent file validation and isolated downstream consumers. General mutable-destination CAS, fair queuing, a per-turn engine/workspace controller, measured
cumulative CPU/I/O controls, and connected-root qualification remain future work. The new-file
journal/approval/quarantine contract above must be retained. Qualify Mac separately; do not infer parity from a configured profile.

**1C (Excel):** do not redo the existing 0.2.7 formula support. Extend the writer with explicit typed
cells and bounded rows/sheets/styles, a small reviewed internal formula grammar, and uncalculated
result labels. Workbook imports, external formulas, recalculation/rendering and arbitrary Python
remain deferred. Validate output before isolated indexing/preview/read, with cumulative XML/cell
budgets and the same publication/provenance contract.

**Release gates:** independent branch review, real pinned CLI image workflows, native codec advisory
and patch ownership/version qualification, operational hosted/medical review where applicable.
The feature flag is the immediate disable switch. This slice does not approve general execution.

## Search input admission (second-review remediation)

When quarantine records exist, content ripgrep never receives a live team or text-cache
directory. Its only live-tree operation is `--files` (names, no content). The broker authorizes each candidate, opens a
regular singly-linked file without following a final symlink, compares the authorized
identity to the descriptor, reads bounded bytes, and verifies descriptor nanosecond
mtime/ctime/size and the authorized path again. It hashes the actual copied buffer against
quarantine before any regex or character decoder sees it. Raw and CP949 passes share the
same private mode-0700 snapshot directory with mode-0400 files; type, glob, original
relative paths and line numbers are preserved. Copy, rename, replacement and newly published
paths cannot change that snapshot. Team-root topology and the server OS account remain trusted.

Admission and hash quarantine registration are serialized by SQLite IMMEDIATE transactions.
`safe_ops_search_inputs` holds a durable hash lease until all consumers exit and snapshot
cleanup succeeds. Database triggers reject quarantine insertion/update for a leased hash
and reject admission of a quarantined hash, including writes from other connections.
After integrating main e61bfda, the new HWP browser/AI rendering entry point also uses
non-download authorization and an admitted source held across rendering; changing a
quarantined copy to `.hwp` or `.hwpx` cannot reach preflight or the renderer.
A rare attempt to publish/normalize bytes that a current search already holds fails with a
localized retry message **before** publication/delivery; it is not silently admitted.
Unrelated publication continues. Office source bytes and their sidecars are also admitted;
semantic embedding holds its source lease across asynchronous embedding and index writes.
Semantic rows retain the original source hash, so query also rejects them before refresh
even after path replacement; refresh removes quarantined rows. Historical
downloads retain the same browser Fetch Metadata checks as current downloads.

Each raw/Office snapshot is bounded to 20,000 candidates and 256 MiB; existing 50 MiB/file,
query deadlines, cancellation and output limits remain. Input limits return an explicit
incomplete-result notice; narrow the search. Temporary input copies add local I/O and may
cost more than direct ripgrep, especially with many small files. Snapshot copying is
synchronous and bounded by the search deadline. Hash leases do not keep a DB write lock
while ripgrep or embedding runs. Grep results still carry no versioned model-context
provenance: publication requires an explicit read of every grep-only source.

After normal exit/cancellation, search snapshots and leases are deleted. A server crash or
failed cleanup conservatively leaves leases and possibly snapshots, since a child might
still be reading; **no timeout or PID-reuse guess expires a lease**. This can refuse later
registration of those exact hashes. Recovery requires stopping the whole tenant service
and its children, verifying no search/embedding consumers remain, removing only its owned
`<dataDir>/search-inputs/` snapshots (prefixes identify the lease), then clearing that tenant's `safe_ops_search_inputs`
and `safe_ops_empty_searches` rows while offline. Never clear `safe_ops_artifacts`, publication, inode or source records.
An ordinary restart is not proof that orphan children have exited. Back up the DB and files
together; do not downgrade the schema reader to work around a refusal.

## Never-used tenants and cache provenance (third review, migration 320)

When the artifact, publication and inode ledgers are all empty, a search acquires a
`safe_ops_empty_searches` lease in an IMMEDIATE transaction and uses the original live-tree
raw/CP949 and sidecar passes. It does not copy or hash every candidate. Database triggers
reject **all first artifact registrations** while this lease exists, on every connection;
publication registers quarantine before exposing bytes. If registration wins the race,
admission selects the immutable snapshot path instead. This is independent of the feature
flag, and is not a cached emptiness check. Existing artifacts always select snapshot admission.
The direct path preserves main's search limits; the 20,000-file/256 MiB snapshot bounds apply
only to the quarantined-tenant path. The exact 20,000-candidate boundary is complete when
there is no additional candidate.

The empty-ledger lease remains until the last ripgrep process exits. A crash conservatively
blocks the first new output registration, including outputs unrelated to the search. It
never blocks ordinary searches or clears quarantine. Offline recovery follows the procedure
above and clears **both** `safe_ops_empty_searches` and `safe_ops_search_inputs` only after
all service children and consumers have stopped. No PID or timeout automatically reaps them.
This adds two small database transactions per live search, rather than work per input file.

Office text cache format 5 records both the extraction source hash and text hash. Once
quarantine exists, searches and semantic ingestion admit that exact source and verify both
hashes before consuming the sidecar. Same-mtime source replacements and interleaved cache
writers cannot relabel old derived text. Old caches are rebuilt; semantic provenance version
2 also rebuilds old rows which may have been labelled with a replacement source hash.
Reader 4 prevents downgrade into a consumer unaware of these guarantees. Source directories,
cache directories, database and the server account remain trusted.

## Policy epoch audit (migration 319)

Migration 316's INSERT/DELETE triggers remain for all eight tables below. Every committed
revoke and restore advances the epoch even when the final policy is identical. Migration
319 replaces only the UPDATE triggers using null-safe `OLD.x IS NOT NEW.x` comparisons;
no-op assignments do not advance it. Applied migrations are unchanged. Transactions that
roll back do not advance the committed epoch; independent writers cannot lose increments.

| Table | Fields that advance the epoch on changed values | Fields excluded from UPDATE invalidation |
|---|---|---|
| users | id, username, password_hash, role, status, must_change_password, deleted_at, temp_password_expires_at | name, email, locale, created_at, prefs, last_seen_at, locale_follows_team, password_reset_by, password_reset_at, temp_password_failures |
| groups | id, folder_id | name, description (display labels; access uses group IDs and folder paths) |
| group_members | group_id, user_id | none |
| folders | id, path | created_at |
| folder_rules | id, folder_id, subject_type, subject_id, access | updated_by, updated_at |
| integrations | id, scope, owner_user_id, kind, slug, url, auth, auth_header, secret_enc, key_version, account, write_policy, status, tools_json, version | created_by, name, notes, last_error, tools_updated_at, last_used_at, created_at, updated_at |
| integration_access | integration_id, subject_type, subject_id | none |
| connected_folders | id, name, source | created_by, created_at, last_sync_at, last_status, last_error, files, bytes |

All migrations were searched for epoch writers: only 316 originally defines them; 318 adds
search admission guards and 319 narrows the eight UPDATE triggers. Session records and
connected-files sync metadata have no policy-epoch trigger. Real `createSession`, heartbeat,
connector calls and sync accounting no longer invalidate an unrelated workflow. Authority,
credentials, connector version/status or access changes still do. Synced source content
changes remain independently protected by source identity/hash checks. Tests enumerate
every schema column so future additions require an explicit classification.

The independent third-review report determines integration readiness; these fixes do not
authorize production enablement. Real pinned CLI/host qualification and customer notice gates remain.
Journal/quarantine lifetime retention still needs a capacity and safe retention policy.
