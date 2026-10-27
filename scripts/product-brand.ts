// Edition build input. Stable installation IDs stay in product.ts; only its four display/build names change.
import fs from 'node:fs'
import path from 'node:path'

const keys = ['displayName', 'shortName', 'artifactBase', 'officeBundle'] as const
export type ProductBrand = Record<typeof keys[number], string>
export function parseProductBrand(value: unknown): ProductBrand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid brand configuration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== keys.length || keys.some(key => typeof input[key] !== 'string')) throw new Error('Only the four product names may be configured')
  for (const key of ['displayName', 'shortName'] as const) if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(input[key] as string)) throw new Error('Invalid display name')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(input.artifactBase as string)) throw new Error('Invalid artifact name')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}-office$/.test(input.officeBundle as string)) throw new Error('Invalid office bundle name')
  return input as ProductBrand
}

/** Exact anchored keys, once each. Never replace arbitrary matching text or mutate stable IDs. */
export function brandedProduct(source: string, value: unknown): string {
  const brand = parseProductBrand(value)
  if (!source.includes('export const PRODUCT = {')) throw new Error('Unsupported product source')
  let result = source
  for (const key of keys) {
    const pattern = new RegExp(`^(  ${key}: )(['"])[^'"\\r\\n]*\\2(,)$`, 'gm')
    if ([...result.matchAll(pattern)].length !== 1) throw new Error('Unsupported product name field')
    result = result.replace(pattern, (_, prefix: string, _quote: string, suffix: string) => prefix + JSON.stringify(brand[key]) + suffix)
  }
  return result
}

export function main(args: string[]) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: bun scripts/product-brand.ts EDITION_BRAND_JSON [--apply]')
  const config = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'))
  const target = path.resolve(import.meta.dir, '../shared/src/product.ts'), stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe product source')
  const before = fs.readFileSync(target, 'utf8'), after = brandedProduct(before, config)
  if (args[1] === '--apply' && before !== after) {
    const temp = target + '.brand-' + process.pid
    try { fs.writeFileSync(temp, after, { flag: 'wx', mode: stat.mode & 0o777 }); fs.renameSync(temp, target) }
    finally { fs.rmSync(temp, { force: true }) }
  }
  process.stdout.write(JSON.stringify({ dryRun: args[1] !== '--apply', changed: before !== after, stableIdsChanged: false }) + '\n')
}
if (import.meta.main) { try { main(process.argv.slice(2)) } catch { process.stderr.write('Brand configuration or product source is invalid.\n'); process.exitCode = 1 } }
