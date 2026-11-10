// Edition build input: where people get this product's apps (shared/src/app-downloads.ts, shown in Settings › Apps).
// editions/<name>/branding/apps.json sets exactly the five values below, each an https web page (a store listing or a
// download page, never an installer file) or '' (none), and this
// tool writes them into APP_DOWNLOADS (anchored fields, once each; nothing else changes).
//
//   bun scripts/edition-apps.ts editions/<name>/branding/apps.json            check; say whether it would change
//   bun scripts/edition-apps.ts editions/<name>/branding/apps.json --apply    write shared/src/app-downloads.ts
import fs from 'node:fs'
import path from 'node:path'

const keys = ['page', 'iphone', 'android', 'mac', 'windows'] as const
export type EditionApps = Record<(typeof keys)[number], string>

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
// an https page: a host, a path and a query (store listings use ?platform=…); no port, credentials, fragment, quote,
// backslash or space, so the value is safe inside a quoted source string and in an href
const URL_SHAPE = /^https:\/\/([a-z0-9.-]+)(\/[A-Za-z0-9._~%!$&()*+,;=:@/-]*)?(\?[A-Za-z0-9._~%!$&()*+,;=:@/?-]*)?$/

export function appAddress(value: unknown): value is string {
  if (value === '') return true
  if (typeof value !== 'string' || value.length > 2048) return false
  const m = URL_SHAPE.exec(value)
  if (!m || !HOST.test(m[1]!)) return false
  try {
    const u = new URL(value)
    // a web page, never an installer file: a store build may not offer one (web/src/lib/apps.ts)
    if (/\.(apk|aab|exe|msi|msix|appx|dmg|pkg|zip)$/i.test(decodeURIComponent(u.pathname))) return false
    return u.protocol === 'https:' && u.hostname === m[1] && !u.username && !u.password && !u.port && !u.hash
  } catch {
    return false
  }
}

export function parseEditionApps(value: unknown): EditionApps {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid apps configuration')
  const o = value as Record<string, unknown>
  if (Object.keys(o).length !== keys.length || keys.some((k) => !(k in o))) throw new Error(`Only ${keys.join(', ')} may be configured`)
  for (const k of keys) if (!appAddress(o[k])) throw new Error(`Invalid ${k}: an https address or ""`)
  return Object.fromEntries(keys.map((k) => [k, o[k] as string])) as EditionApps
}

export function editionApps(source: string, value: unknown): string {
  const s = parseEditionApps(value)
  if (!source.includes('export const APP_DOWNLOADS: AppDownloads = {')) throw new Error('Unsupported apps module')
  let result = source
  for (const k of keys) {
    const re = new RegExp(`^( {2}${k}: )'[^'\\r\\n]*'(,)$`, 'gm')
    if ([...result.matchAll(re)].length !== 1) throw new Error('Unsupported apps field')
    result = result.replace(re, (_, prefix: string, suffix: string) => `${prefix}'${s[k]}'${suffix}`)
  }
  return result
}

export function main(args: string[], root = path.resolve(import.meta.dir, '..')) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: bun scripts/edition-apps.ts EDITION_APPS_JSON [--apply]')
  const config = JSON.parse(fs.readFileSync(path.resolve(args[0]!), 'utf8'))
  const target = path.join(root, 'shared/src/app-downloads.ts'), stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe apps module')
  const before = fs.readFileSync(target, 'utf8'), after = editionApps(before, config)
  if (args[1] === '--apply' && before !== after) {
    const temp = target + '.apps-' + process.pid
    try { fs.writeFileSync(temp, after, { flag: 'wx', mode: stat.mode & 0o777 }); fs.renameSync(temp, target) }
    finally { fs.rmSync(temp, { force: true }) }
  }
  process.stdout.write(JSON.stringify({ dryRun: args[1] !== '--apply', changed: before !== after }) + '\n')
}

if (import.meta.main) { try { main(process.argv.slice(2)) } catch (e) { process.stderr.write(`Apps configuration is invalid: ${(e as Error).message}\n`); process.exitCode = 1 } }
