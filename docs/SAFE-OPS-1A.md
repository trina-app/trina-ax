# Safe operations 1A

This is a fixed-operation, Linux-only rollout behind `MYCEL_SAFE_OPS_1A=1` (default off).
There is no new shell, script, Python or general execution tool. The administrator enabling it
must authorize the configured model provider to receive document contents **including pixels**.
Metadata removal does not remove sensitive text in pixels. Medical deployments remain disabled
pending their separate provider/retention/purpose and clinical-output review.

Conversations used while enabled are persistently marked confidential. They retain only local
file, memory and conversation tools: browser, connectors, web fetch and provider/CLI web search
are disabled. Turning the flag off does not reopen egress in those conversations. Use a new
conversation for this workflow; already delivered data cannot be recalled. Other API engines
retain text/OCR only. Actual pinned Claude/Codex release qualification remains a release gate;
the automated integration tests exercise fake engines through the real MCP bridge and socket.

### Administrator rollout

After the release gates below have been approved, the Linux systemd installation reads
`/etc/default/<installation-id>` through `<installation-id>-server.service`. Set
`MYCEL_SAFE_OPS_1A=1` in that root-managed file and restart that server service. An unset
variable, `0`, or any value other than exactly `1` leaves new pixel/PPTX operations disabled.
Qualification is still required on every converter job; the variable never bypasses it.
Test a synthetic image and presentation on the target host before admitting confidential work.
Remove the setting (or set it to `0`) and restart the service to disable the feature.
Existing confidential conversations keep their egress restrictions. This procedure does not
approve medical use or replace the real pinned CLI and host qualification gates.

## Fixed operations and limits

- Image read: PNG, JPEG, WebP and HEIC/HEIF, 8 MiB compressed, 32 million decoded pixels,
  single frame, longest side 1536, canonical JPEG at most 1 MiB. Alpha is flattened to white;
  JPEG EXIF orientation is applied; metadata/GPS is not copied. HEIC uses the existing libheif
  executable inside the same sandbox; a 64 MiB intermediate and all job limits apply even
  before its decoded dimension check. Animated/multiple-image exports are refused.
- At most 4 MiB image blocks per turn. OCR remains available when the qualified pixel converter
  is unavailable. A corrupt/over-limit qualified decode fails instead of retrying a weaker decoder.
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
writable by other users. The helper applies required Landlock execution restrictions and the
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
wall deadline, including approval; retries consume quota. A null turn shares one user/hour
bucket. This is bounded rejection admission, **not a fair queue or an I/O bandwidth controller**.
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
tool arguments cannot supply it. Administrators must place the launcher/engines and server
under this bounded tenant ancestor and qualify it on the target host. This bounds their combined
resource use; it is not a per-turn engine scheduler, measured host I/O rate or tenant fairness.
The headroom check is an admission snapshot, not an exclusive reservation against other tenants;
the common ancestor hard limit remains enforced by the kernel.

## Sources and approved connected-root contract

The only approved root for 1A is the configured team directory opened as a directory FD. Linux
source access uses the native broker's `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
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
files. The file panel explains download-only status in ko/en/id. Authorized downloads retain the
existing attachment and CSP protections. Normalized image blocks may go directly to the configured
model provider via the guarded MCP route; they never go through legacy OCR. Downloading a file
for an external Office/image application remains the user's action; validation does not certify
that application's parser. There is no qualified in-app consumer or preview origin yet.

Quarantine survives feature disable and restart. Schema reader level 2 prevents rollback to an
older server that would ignore it. If an older binary is required, restore a matching **database
and team-file snapshot from before enablement**, not just the DB; otherwise generated files
would lose their quarantine records. Protect journal/source metadata with the same tenant DB
access/backup policy. A dedicated metadata retention/purge UI is deferred; do not erase quarantine
hashes while corresponding files or copies may remain.

The legacy flag-off PPTX count parser still runs in a separate bounded child. In a source checkout
its first build can synchronously block for up to 30 s; installed bundles contain the worker.
No HWP implementation is changed.

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

### Independent second-review limitations

Do not enable or describe this revision as release-approved. Raw grep still traverses permitted
directories and filters quarantined matches only after ripgrep has consumed the file; it does
not yet implement the required quarantine boundary before search consumption. This remains an
unresolved 1A acceptance requirement, not a feature deferred to general execution. Grep-only
reads retain paths/scopes but no immutable content version: final publication now refuses them
until the model explicitly reads each source. It never binds an earlier grep result to a newly
taken snapshot without that read. Semantic indexing now excludes quarantined files before
reading and drops their retained index rows; historical downloads enforce the same browser
Fetch Metadata restrictions as current-file downloads.

Journal lookup indexes avoid full-table scans on ordinary file access and admission. They do
not bound lifetime metadata growth; a retention/quota design must preserve quarantine identities
and unresolved cleanup debt. Deployment capacity and backup sizing must account for these records.

The current policy-generation triggers also invalidate workflows for non-policy updates, including
an unrelated user's login/session heartbeat (`users.last_seen_at`) and connector bookkeeping.
This fails closed but can repeatedly prevent image delivery or publication on an active team.
Audit policy-bearing columns and add real-session/connector concurrency tests before enablement;
preserve revoke-and-restore detection when narrowing those triggers.
