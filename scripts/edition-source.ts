// Edition build input: where people get this product's source (AGPL-3.0, docs/EDITION-BRANDING.md). An edition has its
// own public repository and its own address for source requests; the core's private repository must never be what an
// edition's "source code" link names. editions/<name>/branding/source.json sets exactly the three values below, and this
// tool writes them into SOURCE_CODE in shared/src/source.ts (anchored fields, once each; nothing else changes).
//
//   bun scripts/edition-source.ts editions/<name>/branding/source.json            check; say whether it would change
//   bun scripts/edition-source.ts editions/<name>/branding/source.json --apply    write shared/src/source.ts
import fs from 'node:fs'
import path from 'node:path'

const keys = ['repository', 'published', 'requestEmail'] as const
export type EditionSource = { repository: string; published: boolean; requestEmail: string }

export function parseEditionSource(value: unknown): EditionSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source configuration')
  const o = value as Record<string, unknown>
  if (Object.keys(o).length !== keys.length || keys.some((k) => !(k in o))) throw new Error('Only repository, published and requestEmail may be configured')
  // an https repository page: host and 1-3 path parts, no query, fragment, credentials, port or trailing slash
  if (typeof o.repository !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,3}$/.test(o.repository)) throw new Error('Invalid repository')
  if (typeof o.published !== 'boolean') throw new Error('Invalid published flag')
  // one plain mailbox (the same rule as RequestEmail in shared/src/source.ts, and safe inside a quoted source string)
  if (typeof o.requestEmail !== 'string' || o.requestEmail.length > 254 || !/^[A-Za-z0-9._+-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(o.requestEmail)) throw new Error('Invalid request email')
  return { repository: o.repository, published: o.published, requestEmail: o.requestEmail }
}

/** Exact anchored fields of SOURCE_CODE, once each. Never replaces other text. */
export function editionSource(source: string, value: unknown): string {
  const s = parseEditionSource(value)
  if (!source.includes('export const SOURCE_CODE = {')) throw new Error('Unsupported source module')
  const fields: [string, RegExp, string][] = [
    ['repository', /^( {2}repository: )'[^'\r\n]*'(,)$/gm, `'${s.repository}'`],
    ['published', /^( {2}published: )(?:true|false)(,)$/gm, String(s.published)],
    ['requestEmail', /^( {2}requestEmail: )'[^'\r\n]*'(,)$/gm, `'${s.requestEmail}'`],
  ]
  let result = source
  for (const [, re, value] of fields) {
    if ([...result.matchAll(re)].length !== 1) throw new Error('Unsupported source field')
    result = result.replace(re, (_, prefix: string, suffix: string) => prefix + value + suffix)
  }
  return result
}

export function main(args: string[], root = path.resolve(import.meta.dir, '..')) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: bun scripts/edition-source.ts EDITION_SOURCE_JSON [--apply]')
  const config = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'))
  const target = path.join(root, 'shared/src/source.ts'), stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe source module')
  const before = fs.readFileSync(target, 'utf8'), after = editionSource(before, config)
  if (args[1] === '--apply' && before !== after) {
    const temp = target + '.source-' + process.pid
    try { fs.writeFileSync(temp, after, { flag: 'wx', mode: stat.mode & 0o777 }); fs.renameSync(temp, target) }
    finally { fs.rmSync(temp, { force: true }) }
  }
  process.stdout.write(JSON.stringify({ dryRun: args[1] !== '--apply', changed: before !== after }) + '\n')
}

if (import.meta.main) { try { main(process.argv.slice(2)) } catch (e) { process.stderr.write(`Source configuration is invalid: ${(e as Error).message}\n`); process.exitCode = 1 } }
