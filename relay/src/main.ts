// Relay entry point. Runs on Node 25:
//   node --disable-warning=ExperimentalWarning relay/src/main.ts --dev          (bun run dev:relay)
//   node relay/src/main.ts --domain treesoop.com --port 8080 --data /var/lib/mycel-relay
// Operator commands (same registry database; a running relay picks changes up within 5 s):
//   node relay/src/main.ts teams [--dev]                  list teams
//   node relay/src/main.ts suspend <name> | unsuspend <name>
//   node relay/src/main.ts release <name>                 reclaim an address (name held 1 year)
//   node relay/src/main.ts reserve <name> | block <name>
import path from 'node:path'
import { loadRelayConfig } from './config.ts'
import { openSqlite } from './db.ts'
import { createRelayLog } from './log.ts'
import { Registry } from './registry.ts'
import { RelayServer } from './relay.ts'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve'
  const rest = cmd === 'serve' ? argv : argv.slice(1)
  // operator commands take the team name right after the command: `suspend acme --dev`
  const name = cmd !== 'serve' && rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined
  const cfg = loadRelayConfig(name ? rest.slice(1) : rest)
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
        for (const t of registry.list()) console.log(`${t.name}\t${t.status}\t${t.id}\tcreated ${t.created_at}\tlast connected ${t.last_connected_at ?? '-'}\theartbeat ${t.last_heartbeat_at ?? '-'}`)
        break
      case 'suspend': registry.setStatus(byName().id, 'suspended'); console.log('suspended'); break
      case 'unsuspend': {
        const t = registry.list().find((x) => x.name === name && x.status === 'suspended')
        if (!t) throw new Error(`no suspended team named ${name}`)
        registry.setStatus(t.id, 'active')
        console.log('active')
        break
      }
      case 'release': registry.release(byName().id, 'reclaimed'); console.log('released; the name is held for a year'); break
      case 'reserve': case 'block':
        if (!name) throw new Error('name required')
        registry.reserve(name, cmd === 'block' ? 'blocked' : 'reserved')
        console.log(cmd === 'block' ? 'blocked' : 'reserved')
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
