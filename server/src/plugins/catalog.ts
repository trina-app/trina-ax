// The official catalog shipped with the app (resources/plugins/catalog.json, metadata and digests only in default
// releases; stage 3 serves the same document from the update feed). It sits in the release bundle next to the server
// code, so the core release signature (the update feed) covers it as much as the code that reads it. Three outcomes:
//   release  no detached signature: the list as this release shipped it. Shown, and its pins vouch for official
//            packages (an entry's `pins`: canonical manifest digests per version and platform, like a lockfile)
//   signed   a detached plugin-key signature (catalog.sig, stage B5) verifies too: the same, plus a package signed by
//            a trusted plugin key may install from the list
//   none     missing, malformed, or a signature that does not verify (treated as tampering): nothing is shown or
//            trusted from it
// Catalog text is presentation data: plain strings, never HTML. No setting or environment variable adds pins: they
// come only from this file in the release (docs/PLUGINS.md "공식 플러그인 확인").
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CATALOG_DOMAIN, PluginCatalog, type CatalogEntry, type PluginPlatform } from '@mycel/shared/plugins'
import { canonicalJson, parseStrictJson } from './json'
import { checkSignature, type TrustRoot } from './trust'

/** resources/plugins in a source checkout (repo root) or a release bundle (app/<version>/resources). */
export function defaultCatalogDir(): string {
  const candidates = [path.resolve(import.meta.dir, '../../..'), path.resolve(import.meta.dir, '../..')]
  const root = candidates.find((p) => fs.existsSync(path.join(p, 'resources/plugins/catalog.json'))) ?? candidates[0]!
  return path.join(root, 'resources/plugins')
}

export interface LoadedCatalog { source: 'signed' | 'release' | 'none'; entries: CatalogEntry[]; dir: string; sequence: number }

export function loadCatalog(dir: string, root: TrustRoot): LoadedCatalog {
  const none: LoadedCatalog = { source: 'none', entries: [], dir, sequence: 0 }
  let text: string, sig: string | null
  try { text = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8') } catch { return none }
  try { sig = fs.readFileSync(path.join(dir, 'catalog.sig'), 'utf8') } catch { sig = null }
  let raw: unknown
  try { raw = parseStrictJson(text) } catch { return none }
  const parsed = PluginCatalog.safeParse(raw)
  if (!parsed.success) return none
  if (sig === null) return { source: 'release', entries: parsed.data.entries, dir, sequence: parsed.data.sequence }
  const check = checkSignature(root, PLUGIN_CATALOG_DOMAIN, canonicalJson(raw), sig, 'catalog')
  if (!check.ok) return none
  return { source: 'signed', entries: parsed.data.entries, dir, sequence: parsed.data.sequence }
}

/** One digest the release vouches for. `available` false: the entry is listed but not cleared for distribution
 * (`pending_clearance`), so the pin must not make the package installable. */
export interface ReleasePin { id: string; publisher: string; version: string; platform: PluginPlatform | null; manifestSha256: string; available: boolean }

/** Every pin of a catalog this server can stand behind (a 'none' catalog vouches for nothing). */
export function releasePins(cat: LoadedCatalog): ReleasePin[] {
  if (cat.source === 'none') return []
  return cat.entries.flatMap((e) => (e.pins ?? []).map((p) => ({
    id: e.id, publisher: e.publisher.id, version: p.version, platform: p.platform ?? null, manifestSha256: p.manifestSha256,
    available: e.availability === 'available',
  })))
}
