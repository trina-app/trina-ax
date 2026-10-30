// Plugin test helpers: a fresh Ed25519 key per run (no test private key is ever committed), skill-pack packages,
// trust roots and signed catalogs.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CATALOG_DOMAIN, PLUGIN_SCHEMA_VERSION, type CatalogEntry, type PluginPermission } from '@mycel/shared/plugins'
import { buildPackage, type ManifestDraft } from '../../server/src/plugins/package'
import { canonicalJson } from '../../server/src/plugins/json'
import { keyIdOf, publicKeyOfPem, signDetached, trustRoot } from '../../server/src/plugins/trust'

export function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  const pub = publicKeyOfPem(pem)
  return { pem, pub, keyId: keyIdOf(pub) }
}

/** Production trust with one official key for publisher "trina" (ids app.trina.*). */
export const prodTrust = (pub: string, runKind: 'selfhost' | 'hosted' | 'office' | 'dev' = 'selfhost') =>
  trustRoot({ runKind, env: {}, productionKeys: [{ publicKey: pub, publishers: ['trina'], idPrefixes: ['app.trina.'], catalog: true }] })

export const skillText = (name: string, description: string, body = 'Follow the steps.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`

export function skillManifest(o: { id?: string; version?: string; skills: string[]; permissions?: PluginPermission[] }): ManifestDraft {
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION, id: o.id ?? 'app.trina.office-starter', version: o.version ?? '1.0.0',
    publisher: { id: 'trina', name: 'Trina' }, kinds: ['skill-pack'],
    product: { apiVersion: 1, minVersion: '0.1.0' }, scopes: { install: ['company'], enable: ['company'] },
    i18n: { en: { name: 'Office starter', description: 'Meeting minutes and weekly reports.' }, ko: { name: '업무 시작 스킬', description: '회의록과 주간 보고.' } },
    permissions: { required: o.permissions ?? ['skills.company'], optional: [] },
    contributes: { skills: o.skills.map((name) => ({ name, path: `skills/${name}` })) },
    license: 'CC0-1.0', components: [], notices: [],
  }
}

/** A skill pack: each skill gets a SKILL.md and a small resource. */
export function skillPack(o: { id?: string; version?: string; skills?: Record<string, string>; keyPem?: string | null; permissions?: PluginPermission[]; gzip?: boolean; extra?: Record<string, string> }) {
  const skills = o.skills ?? { 'meeting-minutes': 'Turn meeting notes into minutes with decisions and owners.', 'weekly-report': 'Draft a weekly status report.' }
  const payload = new Map<string, Uint8Array>()
  for (const [name, desc] of Object.entries(skills)) {
    payload.set(`skills/${name}/SKILL.md`, Buffer.from(skillText(name, desc)))
    payload.set(`skills/${name}/template.md`, Buffer.from(`# ${name} template\n`))
  }
  for (const [p, t] of Object.entries(o.extra ?? {})) payload.set(p, Buffer.from(t))
  return buildPackage({ manifest: skillManifest({ id: o.id, version: o.version, skills: Object.keys(skills), permissions: o.permissions }), payload, keyPem: o.keyPem === undefined ? null : o.keyPem, gzip: o.gzip })
}

/** A catalog folder with catalog.json (+ catalog.sig when a key is given) and the given package files. */
export function catalogDir(dir: string, entries: CatalogEntry[], files: Record<string, Uint8Array> = {}, keyPem?: string) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const doc = { schemaVersion: PLUGIN_SCHEMA_VERSION, sequence: 1, entries }
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(doc, null, 2))
  for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), b) }
  if (keyPem) fs.writeFileSync(path.join(dir, 'catalog.sig'), signDetached(keyPem, PLUGIN_CATALOG_DOMAIN, canonicalJson(doc)))
  return dir
}

export const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

export function packEntry(id: string, version: string, file: string, bytes: Uint8Array, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id, version, publisher: { id: 'trina', name: 'Trina' }, kinds: ['skill-pack'],
    i18n: { en: { name: 'Office starter', description: 'Meeting minutes and weekly reports.' } },
    permissions: { required: ['skills.company'], optional: [] }, availability: 'available',
    package: { file, sha256: sha256(bytes), size: bytes.length }, license: 'CC0-1.0', ...extra,
  }
}
