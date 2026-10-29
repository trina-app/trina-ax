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

Cancellation and timeouts kill the entire cgroup; the parent awaits exit and checks population
before removal. Job output/stderr is bounded and not streamed. Failed cleanup leaves a unique,
non-reusable leaf. Mac, missing controllers, ineffective limits, missing Landlock/bwrap or
`MYCEL_ISOLATION=none` never fall back to an unqualified implementation of the new operations.
Mac can still use legacy OCR and, with the flag off, the existing PowerPoint workflow.

## Authorization, publication and downstream consumers

Source bytes come from bounded regular-file snapshots: no symlinks, special files or multiple
links, held directory descriptors on Linux, no mount crossing within a source root. Identity,
size, timestamps and hash are checked again with fresh account/group/folder authorization.
Read-scope and source identity/hash stay attached to the turn; existing integration provenance
is retained. Images receive a final guard at the socket delivery boundary; revocation aborts
the turn and discards queued responses. Bytes already accepted by the socket are disclosed.
Connected roots on a different device are currently refused for the new pixel/PPTX source path.

The broker publishes its own validated byte buffer, never a worker-selected output path.
Policy stamps cover users, membership, folders and rules across asynchronous preparation and
widening approval. Final fresh authorization, destination hash/conflict comparison and install
have no intervening await. This serializes against this server's policy/save handlers, **not**
an independent process editing a filesystem at the same instant. Full cross-process destination
CAS, durable workspace state/recovery and artifact-bound one-use widening approvals remain open.

The old privileged PPTX count/notes parser now runs in a separate bounded worker before any save.
The 0.2.5 isolated Office extraction/indexing worker remains in use; no new privileged Office
parser is introduced. Legacy worker/Mac isolation still has its previously documented limitations.
No HWP implementation changes are included.

## Deferred work

**1B (ZIP):** no archive listing/extraction tool is added. Require selected-entry IDs, immutable
archive provenance, streaming metadata/entry/ratio budgets, inode/total workspace quotas, no
recursive extraction, independent file validation and isolated downstream consumers. Complete
cross-process destination CAS, durable job recovery/cleanup accounting, fair per-user admission,
artifact/hash/destination/policy-bound approval, aggregate cumulative CPU/I/O accounting and
connected-root qualification. Qualify Mac separately; do not infer parity from a configured profile.

**1C (Excel):** do not redo the existing 0.2.7 formula support. Extend the writer with explicit typed
cells and bounded rows/sheets/styles, a small reviewed internal formula grammar, and uncalculated
result labels. Workbook imports, external formulas, recalculation/rendering and arbitrary Python
remain deferred. Validate output before isolated indexing/preview/read, with cumulative XML/cell
budgets and the same publication/provenance contract.

**Release gates:** independent branch review, real pinned CLI image workflows, native codec advisory
and patch ownership/version qualification, operational hosted/medical review where applicable.
The feature flag is the immediate disable switch. This slice does not approve general execution.
