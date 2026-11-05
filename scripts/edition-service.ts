// Edition build input: the hosted service's addresses (shared/src/service-hosts.ts). editions/<name>/branding/service.json
// sets exactly the four values below, and this tool writes them into SERVICE_HOSTS (anchored fields, once each; nothing
// else changes).
//
//   bun scripts/edition-service.ts editions/<name>/branding/service.json            check; say whether it would change
//   bun scripts/edition-service.ts editions/<name>/branding/service.json --apply    write shared/src/service-hosts.ts
import fs from 'node:fs'
import path from 'node:path'

const keys = ['teamDomain', 'officialRelayUrl', 'accountHost', 'statusHost'] as const
export type EditionService = Record<(typeof keys)[number], string>

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function parseEditionService(value: unknown): EditionService {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid service configuration')
  const o = value as Record<string, unknown>
  if (Object.keys(o).length !== keys.length || keys.some((k) => !(k in o))) throw new Error(`Only ${keys.join(', ')} may be configured`)
  for (const k of ['teamDomain', 'accountHost', 'statusHost'] as const) if (typeof o[k] !== 'string' || !HOST.test(o[k] as string)) throw new Error(`Invalid ${k}`)
  const relay = o.officialRelayUrl
  if (typeof relay !== 'string' || !/^wss:\/\/[a-z0-9.-]+\/[a-z0-9/_-]*$/.test(relay) || !HOST.test(new URL(relay).hostname)) throw new Error('Invalid officialRelayUrl')
  const domain = o.teamDomain as string
  const inDomain = (h: string) => h === domain || h.endsWith(`.${domain}`)
  // the official relay is recognised by its domain (server/src/relay-client/index.ts)
  if (!inDomain(new URL(relay).hostname)) throw new Error('officialRelayUrl must be under teamDomain')
  return { teamDomain: domain, officialRelayUrl: relay, accountHost: o.accountHost as string, statusHost: o.statusHost as string }
}

export function editionService(source: string, value: unknown): string {
  const s = parseEditionService(value)
  if (!source.includes('export const SERVICE_HOSTS = {')) throw new Error('Unsupported service module')
  let result = source
  for (const k of keys) {
    const re = new RegExp(`^( {2}${k}: )'[^'\\r\\n]*'(,)$`, 'gm')
    if ([...result.matchAll(re)].length !== 1) throw new Error('Unsupported service field')
    result = result.replace(re, (_, prefix: string, suffix: string) => `${prefix}'${s[k]}'${suffix}`)
  }
  return result
}

export function main(args: string[], root = path.resolve(import.meta.dir, '..')) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: bun scripts/edition-service.ts EDITION_SERVICE_JSON [--apply]')
  const config = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'))
  const target = path.join(root, 'shared/src/service-hosts.ts'), stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe service module')
  const before = fs.readFileSync(target, 'utf8'), after = editionService(before, config)
  if (args[1] === '--apply' && before !== after) {
    const temp = target + '.service-' + process.pid
    try { fs.writeFileSync(temp, after, { flag: 'wx', mode: stat.mode & 0o777 }); fs.renameSync(temp, target) }
    finally { fs.rmSync(temp, { force: true }) }
  }
  process.stdout.write(JSON.stringify({ dryRun: args[1] !== '--apply', changed: before !== after }) + '\n')
}

if (import.meta.main) { try { main(process.argv.slice(2)) } catch (e) { process.stderr.write(`Service configuration is invalid: ${(e as Error).message}\n`); process.exitCode = 1 } }
