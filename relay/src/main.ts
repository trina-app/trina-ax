// Relay entry point. Runs on Node 26 (24+):
//   node --disable-warning=ExperimentalWarning relay/src/main.ts --dev          (bun run dev:relay)
//   node relay/src/main.ts --domain treesoop.com --port 443 --data /var/lib/mycel-relay      (production: relay/deploy/)
// Operator commands on the relay host (same registry database; a running relay picks changes up within 5 s). The
// control plane uses the signed operator API instead (ops-api.ts); these are the break-glass path:
//   teams                                         list teams (origin, status, suspension reason)
//   suspend <name> [--reason billing|canceled|abuse|security|operator] | unsuspend <name>
//   release <name>                                reclaim an address (name held 1 year)
//   reserve <name> | block <name>
//   create <name> --public-key K --sig S --ts T [--origin cloud|addon] [--ref R] [--region R]
//                                                 a team with the team server's own key (it signed registerSigningString);
//                                                 may use a built-in reserved name (the operators' probe team ax-probe)
//   claim <name> [--days 7] --ref R               one-time claim code for the official relay add-on (shown once)
//   maintenance <name> <minutes>                  "being updated" page while the team is offline (0 = off)
//   keys                                          operator keys (RELAY_OPERATOR_KEYS_FILE)
//   audit [--limit 50]                            recent operator actions
import fs from 'node:fs'
import path from 'node:path'
import { SUSPEND_REASONS, type SuspendReason } from '@mycel/shared/cloud-protocol/relay-ops'
import { normalizeTeamName } from '@mycel/shared/relay-protocol'
import { loadRelayConfig } from './config.ts'
import { openSqlite } from './db.ts'
import { createRelayLog } from './log.ts'
import { parseOperatorKeys } from './ops-api.ts'
import { Registry } from './registry.ts'
import { RelayServer } from './relay.ts'

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve'
  const rest = cmd === 'serve' ? argv : argv.slice(1)
  // operator commands take the team name right after the command: `suspend acme --dev`
  const name = cmd !== 'serve' && rest[0] && !rest[0].startsWith('--') ? normalizeTeamName(rest[0]) : undefined
  const positional = name ? rest.slice(1) : rest
  const cfg = loadRelayConfig(positional)
  const db = await openSqlite(path.join(cfg.dataDir, 'registry.db'))
  const registry = new Registry(db, { extraReserved: cfg.reserved, devNames: cfg.devNames })

  if (cmd !== 'serve') {
    const byName = () => {
      const t = name ? registry.teamByName(name) : undefined
      if (!t) throw new Error(`no team named ${name ?? '(missing)'}`)
      return t
    }
    switch (cmd) {
      case 'teams':
        for (const t of registry.list()) console.log(`${t.name}\t${t.status}${t.suspend_reason ? `(${t.suspend_reason})` : ''}\t${t.origin}\t${t.id}\tcreated ${t.created_at}\tlast connected ${t.last_connected_at ?? '-'}\theartbeat ${t.last_heartbeat_at ?? '-'}${t.external_ref ? `\tref ${t.external_ref}` : ''}`)
        break
      case 'suspend': {
        const reason = (opt(positional, 'reason') ?? 'operator') as SuspendReason
        if (!SUSPEND_REASONS.includes(reason)) throw new Error(`--reason must be one of ${SUSPEND_REASONS.join(', ')}`)
        const t = byName()
        registry.setStatus(t.id, 'suspended', reason)
        registry.audit('cli', 'teams.suspend', t.id, `reason=${reason}`)
        console.log(`suspended (${reason})`)
        break
      }
      case 'unsuspend': {
        const t = registry.list().find((x) => x.name === name && x.status === 'suspended')
        if (!t) throw new Error(`no suspended team named ${name}`)
        registry.setStatus(t.id, 'active')
        registry.audit('cli', 'teams.unsuspend', t.id)
        console.log('active')
        break
      }
      case 'release': { const t = byName(); registry.release(t.id, 'reclaimed'); registry.audit('cli', 'teams.delete', t.id); console.log('released; the name is held for a year'); break }
      case 'reserve': case 'block':
        if (!name) throw new Error('name required')
        registry.reserve(name, cmd === 'block' ? 'blocked' : 'reserved')
        registry.audit('cli', `names.${cmd}`, null, `name=${name}`)
        console.log(cmd === 'block' ? 'blocked' : 'reserved')
        break
      case 'create': {
        if (!name) throw new Error('name required')
        const publicKey = opt(positional, 'public-key'), sig = opt(positional, 'sig'), ts = Number(opt(positional, 'ts'))
        if (!publicKey || !sig || !Number.isInteger(ts)) throw new Error('create needs --public-key K --sig S --ts T (the team key signs registerSigningString(name, key, ts))')
        const origin = (opt(positional, 'origin') ?? 'cloud') as 'cloud' | 'addon'
        if (origin !== 'cloud' && origin !== 'addon') throw new Error('--origin cloud|addon')
        const { team, created } = registry.createByOperator({ name, publicKey, sig, ts, origin, region: opt(positional, 'region') ?? 'default', externalRef: opt(positional, 'ref') ?? `cli:${name}` }, { allowReserved: true })
        if (created) registry.audit('cli', 'teams.create', team.id, `origin=${origin}`)
        console.log(JSON.stringify({ teamId: team.id, name: team.name, created }))
        break
      }
      case 'claim': {
        if (!name) throw new Error('name required')
        const ref = opt(positional, 'ref')
        if (!ref) throw new Error('claim needs --ref <the control plane team id>')
        const days = Number(opt(positional, 'days') ?? 7)
        if (!(days > 0 && days <= 7)) throw new Error('--days 1-7')
        const c = registry.createClaim({ name, ttlMs: days * 86_400_000, externalRef: ref })
        registry.audit('cli', 'claims.create', null, `name=${name} ref=${ref}`)
        console.log(`claim code for ${name} (shown once, valid until ${c.expiresAt}): ${c.code}`)
        break
      }
      case 'maintenance': {
        const minutes = Number(positional.find((a) => !a.startsWith('--')))
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) throw new Error('maintenance <name> <minutes 0-1440>')
        const t = byName()
        registry.setMaintenance(t.id, minutes ? Date.now() + minutes * 60_000 : null)
        registry.audit('cli', 'teams.maintenance', t.id, minutes ? `minutes=${minutes}` : 'off')
        console.log(minutes ? `maintenance for ${minutes} min` : 'maintenance off')
        break
      }
      case 'keys': {
        if (!cfg.operatorKeysFile) throw new Error('RELAY_OPERATOR_KEYS_FILE is not set')
        for (const k of parseOperatorKeys(fs.readFileSync(cfg.operatorKeysFile, 'utf8'))) console.log(`${k.keyId}\t${k.scopes.join(',')}\t${k.label}`)
        break
      }
      case 'audit':
        for (const a of registry.auditLog(Number(opt(positional, 'limit') ?? 50))) console.log(`${a.at}\t${a.key_id}\t${a.action}\t${a.team_id ?? '-'}\t${a.detail ?? ''}`)
        break
      default:
        console.error(`unknown command ${cmd}`)
        return 64
    }
    db.close()
    return 0
  }

  const log = createRelayLog()
  const relay = new RelayServer(cfg, registry, log)
  if (process.env.RELAY_ACCOUNT_HOST) relay.pageLinks.account = process.env.RELAY_ACCOUNT_HOST
  if (process.env.RELAY_STATUS_HOST) relay.pageLinks.status = process.env.RELAY_STATUS_HOST
  const port = await relay.listen()
  if (cfg.dev) console.log(`relay (dev): teams at http://<team>.${cfg.domain}:${port}  control ws://127.0.0.1:${port}/connect  registry ${cfg.dataDir}`)
  let stopping = false
  const stop = async (sig: string) => {
    if (stopping) return
    stopping = true
    log.info('relay_stopping', { signal: sig })
    await relay.stop(Number(process.env.RELAY_GRACE_MS ?? 10_000))
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
  return -1
}

main().then((code) => { if (code >= 0) process.exit(code) }, (e) => {
  console.error(`relay: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
