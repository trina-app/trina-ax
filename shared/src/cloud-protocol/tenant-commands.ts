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

const Count = z.number().int().min(0).max(1_000_000)
/**
 * A team's first days, for the hosting operator's activation mails (day 1 / 3 / 5) and its list of teams to contact
 * (day 3 with no invite or no successful answer). Counts and yes/no only: never a name, mail, skill name or path.
 * "The window" is the first 7 days from the team's first account; counts inside it stop changing after it.
 */
export const TenantOnboarding = z.strictObject({
  /** whole days since the team's first account was made (0 on that day) */
  day: z.number().int().min(0).max(100_000),
  /** recommended skills are in the team folder (skills/general/ or skills/work/ holds a skill; or skills/marketing/ or
   * skills/hr/, the packs of older releases) */
  packInstalled: z.boolean(),
  /** a company profile is saved (skills/company-profile.json with a field filled in) */
  profileSaved: z.boolean(),
  /** someone made an invite or a team invite link, or someone joined */
  inviteMade: z.boolean(),
  /** accounts made after the first one, deleted ones included */
  membersJoined: Count,
  /** people (the owner included) with a successful answer in the window */
  peopleAnswered: Count,
  /** people (the owner included) who ran a team skill in a successful answer in the window */
  membersWithFirstRun: Count,
  /** the most people who ran one and the same team skill in the window */
  bestSkillRunners: Count,
  /** 3 or more people ran the same team skill in the window (the trial's goal) */
  goalReached: z.boolean(),
})
export type TenantOnboarding = z.infer<typeof TenantOnboarding>
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
  /** optional and opt-in (`status --onboarding`, added for the onboarding goal): only when the reader asked for it,
   * and then left out by older servers and while the team has no account. The schema is strict, so the order is: the
   * control plane accepts the field, then ax-hostd asks for it */
  onboarding: TenantOnboarding.optional(),
})
export type TenantStatus = z.infer<typeof TenantStatus>

/**
 * The `TenantStatus.checks` ids that are `fail` on a freshly installed hosted team that nobody has set up yet (no AI
 * connection added): the team server's diagnostics (server/src/system/ops.ts) say so, and `overall` is `fail` because
 * of them. The control plane's update gate (Trina Cloud rule F-14) must not read these as a broken update: it rolls
 * back only on checks that were not failing before the update. tests/unit/fresh-team-failing-checks.test.ts runs the
 * diagnostics of such a team and fails when this list and the diagnostics disagree: a new check that fails on a fresh
 * team goes here, and the control plane is told.
 */
export const FRESH_TEAM_FAILING_CHECKS: readonly string[] = Object.freeze(['engine.claude-code'])

/** set-server-config: the server.json keys the control plane may change (anything else is refused). publicOrigins
 * follow HttpsUrl like everywhere in these contracts: https, http only to this machine (dev / tests). */
export const ServerConfigPatch = z.strictObject({
  relay: z.strictObject({ teamName: TeamSlug }).optional(),
  publicOrigins: z.array(HttpsUrl).max(10).optional(),
  engine: z.strictObject({ credentialKinds: z.array(CredentialKind).min(1).max(4) }).optional(),
}).refine((p) => p.relay !== undefined || p.publicOrigins !== undefined || p.engine !== undefined, 'nothing to change')

/** An OpenRouter API key ("sk-or-v1-…"). It is only ever in hosted-speech-key-set's stdin. */
export const OpenRouterApiKey = z.string().regex(/^sk-or-[A-Za-z0-9_-]{16,200}$/)
/** hosted-speech-key-set's stdin: the OpenRouter key the hosting service gives this team for speech-to-text (hosted
 * voice input and video sound, the plan's free hours a team a month: PlanFile speechFreeHours, else 10, counted by
 * the app), or null to take it away. The app keeps it encrypted with its credentials vault and never shows, logs or
 * audits it; a key the team entered itself always comes first. */
export const HostedSpeechKeyInput = z.strictObject({ key: OpenRouterApiKey.nullable() })
export type HostedSpeechKeyInput = z.infer<typeof HostedSpeechKeyInput>

/** A Sentry project key (DSN): https://<public key>@<host>[:port][/<prefix>...]/<project id>, the shape
 * shared/src/sentry-report.ts parseDsn reads. The whole value must match (mycel-ctl checks the same pattern): it becomes
 * a line of the team server's environment file, so a newline, quote, backslash, space or "=" is refused. */
export const SentryDsn = z.string().max(1000).regex(/^https:\/\/[A-Za-z0-9]{1,128}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,9}(:[0-9]{1,5})?(\/[A-Za-z0-9_-]{1,64}){0,4}\/[0-9]{1,20}$/)
/** error-reports-set's stdin: the hosting service's error report key for this team server (the server's
 * MYCEL_ERROR_REPORT_URL, trina-ax docs/decisions/20261119-hosted-error-reports.md), or null to take it away. */
export const ErrorReportsInput = z.strictObject({ url: SentryDsn.nullable() })
export type ErrorReportsInput = z.infer<typeof ErrorReportsInput>
/** error-reports-set's answer. changed: the environment file changed (false when it already held this value, or none
 * for null, so the same input may be sent again at any time). restarted: the server was restarted to read it, once no
 * answer has run for up to 60 s. That happens on a change, and also without one when the running server started before
 * the file last changed (an earlier call found it busy), so a resend finishes what a busy call left; false otherwise
 * (busy: it reads the value at its next start, or at the next resend). */
export const ErrorReportsResult = z.object({ ok: z.literal(true), changed: z.boolean(), restarted: z.boolean() })
export type ErrorReportsResult = z.infer<typeof ErrorReportsResult>

/** The mail service's https origin for room email (the team server's MYCEL_MAIL_IN_URL, server/src/rooms/apps/mail/
 * client.ts): https://<lower-case DNS name>[:port], no path. mycel-ctl checks the same pattern: the value becomes a line
 * of the team server's environment file, so a newline, quote, backslash, space or "=" is refused. */
export const MailInOrigin = z.string().max(300).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,9}(?::[0-9]{1,5})?$/)
/** The domain of the room addresses (the team server's MYCEL_MAIL_IN_DOMAIN): a lower-case DNS name, as client.ts reads it. */
export const MailInDomain = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,9}[a-z]{2,63}$/)
/** mail-in-set's stdin: the hosting service's mail service for room email (trina-ax docs/runbooks/room-email-mailbox.md),
 * both values, or both null to take them away. A team server needs both, else it has no Email. Turned on per team by
 * the hosting service; the team's admin switch "Let rooms get email" still decides. */
export const MailInSetInput = z.union([
  z.strictObject({ url: MailInOrigin, domain: MailInDomain }),
  z.strictObject({ url: z.null(), domain: z.null() }),
])
export type MailInSetInput = z.infer<typeof MailInSetInput>
/** mail-in-set's answer: as ErrorReportsResult (changed: a line of the environment file changed; restarted: the server
 * was restarted to read it, once no answer has run for up to 60 s, also on a resend after an earlier busy call). */
export const MailInSetResult = ErrorReportsResult
export type MailInSetResult = z.infer<typeof MailInSetResult>

/** github-app-set's stdin: the GitHub App the team server's GitHub connector signs in through (trina-ax
 * server/src/integrations/github/app.ts reads it from <secrets>/integrations/github/app.json; its rules are at least
 * this wide). slug: the app's name in github.com/apps/<slug>. The secret is printable ASCII without spaces. It is only
 * ever on stdin: never an argument, never in the answer. */
export const GitHubAppFile = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  clientSecret: z.string().regex(/^[!-~]{1,4096}$/),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional(),
})
export type GitHubAppFile = z.infer<typeof GitHubAppFile>
/** github-app-set's answer. changed: the file changed (false when it already held these values, so the same input may
 * be sent again at any time). The server reads the file at each request: no restart. */
export const GitHubAppResult = z.object({ ok: z.literal(true), changed: z.boolean() })
export type GitHubAppResult = z.infer<typeof GitHubAppResult>

/** microsoft-app-set's stdin: the Microsoft (Entra) app the team server's Microsoft 365 connector signs in through
 * (trina-ax server/src/integrations/microsoft/app.ts reads it from <secrets>/integrations/microsoft/app.json; its rules
 * are at least this wide). clientId: the application (client) ID, a GUID. tenant: the authority's tenant (default
 * common). The secret is printable ASCII without spaces, only ever on stdin. */
const MicrosoftGuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export const MicrosoftAppFile = z.strictObject({
  clientId: MicrosoftGuid,
  clientSecret: z.string().regex(/^[!-~]{1,4096}$/),
  tenant: z.union([z.enum(['common', 'organizations', 'consumers']), MicrosoftGuid]).optional(),
})
export type MicrosoftAppFile = z.infer<typeof MicrosoftAppFile>
/** microsoft-app-set's answer: as GitHubAppResult (the server reads the file at each request: no restart) */
export const MicrosoftAppResult = GitHubAppResult
export type MicrosoftAppResult = z.infer<typeof MicrosoftAppResult>

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

export const ExportInput = z.object({
  partSize: PartSize, partUrls: PartUrls,
  /** also the plain ZIP for people (folders, chats as text and JSON, README.txt), age-encrypted to this one-time
   * recipient of the control plane, which decrypts it only while a signed-in owner downloads it. An older team
   * server ignores the key and answers without `zip`. */
  zip: z.object({ recipient: AgeRecipient, partSize: PartSize, partUrls: PartUrls }).optional(),
})
export type ExportInput = z.infer<typeof ExportInput>
export const ExportResult = z.object({
  /** random passphrase of the age (scrypt) file; the control plane shows it to the owner once. Since the plain ZIP:
   * eight groups of five from 23456789abcdefghjkmnpqrstuvwxyz joined by "-" (no 0/o, 1/l/i to mix up) */
  passphrase: z.string().min(20).max(200),
  size: z.number().int().nonnegative(), sha256: Sha256Hex, parts: z.array(UploadedPart).min(1),
  /** the encrypted plain ZIP, when the input asked for it */
  zip: z.object({ size: z.number().int().nonnegative(), sha256: Sha256Hex, parts: z.array(UploadedPart).min(1) }).optional(),
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
  /** onboarding: add TenantStatus.onboarding (opt-in: a reader that does not ask gets the earlier shape, and the
   * tenant does not count it). ax-hostd sends it only after its contract sync, and retries without it when an older
   * mycel-ctl refuses the flag (exit 2, unknown flag). */
  status: { args: z.strictObject({ onboarding: z.literal(true).optional() }), stdin: null, output: TenantStatus, timeoutSec: 15 },
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
  /** grow the data disk's ext4 file system to its block device's size, online (resize2fs; nothing to do when they
   * match). The hosting service calls it after it made the disk bigger (a trial team that starts to pay) when the
   * file system still shows the old size; the image's udev rule normally grows it already. Sizes: statfs of the data
   * folder before and after. */
  'data-grow': { args: NoArgs, stdin: null, output: z.object({ grown: z.boolean(), beforeBytes: z.number().int().nonnegative(), afterBytes: z.number().int().nonnegative() }), timeoutSec: 120 },
  'prepare-stop': { args: z.strictObject({ grace: z.number().int().min(0).max(3600) }), stdin: null, output: z.object({ stopped: z.boolean() }), timeoutSec: (a) => Number(a.grace ?? 0) + 60 },
  update: { args: z.strictObject({ version: Version }), stdin: null, output: UpdateResult, timeoutSec: 1800 },
  /** localId: a given local backup (the control plane walks an incremental chain back to its full archive) */
  'backup-prepare': { args: z.strictObject({ kind: BackupKindArg, localId: LocalBackupId.optional() }), stdin: null, output: BackupPrepareResult, timeoutSec: 7200 },
  'backup-upload': { args: NoArgs, stdin: BackupUploadInput, output: BackupUploadResult, timeoutSec: 21_600 },
  export: { args: NoArgs, stdin: ExportInput, output: ExportResult, timeoutSec: 21_600 },
  'reset-link': {
    /** the owner, or the account with this username (the team server's username rule). Exit 3, stdout empty
     * (owner_recovery_locked): the team changed hands with handoverSafe on, and owners and admins get no link until the
     * new owner claims recovery (owner-recovery-claimed); a member still does. */
    args: z.union([z.strictObject({ owner: z.literal(true) }), z.strictObject({ username: AccountUsername })]),
    stdin: null, output: z.object({ url: HttpsUrl, expiresAt: IsoTime }), timeoutSec: 30,
  },
  /** the new owner of a hosted team claimed recovery (a recovery and billing contact) in the console: reset links for
   * owners and admins may go out again (trina-ax docs/DECISIONS.md W6 "Hosted teams"). `cleared`: there was a lock. */
  'owner-recovery-claimed': { args: NoArgs, stdin: null, output: z.object({ ok: z.literal(true), cleared: z.boolean() }), timeoutSec: 30 },
  /** the hosting service's speech-to-text key (HostedSpeechKeyInput); `set`: whether the server holds one now */
  'hosted-speech-key-set': { args: NoArgs, stdin: HostedSpeechKeyInput, output: z.object({ ok: z.literal(true), set: z.boolean() }), timeoutSec: 30 },
  /** the hosting service's error report key (ErrorReportsInput, ErrorReportsResult). Idempotent: send it again when
   * unsure (a reimage or restore writes the environment file anew). It waits up to 60 s for running answers. */
  'error-reports-set': { args: NoArgs, stdin: ErrorReportsInput, output: ErrorReportsResult, timeoutSec: 120 },
  /** the hosting service's GitHub App (GitHubAppFile, GitHubAppResult). Idempotent: send it again when unsure. */
  'github-app-set': { args: NoArgs, stdin: GitHubAppFile, output: GitHubAppResult, timeoutSec: 30 },
  /** the hosting service's Microsoft app (MicrosoftAppFile, MicrosoftAppResult). Idempotent: send it again when unsure. */
  'microsoft-app-set': { args: NoArgs, stdin: MicrosoftAppFile, output: MicrosoftAppResult, timeoutSec: 30 },
  /** the hosting service's mail service for room email (MailInSetInput, MailInSetResult): MYCEL_MAIL_IN_URL and
   * MYCEL_MAIL_IN_DOMAIN in the environment file. Idempotent: send it again when unsure. Waits up to 60 s for running answers. */
  'mail-in-set': { args: NoArgs, stdin: MailInSetInput, output: MailInSetResult, timeoutSec: 120 },
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
