// Admin command line for the installed server (component G). Bundled as server/src/admin.js next to main.js and run
// as the server account by the admin scripts (scripts/*-macos.sh) and the install test:
//
//   sudo -u _axserver <base>/app/current/bin/bun <base>/app/current/server/src/admin.js <command> ...
//
// Commands (MYCEL_CONFIG / MYCEL_MODE=prod select the installation, like the server itself):
//   backup [--scope db|full] [--kind pre-update] back up now (same as the nightly backup; the office updater marks
//                                                its own as pre-update)
//   list-backups                                 JSON list
//   archive --out <file> [--password-stdin]      DB + team folder in one .tar.zst(.age) stream, for an external disk
//   restore-archive --in <file> --to <dir> [--password-stdin]
//                                                decrypt + unpack into a NEW folder; it appears only when the whole
//                                                archive decrypted and unpacked cleanly and the DB passes its check
//   restore-team --backup <id> --to <dir>        rebuild the team folder as it was at a backup (new folder)
//   stage-restore --backup <id>                  check a DB backup and stage it; the server swaps it in at its next
//                                                start (same as POST /api/admin/restore)
//   stage-update <bundle.tar.zst>                verify and unpack a release into app/versions/
//   switch <version> [--restart] | rollback [--restart]
//                                                point app/current at a staged version; --restart stops the running
//                                                server (pid from status/status.json) so root/bootstrap starts it
//   codex-login | codex-status | codex-logout   the engine account's own Codex (ChatGPT) sign-in, through the launcher:
//                                                codex-login prints a URL and a one-time code (device auth). Older
//                                                setup: in managed mode ChatGPT is connected from Admin > AI connections
//   credentials-rekey                            encrypt every AI connection's secret again under a new key file
//                                                (credentials.key.<N>) and remove the older one; JSON {rekeyed}
//   drive-rekey                                  rotate personal Drive secrets in their dedicated key directory;
//                                                retain older keys for backups/in-flight readers; JSON {rekeyed}
//
// For the hosted service's root tool (mycel-ctl / mycel-enroll, control-plane 3.5.3, system/cloud-admin.ts):
//   relay-key [--sign-register <slug> <ts>] [--sign-rotate <teamId>] [--sign-reattach <tenantId> <teamId> <ts>]
//   setup-status | setup-token-rotate
//   cloud-backup prepare --kind daily|manual|pre-update|final [--local-id <id>] | cloud-backup upload  (stdin JSON)
//   archive --passphrase-random --upload         the whole team, age with a random passphrase, to presigned URLs (stdin)
//   restore-artifacts --dir <chain> --to <dir>   rebuild db/ + team/ from a downloaded, decrypted off-site chain
//   restore-verify --dir <chain> --expect JSON   the same into a throwaway folder, compared with the backup's totals
//   cloud-status                                 the app's part of TenantStatus (system/cloud-tenant.ts)
//   reset-link [--username U]                    one-time reset link at publicOrigins[0] (the owner by default), JSON
//   credentials-escrow-out --recipient age1…     the AI connections' key age-armored to the CP's escrow recipient
//
// Run by scripts/install-macos.sh as root with the admin.js of the bundle it installs (no config, explicit paths only):
//   lan-cert --cert F --key F [--fingerprint F]  make or keep the office TLS certificate (system/lan-cert.ts); JSON
//   install-state --current V|'' --version V --state F --out F
//                                                plan app/current + state.json for this install (system/install-plan.ts)
//   compare-versions A B                         -1 / 0 / 1 (A older / same / newer than B)
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadAppConfig } from '../app-config'
import { SERVER_VERSION, createContext } from '../context'
import { openDb } from '../db'
import { createLogger, silentLogger } from '../log'
import { BackupManager, endSessions, inspectDbCopy, vacuumInto } from './backup'
import { planInstallState } from './install-plan'
import { ensureLanCert } from './lan-cert'
import { resolveLayout } from './layout'
import { walkTree } from './manifest'
import { ageDecrypt, ageEncrypt, isAgeFile, readFileChunks, writeAtomic, zstdCompress, zstdDecompress } from './streams'
import { extractTar, tarStream, type TarEntryInput } from './tar'
import { compareVersions, UpdateManager } from './update'
import { codexCommand } from './codex-login'
import { archiveUpload, cloudBackupPrepare, cloudBackupUpload, relayKeyCommand, restoreArtifacts, restoreVerify, rotateSetupToken, setupStatus } from './cloud-admin'
import { makeCredCtx } from '../credentials/store'
import { DriveStore } from '../integrations/google-drive/store'
import { rekeyDrive } from '../integrations/google-drive/rekey'
import { rekeyCredentials } from '../credentials/rekey'
import { cloudStatus, credentialsEscrowOut, resetLinkBase } from './cloud-tenant'
import { createResetLink } from '../auth/accounts'
import { installAuth } from '../auth/service'

async function stdinJson(): Promise<unknown> {
  const text = await new Response(Bun.stdin.stream()).text()
  try { return JSON.parse(text) } catch { throw new Error('stdin must be one JSON object') }
}

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] ?? null : null
}

async function readPassword(args: string[]): Promise<string | null> {
  if (!args.includes('--password-stdin')) return null
  const text = await new Response(Bun.stdin.stream()).text()
  const pw = text.replace(/\r?\n$/, '')
  if (pw.length < 8) throw new Error('password must be at least 8 characters')
  return pw
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv
  if (cmd === 'lan-cert') {
    const cert = arg(args, '--cert'), key = arg(args, '--key')
    if (!cert || !key) throw new Error('lan-cert needs --cert <file> --key <file>')
    const r = ensureLanCert({ certFile: path.resolve(cert), keyFile: path.resolve(key), fingerprintFile: arg(args, '--fingerprint') })
    console.log(JSON.stringify(r))
    return 0
  }
  if (cmd === 'compare-versions') {
    // -1 / 0 / 1 as `a` is older than / the same as / newer than `b` (the installer's root/VERSION check)
    const [a, b] = args
    if (!a || !b) throw new Error('compare-versions needs two versions')
    console.log(String(compareVersions(a, b)))
    return 0
  }
  if (cmd === 'install-state') {
    const version = arg(args, '--version'), stateFile = arg(args, '--state'), outFile = arg(args, '--out')
    if (!version || !stateFile || !outFile || !args.includes('--current')) throw new Error('install-state needs --current V --version V --state F --out F')
    let state: unknown = null
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch {}
    const plan = planInstallState({ current: arg(args, '--current') || null, version, state })
    fs.writeFileSync(outFile, JSON.stringify(plan.state, null, 2) + '\n', { mode: 0o640 })
    console.log(plan.action)
    return 0
  }
  const cfg = loadAppConfig({ argv: [] })
  const log = createLogger({ level: 'warn' })
  const layout = resolveLayout(cfg)
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 1))
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const updates = () => new UpdateManager({ appDir: layout.appDir, dataDir: cfg.dataDir, version: SERVER_VERSION, channel: cfg.update.channel, feedUrl: cfg.update.feedUrl, log })
  const backups = () => {
    const db = openDb(dbFile)
    return { db, mgr: new BackupManager({ db, dbFile, layout, log, version: SERVER_VERSION }) }
  }

  switch (cmd) {
    case 'backup': {
      const { db, mgr } = backups()
      try { out(await mgr.run({ kind: arg(args, '--kind') === 'pre-update' ? 'pre-update' : 'manual', scope: arg(args, '--scope') === 'db' ? 'db' : 'full' })) } finally { db.close() }
      return 0
    }
    case 'list-backups': {
      const { db, mgr } = backups()
      try { out(mgr.list()) } finally { db.close() }
      return 0
    }
    case 'archive': {
      if (args.includes('--upload')) {
        if (!args.includes('--passphrase-random')) throw new Error('archive --upload needs --passphrase-random (the passphrase is printed once)')
        out(await archiveUpload({ dbFile, teamRoot: cfg.teamRoot, dataDir: cfg.dataDir }, await stdinJson()))
        return 0
      }
      const dest = arg(args, '--out')
      if (!dest) throw new Error('archive needs --out <file>')
      const pw = await readPassword(args)
      const tmpDb = path.join(cfg.dataDir, `archive-${process.pid}.sqlite`)
      await vacuumInto(dbFile, tmpDb)
      try {
        const tree = await walkTree(cfg.teamRoot, { exclude: ['.system/backups'] })
        const entries: TarEntryInput[] = [
          { name: 'db', type: 'dir' }, { name: 'db/app.sqlite', type: 'file', source: tmpDb },
          { name: 'team', type: 'dir' },
          ...tree.dirs.map((d) => ({ name: `team/${d.rel}`, type: 'dir' as const, mode: d.mode, mtimeMs: d.mtimeMs })),
          ...tree.files.map((f) => ({ name: `team/${f.rel}`, type: 'file' as const, source: f.abs })),
        ]
        const z = zstdCompress(tarStream(entries))
        const w = await writeAtomic(pw ? ageEncrypt(z, pw) : z, path.resolve(dest), 0o600)
        out({ file: path.resolve(dest), size: w.size, sha256: w.sha256, encrypted: !!pw, files: tree.files.length })
      } finally {
        await fsp.rm(tmpDb, { force: true })
      }
      return 0
    }
    case 'restore-archive': {
      const src = arg(args, '--in'), to = arg(args, '--to')
      if (!src || !to) throw new Error('restore-archive needs --in <file> --to <new folder>')
      const target = path.resolve(to)
      if (fs.existsSync(target)) throw new Error(`${target} already exists`)
      const encrypted = await isAgeFile(src)
      const pw = await readPassword(args)
      if (encrypted && !pw) throw new Error('this archive is encrypted: pass the password on stdin with --password-stdin')
      const tmp = `${target}.partial-${process.pid}`
      await fsp.mkdir(tmp, { recursive: true, mode: 0o700 })
      try {
        const raw = readFileChunks(src)
        const n = await extractTar(zstdDecompress(encrypted ? ageDecrypt(raw, pw!) : raw), tmp)
        inspectDbCopy(path.join(tmp, 'db', 'app.sqlite'))
        // every consumer of the restored folder gets a database without sign-ins (endSessions says why)
        endSessions(path.join(tmp, 'db', 'app.sqlite'))
        if (!fs.existsSync(path.join(tmp, 'team'))) throw new Error('archive has no team folder')
        await fsp.rename(tmp, target)
        out({ restoredTo: target, entries: n })
      } catch (e) {
        await fsp.rm(tmp, { recursive: true, force: true })
        throw e
      }
      return 0
    }
    case 'restore-team': {
      const id = arg(args, '--backup'), to = arg(args, '--to')
      if (!id || !to) throw new Error('restore-team needs --backup <id> --to <new folder>')
      const { db, mgr } = backups()
      try { out(await mgr.restoreTeamTo(id, path.resolve(to))) } finally { db.close() }
      return 0
    }
    case 'stage-restore': {
      const id = arg(args, '--backup')
      if (!id) throw new Error('stage-restore needs --backup <id>')
      const { db, mgr } = backups()
      try { out(await mgr.stageDbRestore(id, null)) } finally { db.close() }
      return 0
    }
    case 'stage-update': {
      if (!args[0]) throw new Error('stage-update needs a bundle file')
      out(await updates().stage(path.resolve(args[0])))
      return 0
    }
    case 'switch':
    case 'rollback': {
      if (cmd === 'switch' && !args[0]) throw new Error('switch needs a version')
      out(cmd === 'switch' ? await updates().switchTo(args[0]!) : await updates().rollBack())
      if (args.includes('--restart')) {
        const pid = (JSON.parse(fs.readFileSync(path.join(layout.statusDir, 'status.json'), 'utf8')) as { pid: number }).pid
        process.kill(pid, 'SIGTERM')
      }
      return 0
    }
    case 'relay-key':
      out(relayKeyCommand(cfg.dataDir, args))
      return 0
    case 'setup-status':
    case 'setup-token-rotate': {
      const { db } = backups()
      try { out(cmd === 'setup-status' ? setupStatus(db, cfg.dataDir) : rotateSetupToken(db, cfg.dataDir)) } finally { db.close() }
      return 0
    }
    case 'cloud-backup': {
      if (args[0] === 'upload') { out(await cloudBackupUpload(cfg.dataDir, await stdinJson())); return 0 }
      if (args[0] !== 'prepare') throw new Error('cloud-backup prepare --kind K [--local-id ID] | cloud-backup upload < plan.json')
      const kind = arg(args, '--kind')
      if (kind !== 'daily' && kind !== 'manual' && kind !== 'pre-update' && kind !== 'final') throw new Error('--kind daily|manual|pre-update|final')
      const db = openDb(dbFile)
      try { out(await cloudBackupPrepare({ db, dbFile, layout, dataDir: cfg.dataDir, version: SERVER_VERSION, log }, kind, arg(args, '--local-id'))) } finally { db.close() }
      return 0
    }
    case 'restore-artifacts': {
      const dir = arg(args, '--dir'), to = arg(args, '--to')
      if (!dir || !to) throw new Error('restore-artifacts needs --dir <downloaded chain> --to <new folder>')
      out(await restoreArtifacts(path.resolve(dir), path.resolve(to)))
      return 0
    }
    case 'restore-verify': {
      const dir = arg(args, '--dir'), expect = arg(args, '--expect')
      if (!dir || !expect) throw new Error('restore-verify needs --dir <downloaded chain> --expect JSON')
      const r = await restoreVerify(path.resolve(dir), expect, cfg.dataDir)
      out(r)
      return r.ok ? 0 : 4
    }
    // the hosted service's tenant commands that need the app (system/cloud-tenant.ts, run by mycel-ctl)
    case 'cloud-status': {
      const { db, mgr } = backups()
      try { out(cloudStatus({ db, config: cfg, dataDir: cfg.dataDir, statusDir: layout.statusDir, secretsDir: layout.secretsDir, backups: mgr.metas() })) } finally { db.close() }
      return 0
    }
    case 'reset-link': {
      const base = resetLinkBase(cfg)
      // the same context as the account CLI (auth/cli.ts openCliContext; not imported: that file runs itself as main)
      const ctx = createContext({ config: cfg, db: openDb(dbFile), log: silentLogger })
      ctx.onClose(() => ctx.db.close())
      installAuth(ctx)
      try {
        const u = arg(args, '--username')
        const row = (u
          ? ctx.db.query("SELECT id, status FROM users WHERE username = ? AND deleted_at IS NULL").get(u)
          : ctx.db.query("SELECT id, status FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY (status = 'active') DESC, created_at LIMIT 1").get()) as { id: string; status: string } | null
        if (!row) throw new Error(u ? `no account "${u}"` : 'no owner yet')
        if (row.status !== 'active') throw new Error('that account is disabled')
        const link = createResetLink(ctx, row.id, null, base)
        out({ url: link.url, expiresAt: link.expiresAt })
      } finally { await ctx.close() }
      return 0
    }
    case 'credentials-escrow-out': {
      const r = arg(args, '--recipient')
      if (!r) throw new Error('credentials-escrow-out needs --recipient age1…')
      out(await credentialsEscrowOut(layout.secretsDir, r))
      return 0
    }
    // the engine account's Codex login (server/src/system/codex-login.ts)
    case 'codex-login':
    case 'codex-status':
    case 'codex-logout':
      return codexCommand(cmd, cfg)
    // Personal Drive uses its own keys, separate from AI credential rotation.
    case 'drive-rekey': {
      const db = openDb(dbFile)
      try { out({ rekeyed: rekeyDrive(new DriveStore(db, path.join(layout.secretsDir, 'integrations', 'google-drive'))) }) }
      finally { db.close() }
      return 0
    }
    // AI connections: a new key for their secrets (credentials/rekey.ts)
    case 'credentials-rekey': {
      const db = openDb(dbFile)
      try {
        const cc = makeCredCtx({ db, secretsDir: layout.secretsDir, config: cfg, log })
        out({ rekeyed: rekeyCredentials(cc) })
      } finally { db.close() }
      return 0
    }
    default:
      console.error('usage: admin.js backup|list-backups|archive|restore-archive|restore-team|stage-restore|stage-update|switch|rollback|codex-login|codex-status|codex-logout|credentials-rekey|drive-rekey|lan-cert|install-state|compare-versions|relay-key|setup-status|setup-token-rotate|cloud-backup|restore-artifacts|restore-verify|cloud-status|reset-link|credentials-escrow-out (see server/src/system/cli.ts)')
      return 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  })
}
