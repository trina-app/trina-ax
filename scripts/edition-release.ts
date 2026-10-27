// Edition build input: the release channel (docs/EDITION-RELEASE.md). One input file, editions/<name>/release-channel.json,
// is the whole channel: where updates come from and which keys sign them. The tool writes the two source files that
// carry it and nothing else:
//   shared/src/release-channel.ts           RELEASE_CHANNEL (server, office updater, release scripts, product.env)
//   native/internal/bundle/release_keys.go  ReleaseKeys (mycel-ctl, the Linux bootstrap's key)
//
//   bun scripts/edition-release.ts editions/<name>/release-channel.json            check; say whether it would change
//   bun scripts/edition-release.ts editions/<name>/release-channel.json --apply    write both files
//
// tests/unit/release-channel.test.ts checks that both files are exactly what this tool writes for RELEASE_CHANNEL.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type ReleaseChannel = {
  feed: string
  keys: string[]
  officeProduct: string
  officeDir: string
  keyDir: string
  hosting: { zone: string; bucket: string; worker: string }
}

const FIELDS = ['feed', 'keys', 'officeProduct', 'officeDir', 'keyDir', 'hosting'] as const
const HOSTING = ['zone', 'bucket', 'worker'] as const
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

function exactKeys(o: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${what}: not an object`)
  const got = Object.keys(o)
  if (got.length !== keys.length || keys.some((k) => !got.includes(k))) throw new Error(`${what}: exactly ${keys.join(', ')}`)
  return o as Record<string, unknown>
}

const str = (v: unknown, re: RegExp, what: string): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`${what}: invalid`)
  return v
}

/** Ed25519 public key, raw 32 bytes in canonical base64 */
export function validKey(k: unknown): k is string {
  return typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k) && Buffer.from(k, 'base64').length === 32 && Buffer.from(k, 'base64').toString('base64') === k
}

export const keyIdOf = (k: string) => crypto.createHash('sha256').update(Buffer.from(k, 'base64')).digest('hex').slice(0, 16)

export function parseReleaseChannel(value: unknown): ReleaseChannel {
  const o = exactKeys(value, FIELDS, 'release channel')
  const h = exactKeys(o.hosting, HOSTING, 'hosting')
  const zone = str(h.zone, DNS_NAME, 'hosting.zone')
  const hosting = {
    zone,
    // R2 bucket names: 3-63 of a-z 0-9 -, no leading or trailing hyphen; Worker names the same, 1-63
    bucket: str(h.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'hosting.bucket'),
    worker: str(h.worker, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'hosting.worker'),
  }
  // the feed is an https origin and nothing else: every file URL in a manifest must start with it
  if (typeof o.feed !== 'string') throw new Error('feed: invalid')
  let u: URL
  try { u = new URL(o.feed) } catch { throw new Error('feed: invalid') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !DNS_NAME.test(u.hostname) || o.feed !== `https://${u.hostname}`) throw new Error('feed: an https origin like https://updates.example.com')
  if (u.hostname !== zone && !u.hostname.endsWith('.' + zone)) throw new Error('feed: its host must be in hosting.zone')
  if (!Array.isArray(o.keys) || o.keys.length < 1 || o.keys.length > 4 || !o.keys.every(validKey) || new Set(o.keys).size !== o.keys.length) throw new Error('keys: 1 to 4 different Ed25519 public keys (raw 32 bytes, base64)')
  return {
    feed: o.feed,
    keys: [...o.keys],
    // the signed office manifest's product field and the folder of the feed for office releases
    officeProduct: str(o.officeProduct, /^[a-z0-9][a-z0-9-]{0,40}-office$/, 'officeProduct'),
    officeDir: str(o.officeDir, /^(?!server$)[a-z0-9][a-z0-9-]{0,40}$/, 'officeDir'),
    keyDir: str(o.keyDir, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'keyDir'),
    hosting,
  }
}

const q = (s: string) => JSON.stringify(s) // validated above: no quotes, backslashes or line breaks

export function renderChannelTs(value: unknown): string {
  const c = parseReleaseChannel(value)
  return `// This product's release channel: where its updates come from and the keys that sign them (docs/EDITION-RELEASE.md).
// The core product and each edition built from it have their own, so an installation only takes its own product's
// releases: a release must verify with one of these keys, and an office manifest must name officeProduct.
// Written by scripts/edition-release.ts (with native/internal/bundle/release_keys.go); an edition changes it with
// \`bun scripts/edition-release.ts editions/<name>/release-channel.json --apply\`, never by hand.
export const RELEASE_CHANNEL = {
  /** https origin of the feed: offices read <feed>/<officeDir>/<channel>.json, Linux servers <feed>/server/<channel>.json */
  feed: ${q(c.feed)},
  /** Ed25519 release public keys (raw 32 bytes, base64), the only keys an installation trusts for updates. A key is
   *  replaced by adding the new one first, shipping that build, then signing with the new key. */
  keys: [
${c.keys.map((k) => `    ${q(k)}, // key id ${keyIdOf(k)}`).join('\n')}
  ] as readonly string[],
  /** the product field of a signed office manifest */
  officeProduct: ${q(c.officeProduct)},
  /** the feed's folder for office releases */
  officeDir: ${q(c.officeDir)},
  /** the owner's signing key on the release Mac: ~/.config/<keyDir>/release-key.pem (scripts/release/keygen.ts) */
  keyDir: ${q(c.keyDir)},
  /** where the feed is hosted (scripts/release/hosting.ts): the Cloudflare zone of the feed's host, the R2 bucket, the Worker */
  hosting: { zone: ${q(c.hosting.zone)}, bucket: ${q(c.hosting.bucket)}, worker: ${q(c.hosting.worker)} },
} as const
`
}

export function renderGoKeys(value: unknown): string {
  const c = parseReleaseChannel(value)
  return `// Code generated by scripts/edition-release.ts. DO NOT EDIT.

package bundle

// ReleaseKeys are the Ed25519 release public keys (raw 32 bytes, base64) built into mycel-ctl: RELEASE_CHANNEL.keys in
// shared/src/release-channel.ts (spec D12: one release key for office and server feeds).
var ReleaseKeys = []string{
${c.keys.map((k) => `\t${q(k)}, // key id ${keyIdOf(k)}`).join('\n')}
}
`
}

export const TARGETS = {
  ts: 'shared/src/release-channel.ts',
  go: 'native/internal/bundle/release_keys.go',
} as const

function writeSafely(target: string, text: string) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('Unsafe release channel source')
  const temp = target + '.channel-' + process.pid
  try { fs.writeFileSync(temp, text, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o644 }); fs.renameSync(temp, target) }
  finally { fs.rmSync(temp, { force: true }) }
}

export function main(args: string[], root = path.resolve(import.meta.dir, '..')) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: bun scripts/edition-release.ts EDITION_RELEASE_CHANNEL_JSON [--apply]')
  const config = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'))
  const out: Record<string, string> = { [TARGETS.ts]: renderChannelTs(config), [TARGETS.go]: renderGoKeys(config) }
  const changed = Object.entries(out).filter(([rel, text]) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8') !== text } catch { return true }
  }).map(([rel]) => rel)
  if (args[1] === '--apply') for (const rel of changed) writeSafely(path.join(root, rel), out[rel])
  process.stdout.write(JSON.stringify({ dryRun: args[1] !== '--apply', changed }) + '\n')
}

if (import.meta.main) {
  try { main(process.argv.slice(2)) } catch (e) { process.stderr.write(`Release channel configuration is invalid: ${(e as Error).message}\n`); process.exitCode = 1 }
}
