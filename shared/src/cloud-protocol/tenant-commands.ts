// Tenant commands (control-plane 3.5.3): the control plane's only way into a tenant. ax-hostd job `tenantCommand`
// runs `/var/lib/mycel/root/mycel-ctl <command> --json [--<arg> <value>]...` through the QEMU guest agent with
// `input-data` = the stdin JSON, waits for it and returns { exitCode, stdout } (stdout parsed as JSON, at most 1 MiB).
// ax-hostd refuses a command that is not in this list, or args / stdin that do not match its schema, with the error
// code `command_not_allowed` (no shell, no paths). MIT (see LICENSE in this folder).
//
// Arguments are flat key → string | number | boolean, passed as `--key value` (`--key` alone for true; false = left
// out). mycel-ctl does root work itself and hands app-level work to the server account's admin.js (SV-5).
import { z } from 'zod'
import { AccountUsername, AgeArmored, AgeRecipient, CredentialKind, HttpsUrl, IsoTime, RelayTeamId, Sha256Hex, SignatureB64, Ed25519PublicKeyB64, TeamSlug, VersionString } from './common.ts'
import { NoticesFile, PlanFile, RelayRegistrationFile } from './files.ts'

export const TENANT_COMMAND_NOT_ALLOWED = 'command_not_allowed'
/** largest stdout the guest agent hands back */
export const TENANT_STDOUT_MAX = 1 << 20

const Ok = z.object({ ok: z.literal(true) })
const NoArgs = z.object({}).strict()
const Version = VersionString
const LocalBackupId = z.string().regex(/^[0-9]{8}T[0-9]{6}Z-(daily|manual|pre-update|final)(-[0-9]+)?$/)
/** a backup file's name inside the backup (db.sqlite.zst, team.tar.zst, manifest.json, ...) */
const BackupFileName = z.string().regex(/^[a-z0-9._-]{1,64}$/)
/** R2 multipart parts: 5 MiB - 5 GiB each, at most 10,000 (control-plane 3.8.2 uses 64 MiB) */
export const PartSize = z.number().int().min(5 * 1024 * 1024).max(5 * 1024 ** 3)
const PartUrls = z.array(HttpsUrl).min(1).max(10_000)
export const UploadedPart = z.object({ n: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) })
export type UploadedPart = z.infer<typeof UploadedPart>

/** idle-wait output; the fields after `running` come only with --activity (F2 sleep). */
export const IdleWaitResult = z.object({
  idle: z.boolean(),
  running: z.number().int(),
  sleepable: z.boolean().optional(),
  /** seconds since the last signed-in request, open connection or running answer (null = unknown) */
  idleForSec: z.number().int().nonnegative().nullable().optional(),
  /** open realtime connections (web, desktop and mobile apps) */
  connections: z.number().int().nonnegative().nullable().optional(),
  /** seconds until the next enabled schedule is due (0 = due now), null = none */
  nextScheduleInSec: z.number().int().nonnegative().nullable().optional(),
})
export type IdleWaitResult = z.infer<typeof IdleWaitResult>
/** a team is not sleepable when a schedule is due within this many seconds (plan §1 "What idle means") */
export const SLEEP_SCHEDULE_GUARD_SEC = 15 * 60

/** What `status` reports (60 s, ax-hostd → control plane). No conversation, file name, person, mail, IP or token. */
export const TenantStatus = z.strictObject({
  at: IsoTime,
  kitVersion: z.string().max(40),
  rootVersion: z.string().max(40),
  app: z.strictObject({
    version: z.string().max(40).nullable(),
    health: z.enum(['ok', 'fail', 'down']),
    schemaApplied: z.number().int().nullable(),
    readerLevel: z.number().int().nullable(),
    uptimeSec: z.number().int().nullable(),
  }),
  setupNeeded: z.boolean().nullable(),
  activeMembers: z.number().int().nullable(),
  queue: z.strictObject({ running: z.number().int(), queued: z.number().int() }).nullable(),
  relay: z.strictObject({
    state: z.enum(['connected', 'connecting', 'offline', 'replaced', 'not_registered', 'disabled']),
    /** a code (awaiting_operator, auth_failed, ...), never free text */
    detail: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable(),
  }).nullable(),
  lastLocalBackup: z.strictObject({ id: LocalBackupId, at: IsoTime }).nullable(),
  lastUploadedLocalId: LocalBackupId.nullable(),
  overall: z.enum(['ok', 'warn', 'fail', 'unknown']),
  /** diagnostics check ids and results only (no texts) */
  checks: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9_.-]{1,64}$/), status: z.enum(['ok', 'warn', 'fail', 'unknown']) })).max(100),
  ai: z.strictObject({ claude: z.enum(['none', 'ok', 'problem']), codex: z.enum(['none', 'ok', 'problem']) }),
  credentialsKey: z.strictObject({ present: z.boolean(), version: z.number().int().nullable() }),
  resources: z.strictObject({
    memCurrent: z.number().nonnegative(), memMax: z.number().nonnegative(), oomKills: z.number().int().nonnegative(),
    cpuPressureSome10: z.number().nonnegative(), ioPressureSome10: z.number().nonnegative(),
    diskUsed: z.number().nonnegative(), diskTotal: z.number().nonnegative(),
  }),
  update: z.strictObject({ running: z.boolean(), step: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullable() }),
})
export type TenantStatus = z.infer<typeof TenantStatus>

/** set-server-config: the server.json keys the control plane may change (anything else is refused). publicOrigins
 * follow HttpsUrl like everywhere in these contracts: https, http only to this machine (dev / tests). */
export const ServerConfigPatch = z.strictObject({
  relay: z.strictObject({ teamName: TeamSlug }).optional(),
  publicOrigins: z.array(HttpsUrl).max(10).optional(),
  engine: z.strictObject({ credentialKinds: z.array(CredentialKind).min(1).max(4) }).optional(),
}).refine((p) => p.relay !== undefined || p.publicOrigins !== undefined || p.engine !== undefined, 'nothing to change')

export const BackupKindArg = z.enum(['daily', 'manual', 'pre-update', 'final'])

/** backup-prepare's answer (admin.js cloud-backup prepare) */
export const BackupPrepareResult = z.object({
  localId: LocalBackupId,
  scope: z.enum(['db', 'full', 'incremental']),
  /** the local backup this incremental builds on (its local id), null for a full one or a DB-only one */
  base: LocalBackupId.nullable(),
  /** plaintext sizes, so the control plane can size the multipart upload (parts = ceil(plainSize × 1.001 / partSize) + 1) */
  files: z.array(z.object({ name: BackupFileName, plainSize: z.number().int().nonnegative() })).min(1).max(16),
  /** the server's BackupMeta of that backup (system/backup.ts), passed through */
  meta: z.record(z.string(), z.unknown()),
  /** what a full restore of this backup holds (team files and bytes from its manifest, DB schema): the restore
   * test's `expect` (null for a DB-only backup) */
  totals: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), schemaVersion: z.number().int().nonnegative() }).nullable().default(null),
})
export type BackupPrepareResult = z.infer<typeof BackupPrepareResult>

export const BackupUploadInput = z.object({
  localId: LocalBackupId,
  /** [team recipient, organisation recovery recipient]: either one alone decrypts */
  recipients: z.array(AgeRecipient).min(1).max(4),
  files: z.array(z.object({ name: BackupFileName, key: z.string().min(1).max(512), partSize: PartSize, partUrls: PartUrls })).min(1).max(16),
})
export type BackupUploadInput = z.infer<typeof BackupUploadInput>
export const UploadedFile = z.object({ name: BackupFileName, size: z.number().int().nonnegative(), sha256: Sha256Hex, parts: z.array(UploadedPart).min(1) })
export const BackupUploadResult = z.object({ files: z.array(UploadedFile).min(1) })
export type BackupUploadResult = z.infer<typeof BackupUploadResult>

export const ExportInput = z.object({ partSize: PartSize, partUrls: PartUrls })
export type ExportInput = z.infer<typeof ExportInput>
export const ExportResult = z.object({
  /** random passphrase of the age (scrypt) file; the control plane shows it to the owner once */
  passphrase: z.string().min(20).max(200),
  size: z.number().int().nonnegative(), sha256: Sha256Hex, parts: z.array(UploadedPart).min(1),
})
export type ExportResult = z.infer<typeof ExportResult>

export const UpdateResult = z.object({
  from: z.string().max(40), to: z.string().max(40),
  /** mycel-ctl update --json (linux-runtime 3.6.5); exit codes 0 / 10 / 20 / 30 / 1 */
  result: z.enum(['ok', 'rolled_back', 'verify_failed', 'busy', 'error']),
  rootUpdated: z.boolean(), durationMs: z.number().int().nonnegative(),
})

interface CommandDef {
  args: z.ZodType
  stdin: z.ZodType | null
  output: z.ZodType
  /** seconds ax-hostd waits; a function of the args for the commands that wait themselves */
  timeoutSec: number | ((args: Record<string, string | number | boolean>) => number)
}

export const TENANT_COMMANDS = {
  status: { args: NoArgs, stdin: null, output: TenantStatus, timeoutSec: 15 },
  'apply-plan': { args: NoArgs, stdin: PlanFile, output: Ok, timeoutSec: 60 },
  'notices-set': { args: NoArgs, stdin: NoticesFile, output: Ok, timeoutSec: 30 },
  'set-server-config': { args: NoArgs, stdin: ServerConfigPatch, output: z.object({ ok: z.literal(true), restarted: z.boolean() }), timeoutSec: 120 },
  'relay-registration-set': { args: NoArgs, stdin: z.strictObject({ relayRegistration: RelayRegistrationFile }), output: Ok, timeoutSec: 120 },
  'relay-key-proof': { args: z.strictObject({ teamId: RelayTeamId }), stdin: null, output: z.object({ publicKey: Ed25519PublicKeyB64, sig: SignatureB64 }), timeoutSec: 15 },
  /** idle = no answer runs (reimage, resize and reboot wait on it). With `activity` (F2 sleep, a newer mycel-ctl) the
   * output adds the facts the control plane's sleep policy needs: open web/desktop/mobile connections, seconds since
   * the last signed-in request, open socket or running answer, and seconds to the next due schedule. Durations, not
   * times: the guest clock can be behind after a resume. sleepable = no answer, no connection, no schedule in 15 min,
   * and the server's status is fresh. An older mycel-ctl refuses --activity (usage error): the control plane reads
   * that as "not sleepable". */
  'idle-wait': { args: z.strictObject({ max: z.number().int().min(0).max(3600), activity: z.literal(true).optional() }), stdin: null, output: IdleWaitResult, timeoutSec: (a) => Number(a.max ?? 0) + 30 },
  'prepare-stop': { args: z.strictObject({ grace: z.number().int().min(0).max(3600) }), stdin: null, output: z.object({ stopped: z.boolean() }), timeoutSec: (a) => Number(a.grace ?? 0) + 60 },
  update: { args: z.strictObject({ version: Version }), stdin: null, output: UpdateResult, timeoutSec: 1800 },
  /** localId: a given local backup (the control plane walks an incremental chain back to its full archive) */
  'backup-prepare': { args: z.strictObject({ kind: BackupKindArg, localId: LocalBackupId.optional() }), stdin: null, output: BackupPrepareResult, timeoutSec: 7200 },
  'backup-upload': { args: NoArgs, stdin: BackupUploadInput, output: BackupUploadResult, timeoutSec: 21_600 },
  export: { args: NoArgs, stdin: ExportInput, output: ExportResult, timeoutSec: 21_600 },
  'reset-link': {
    /** the owner, or the account with this username (the team server's username rule) */
    args: z.union([z.strictObject({ owner: z.literal(true) }), z.strictObject({ username: AccountUsername })]),
    stdin: null, output: z.object({ url: HttpsUrl, expiresAt: IsoTime }), timeoutSec: 30,
  },
  'setup-token-rotate': { args: NoArgs, stdin: null, output: z.object({ setupToken: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/) }), timeoutSec: 120 },
  /** keyAge decrypts to the key file's line: "<base64 32 bytes>" for version 1, "credentials.key.<N> <base64>" for a
   * later version (after credentials-rekey). The control plane keeps it as is and hands it back in
   * EnrollRestore.credentialsKeyAge; mycel-enroll writes it under that file name. */
  'credentials-escrow-out': {
    args: z.strictObject({ recipient: AgeRecipient }), stdin: null,
    output: z.union([z.object({ keyAge: AgeArmored, keyVersion: z.number().int().min(1) }), z.object({ absent: z.literal(true) })]),
    timeoutSec: 30,
  },
} as const satisfies Record<string, CommandDef>

export type TenantCommandName = keyof typeof TENANT_COMMANDS
export const TenantCommandName = z.enum(Object.keys(TENANT_COMMANDS) as [TenantCommandName, ...TenantCommandName[]])
export type CommandArgs<C extends TenantCommandName> = z.input<(typeof TENANT_COMMANDS)[C]['args']>
export type CommandStdin<C extends TenantCommandName> = (typeof TENANT_COMMANDS)[C]['stdin'] extends z.ZodType ? z.input<NonNullable<(typeof TENANT_COMMANDS)[C]['stdin']>> : null
export type CommandResult<C extends TenantCommandName> = z.infer<(typeof TENANT_COMMANDS)[C]['output']>

/** ax-hostd's gate: null when the command may run, else why not (answer with TENANT_COMMAND_NOT_ALLOWED). */
export function tenantCommandProblem(command: string, args: unknown, stdin: unknown): string | null {
  if (!Object.hasOwn(TENANT_COMMANDS, command)) return `unknown command ${JSON.stringify(command).slice(0, 80)}`
  const def = TENANT_COMMANDS[command as TenantCommandName] as CommandDef
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'args must be an object'
  for (const [k, v] of Object.entries(args)) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(k)) return `bad argument name ${k}`
    if (!['string', 'number', 'boolean'].includes(typeof v)) return `argument ${k} must be a string, number or boolean`
  }
  const a = def.args.safeParse(args)
  if (!a.success) return `args: ${a.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
  if (def.stdin === null) return stdin === null || stdin === undefined ? null : 'this command takes no stdin'
  const s = def.stdin.safeParse(stdin)
  return s.success ? null : `stdin: ${s.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
}

export function tenantCommandTimeoutSec(command: TenantCommandName, args: Record<string, string | number | boolean>): number {
  const t = (TENANT_COMMANDS[command] as CommandDef).timeoutSec
  return typeof t === 'number' ? t : t(args)
}

/** The argv mycel-ctl gets (after `mycel-ctl`): command, --json, then the args in key order. */
export function tenantCommandArgv(command: TenantCommandName, args: Record<string, string | number | boolean>): string[] {
  const out: string[] = [command, '--json']
  for (const k of Object.keys(args).sort()) {
    const v = args[k]!
    if (v === false) continue
    const flag = '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
    if (v === true) out.push(flag)
    else out.push(flag, String(v))
  }
  return out
}
