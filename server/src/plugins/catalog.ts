// The official catalog shipped with the app (resources/plugins/catalog.json, metadata and digests only in default
// releases; stage 3 serves the same document from the update feed). It sits in the release bundle next to the server
// code, so the core release signature (the update feed) covers it as much as the code that reads it. Three outcomes:
//   release  no detached signature: the list as this release shipped it. Shown, and its pins vouch for official
//            packages (an entry's `pins`: canonical manifest digests per version and platform, like a lockfile)
//   signed   a detached plugin-key signature (catalog.sig, stage B5) verifies too: the same, plus a package signed by
//            a trusted plugin key may install from the list
//   none     missing, malformed, an unknown schemaVersion, or a signature that does not verify (treated as tampering):
//            nothing is shown or trusted from it
// `revoked` lists builds a later release withdrew: an installed one is turned off and refused (manager.ts).
// Catalog text is presentation data: plain strings, never HTML. No setting or environment variable adds pins: they
// come only from this file in the release (docs/PLUGINS.md "공식 플러그인 확인").
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CATALOG_DOMAIN, PluginCatalog, type CatalogEntry, type PluginPlatform, type RevokedPackage } from '@mycel/shared/plugins'
import { canonicalJson, parseStrictJson } from './json'
import { checkSignature, type TrustRoot } from './trust'

/** resources/plugins in a source checkout (repo root) or a release bundle (app/<version>/resources). */
export function defaultCatalogDir(): string {
  const candidates = [path.resolve(import.meta.dir, '../../..'), path.resolve(import.meta.dir, '../..')]
  const root = candidates.find((p) => fs.existsSync(path.join(p, 'resources/plugins/catalog.json'))) ?? candidates[0]!
  return path.join(root, 'resources/plugins')
}

export interface LoadedCatalog { source: 'signed' | 'release' | 'none'; entries: CatalogEntry[]; dir: string; sequence: number; revoked: RevokedPackage[] }

export function loadCatalog(dir: string, root: TrustRoot): LoadedCatalog {
  const none: LoadedCatalog = { source: 'none', entries: [], dir, sequence: 0, revoked: [] }
  let text: string, sig: string | null
  try { text = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8') } catch { return none }
  try { sig = fs.readFileSync(path.join(dir, 'catalog.sig'), 'utf8') } catch { sig = null }
  let raw: unknown
  try { raw = parseStrictJson(text) } catch { return none }
  const parsed = PluginCatalog.safeParse(raw)
  if (!parsed.success) return none
  const loaded = { entries: parsed.data.entries, dir, sequence: parsed.data.sequence, revoked: parsed.data.revoked ?? [] }
  if (sig === null) return { source: 'release', ...loaded }
  const check = checkSignature(root, PLUGIN_CATALOG_DOMAIN, canonicalJson(raw), sig, 'catalog')
  if (!check.ok) return none
  return { source: 'signed', ...loaded }
}

/** One digest the release vouches for. `available` false: the entry is listed but not cleared for distribution
 * (`pending_clearance`), so the pin must not make the package installable. */
export interface ReleasePin { id: string; publisher: string; version: string; platform: PluginPlatform | null; manifestSha256: string; available: boolean }

/** Every pin of a catalog this server can stand behind (a 'none' catalog vouches for nothing). A revoked build is never
 * a pin, even if the list still names it. */
export function releasePins(cat: LoadedCatalog): ReleasePin[] {
  if (cat.source === 'none') return []
  const revoked = revokedKeys(cat)
  return cat.entries.flatMap((e) => (e.pins ?? []).filter((p) => !revoked.has(revokedKey(e.id, p.manifestSha256))).map((p) => ({
    id: e.id, publisher: e.publisher.id, version: p.version, platform: p.platform ?? null, manifestSha256: p.manifestSha256,
    available: e.availability === 'available',
  })))
}

export const revokedKey = (id: string, manifestSha256: string) => `${id}\n${manifestSha256}`
/** The builds this release withdrew (plugin id + manifest digest). */
export function revokedKeys(cat: LoadedCatalog): Set<string> {
  return new Set(cat.revoked.map((r) => revokedKey(r.id, r.manifestSha256)))
}
