// The official catalog shipped with the app (resources/plugins/catalog.json, metadata only in default releases; stage 3
// serves the same signed document from the update feed). Three outcomes:
//   signed   its detached plugin-key signature (catalog.sig) verifies: shown, and an entry's pinned package may install
//   release  no signature yet (no production plugin key exists): the list travels inside the signed core release and is
//            shown as information only (availability, recommendation); nothing installs from it
//   none     missing, malformed, or a signature that does not verify (treated as tampering): nothing is shown
// Catalog text is presentation data: plain strings, never HTML. An entry never authorizes bytes by itself.
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CATALOG_DOMAIN, PluginCatalog, type CatalogEntry } from '@mycel/shared/plugins'
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
