// Files the installed server, the bootstrap (native/cmd/mycel-bootstrap, Go), the installer scripts and the menubar
// app (Swift) exchange on disk. Owner: component G. Design tab 6 ("파일 위치와 제거", "업데이트", "상태 읽기").
//
//   <base>/app/versions/<version>/   one release bundle (bin/bun, server/, native/, web/, manifest.json [+ .sig])
//   <base>/app/current -> versions/<version>
//   <base>/app/state.json            AppState: what runs, what was before, a pending update, roll-back history
//   <base>/status/status.json        StatusFile: written by the server every 30 s for the menubar app (admin group)
//   <base>/data/restore-pending.json RestorePending: the server swaps app.db before opening it on the next start
// The Go bootstrap reads/writes AppState and verifies BundleManifest with the same field names; keep them in sync.
import { z } from 'zod'

/** sha256 of every file of a release bundle; the bootstrap refuses to start a version that does not match. */
export const BundleManifest = z.object({
  format: z.literal(1),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/),
  createdAt: z.string(),
  /** relative path (forward slashes) -> file facts; directories are implied */
  files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative(), mode: z.number().int() })),
})
export type BundleManifest = z.infer<typeof BundleManifest>

/** manifest.sig next to manifest.json: Ed25519 over the exact bytes of manifest.json (release key, kept offline). */
export const BundleSignature = z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), sig: z.string() })
export type BundleSignature = z.infer<typeof BundleSignature>

export const UpdateHistoryEntry = z.object({
  at: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  result: z.enum(['ok', 'rolled_back', 'verify_failed']),
  detail: z.string().nullable(),
})

export const AppState = z.object({
  format: z.literal(1),
  /** version current points to after the last successful start */
  current: z.string().nullable(),
  /** version kept for roll-back */
  previous: z.string().nullable(),
  /** set by the server when it switched current to a new version; cleared by the bootstrap when /api/health is ok */
  pending: z.string().nullable(),
  pendingSince: z.string().nullable(),
  /** starts of the pending version that died before becoming healthy */
  attempts: z.number().int().nonnegative(),
  history: z.array(UpdateHistoryEntry).max(50),
})
export type AppState = z.infer<typeof AppState>
export const emptyAppState = (): AppState => ({ format: 1, current: null, previous: null, pending: null, pendingSince: null, attempts: 0, history: [] })

/** status/status.json for the menubar app (tab 6 "상태 읽기"). No private data: no names, no chat content. */
export const StatusFile = z.object({
  format: z.literal(1),
  writtenAt: z.string(),
  version: z.string(),
  pid: z.number().int(),
  /** web address people open (team address, else the local URL) */
  webUrl: z.string(),
  /** http://127.0.0.1:<port>: the menubar app's health check (GET /api/health) */
  localUrl: z.string(),
  /** LaunchDaemon label prefix (the menubar app reads launchctl print system/<label>.server when health fails) */
  label: z.string().nullable(),
  logsDir: z.string().nullable(),
  connection: z.object({
    mode: z.string(),
    state: z.enum(['connected', 'connecting', 'offline', 'replaced', 'not_registered', 'disabled']),
    address: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  queue: z.object({ running: z.number().int(), queued: z.number().int() }),
  firewall: z.enum(['ok', 'warn', 'fail', 'unknown']),
  sandbox: z.enum(['ok', 'warn', 'fail', 'unknown']),
  lastBackupAt: z.string().nullable(),
  /** worst diagnostic status, for the menubar icon */
  overall: z.enum(['ok', 'warn', 'fail', 'unknown']),
  /** short problem lines (Korean by default; the menubar shows them as is) */
  problems: z.array(z.string()).max(20),
})
export type StatusFile = z.infer<typeof StatusFile>

export const RestorePending = z.object({
  format: z.literal(1),
  /** staged copy inside the data folder, already integrity-checked */
  file: z.string(),
  backupId: z.string(),
  requestedAt: z.string(),
  requestedBy: z.string().nullable(),
})
export type RestorePending = z.infer<typeof RestorePending>

/** pf-load (root, every 5 min) writes run/pf.json (root-owned folder): the server cannot read /dev/pf. A root job never
 * writes into status/ or other folders the server account owns (a planted symlink would redirect the write). */
export const PfStatus = z.object({
  format: z.literal(1),
  at: z.string(),
  enabled: z.boolean(),
  anchor: z.string(),
  /** rules currently loaded in our anchor */
  rules: z.number().int().nonnegative(),
  /** the main ruleset references anchor "com.apple/*" (otherwise our anchor is never evaluated) */
  referenced: z.boolean(),
})
export type PfStatus = z.infer<typeof PfStatus>
