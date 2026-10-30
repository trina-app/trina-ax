// Pin the official builds in the official plugin list (docs/PLUGINS.md "공식 플러그인 확인"): a release step, run
// after building the packages and before the core release that ships the list.
//
//   bun scripts/plugins/pin-catalog.ts dist/plugins/*.trinaplugin           write resources/plugins/catalog.json
//   bun scripts/plugins/pin-catalog.ts --catalog <dir> <files...>           another folder (tests, mirrors)
//   bun scripts/plugins/pin-catalog.ts --check <files...>                   exit 1 unless the list already pins them
//
// For each package: open it as the server does (archive limits, strict manifest, every file's size and SHA-256), check
// that it is exactly what its catalog entry describes (id, version, publisher, kinds, permissions, licence, exactly one
// of the entry's platforms, or none for a data-only entry), that a native package is the build core's driver accepts,
// that an HWP target is cleared in resources/hwp/clearance.json, and that the local plugin TEST key did not sign it.
// Then it writes { version, platform, manifestSha256 } into the entry's `pins`: the same platform is replaced, pins of
// other versions are dropped, and the list's `sequence` goes up when anything changed. A pin makes the package
// official on every server running that release, so review the diff like a key change.
//
// A pin never makes a `pending_clearance` entry installable: changing availability is a separate, reviewed edit. The
// packages themselves never go into resources/plugins or a default release bundle (scripts/plugins/release-check.ts);
// they are published as separate downloads.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PluginCatalog, platformKey, type CatalogPin } from '../../shared/src/plugins'
import { driverMismatch } from '../../server/src/plugins/drivers'
import { canonicalJson, parseStrictJson } from '../../server/src/plugins/json'
import { PackageError, verifyPackage } from '../../server/src/plugins/package'
import { keyIdOf, publicKeyOfPem, trustRoot } from '../../server/src/plugins/trust'
import { clearedTargets } from './build-hwp'
import { testKeyFile } from './test-key'

const REPO = path.resolve(import.meta.dir, '../..')
const ENTRY_ORDER = ['id', 'version', 'publisher', 'kinds', 'i18n', 'permissions', 'platforms', 'availability', 'recommendedFor', 'package', 'pins', 'default', 'license']
const WIDTH = 120

/** catalog.json in its committed layout: entries and their large fields one item per line, small values on one line. */
export function formatCatalog(doc: unknown): string {
  const isObj = (v: unknown): v is object => !!v && typeof v === 'object'
  const inline = (v: unknown): string => Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
    : isObj(v) ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : JSON.stringify(v)
  const expanded = (v: object, pad: string, child: (x: unknown, pad: string, key: string) => string): string => {
    const inner = pad + '  '
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + child(x, inner, '')).join(',\n')}\n${pad}]` : '[]'
    const e = Object.entries(v)
    return e.length ? `{\n${e.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${child(x, inner, k)}`).join(',\n')}\n${pad}}` : '{}'
  }
  const field = (x: unknown, pad: string, key: string) =>
    !isObj(x) || pad.length + JSON.stringify(key).length + 2 + inline(x).length + 1 <= WIDTH ? inline(x) : expanded(x, pad, (y) => inline(y))
  const entry = (x: unknown, pad: string) => expanded(x as object, pad, field)
  return expanded(doc as object, '', (x, pad, key) => key === 'entries' && Array.isArray(x) ? expanded(x, pad, entry) : inline(x)) + '\n'
}

const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join('\n') === [...b].sort().join('\n')

export interface PinResult { text: string; changed: boolean; pins: { file: string; id: string; pin: CatalogPin }[] }

/**
 * The catalog text with these packages pinned. Throws (with the file name) when a package is not exactly an official
 * build of its entry. `cleared`: HWP targets whose redistribution review is finished; `testKeyId`: the local test key.
 */
export function pinCatalog(catalogText: string, packages: { file: string; bytes: Uint8Array }[], o: { cleared: readonly string[]; testKeyId: string | null }): PinResult {
  const before = canonicalJson(parseStrictJson(catalogText))
  // changing an entry's version leaves its old pins behind; they are dropped here (the list does not load with them)
  const raw = parseStrictJson(catalogText) as { entries?: { version?: unknown; pins?: { version?: unknown }[] }[] }
  for (const e of Array.isArray(raw?.entries) ? raw.entries : []) if (e && Array.isArray(e.pins)) e.pins = e.pins.filter((p) => p?.version === e.version)
  const doc = PluginCatalog.parse(raw)
  // open each package as a development server would, trust aside: the pin is what will make it trusted
  const open = trustRoot({ runKind: 'dev', env: { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }, productionKeys: [] })
  const pinned: PinResult['pins'] = []
  for (const { file, bytes } of packages) {
    const name = path.basename(file)
    const fail = (why: string): never => { throw new Error(`${name}: ${why}`) }
    let v: ReturnType<typeof verifyPackage>
    try { v = verifyPackage(bytes, open) } catch (e) { return fail(e instanceof PackageError ? `${e.reason}: ${e.message}` : String(e)) }
    const m = v.manifest
    const e = doc.entries.find((x) => x.id === m.id) ?? fail(`${m.id} is not in the official list`)
    if (m.version !== e.version) fail(`version ${m.version}, but the official list is at ${e.version} (change the entry's version first)`)
    if (m.publisher.id !== e.publisher.id) fail(`publisher ${m.publisher.id}, the list says ${e.publisher.id}`)
    if (!same(m.kinds, e.kinds)) fail(`kinds ${m.kinds.join(',')} differ from the list`)
    if (!same(m.permissions.required, e.permissions.required) || !same(m.permissions.optional, e.permissions.optional)) fail('permissions differ from the list (the prompt would show other access than the card)')
    if (m.license !== e.license) fail(`licence ${m.license} differs from the list (${e.license})`)
    if (e.platforms?.length) {
      if (m.platforms?.length !== 1) fail('an official build targets exactly one platform')
      if (!e.platforms.some((p) => platformKey(p) === platformKey(m.platforms![0]))) fail(`platform ${platformKey(m.platforms![0])} is not one the list names`)
    } else if (m.platforms) fail('the list entry names no platform, the package does')
    if (driverMismatch(m, (p) => { const f = v.files.get(p); return f ? crypto.createHash('sha256').update(f).digest('hex') : undefined })) fail('not a build the core driver accepts (resources/hwp/manifest.json pins)')
    if (m.runtime?.driver === 'rhwp-v1') {
      const target = `${m.platforms![0]!.os}-${m.platforms![0]!.arch}`
      if (!o.cleared.includes(target)) fail(`HWP redistribution is not cleared for ${target} (resources/hwp/clearance.json)`)
    }
    if (o.testKeyId && m.signature?.keyId === o.testKeyId) fail('signed with the local plugin TEST key: build it with --official')
    const pin: CatalogPin = { version: m.version, ...(m.platforms ? { platform: m.platforms[0]! } : {}), manifestSha256: v.manifestSha256 }
    if (pinned.some((x) => x.id === m.id && platformKey(x.pin.platform) === platformKey(pin.platform))) fail(`two packages for ${m.id} ${platformKey(pin.platform) || '(any platform)'}`)
    pinned.push({ file, id: m.id, pin })
  }
  for (const e of doc.entries) {
    const fresh = pinned.filter((x) => x.id === e.id).map((x) => x.pin)
    if (!fresh.length) continue
    const keys = new Set(fresh.map((p) => platformKey(p.platform)))
    const order = (e.platforms ?? []).map(platformKey)
    const pins = [...(e.pins ?? []).filter((p) => p.version === e.version && !keys.has(platformKey(p.platform))), ...fresh]
      .sort((a, b) => order.indexOf(platformKey(a.platform)) - order.indexOf(platformKey(b.platform)))
    const next: Record<string, unknown> = { ...e, pins }
    for (const k of Object.keys(e)) delete (e as Record<string, unknown>)[k]
    for (const k of ENTRY_ORDER) if (next[k] !== undefined) (e as Record<string, unknown>)[k] = next[k]
  }
  for (const e of doc.entries) if (e.pins && !e.pins.length) delete e.pins
  const changed = canonicalJson(doc) !== before
  if (changed) doc.sequence += 1
  PluginCatalog.parse(doc)
  return { text: formatCatalog(doc), changed, pins: pinned }
}

function localTestKeyId(): string | null {
  try { const f = testKeyFile(); return fs.existsSync(f) ? keyIdOf(publicKeyOfPem(fs.readFileSync(f, 'utf8'))) : null } catch { return null }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--catalog')
  const dir = path.resolve(at >= 0 ? args[at + 1] ?? '' : path.join(REPO, 'resources/plugins'))
  const check = args.includes('--check')
  const files = args.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1))
  if (!files.length) { console.error('usage: bun scripts/plugins/pin-catalog.ts [--catalog <dir>] [--check] <package.trinaplugin>...'); process.exit(2) }
  const catalogFile = path.join(dir, 'catalog.json')
  const r = pinCatalog(fs.readFileSync(catalogFile, 'utf8'), files.map((f) => ({ file: f, bytes: fs.readFileSync(f) })), { cleared: clearedTargets(), testKeyId: localTestKeyId() })
  for (const p of r.pins) console.log(`${p.id} ${p.pin.version} ${platformKey(p.pin.platform) || '(any platform)'} ${p.pin.manifestSha256}  ${path.basename(p.file)}`)
  if (check) {
    if (r.changed) { console.error(`${catalogFile} does not pin these packages yet`); process.exit(1) }
    console.log('the official list already pins these packages')
  } else if (r.changed) {
    fs.writeFileSync(catalogFile, r.text)
    console.log(`wrote ${catalogFile}: review the pins like a key change, then release`)
  } else console.log('no change')
}
