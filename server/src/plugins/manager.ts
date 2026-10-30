// The plugin manager of one server (docs/PLUGINS.md). Stage 1: company scope, owners and admins only.
//
//   inspect   verify a package (archive limits, strict manifest, trust, file inventory, platform, driver) and keep it
//             in <data>/plugins/incoming under a one-use token bound to the admin and the manifest digest. Trust: the
//             manifest digest pinned in the official list of this release (official, no key), else a plugin-key
//             signature (package.ts)
//   install   the admin approved exactly that digest and its permissions: stage the files in a temporary folder,
//             check them again, move the folder into <data>/plugins/store in one rename, then record it
//   enable / disable / update / rollback / uninstall — every change is audited (plugin.*), cancels HWP renders in
//             flight, drops cached pages and replaces the renderer instance
//   catalog   "Install" on the official list: the pinned build for this server is read next to the list or downloaded
//             from the release feed (https, the feed's origin only, public addresses, no redirects, the exact size and
//             SHA-256 the list names), then goes through the same inspect -> permission prompt -> install
//   revoked   a build the official list of this release withdrew is turned off at start (audit plugin.revoke) and is
//             never usable, installable, enabled or rolled back to
//
// Nothing here runs package code in the server. A native package only supplies bytes for a driver core implements
// (plugins/drivers.ts), run through the existing isolated converter path. The store lives outside the team folder, so
// file tools, search and share links never reach it. A broken or missing store never stops the server: the plugin
// shows as unsupported ('damaged') and its features stay off.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  compareSemVer, PLUGIN_DOWNLOAD_MAX, PLUGIN_MANIFEST_FILE, PLUGIN_SIGNATURE_FILE, PluginManifest, pluginStrings, type CatalogEntry, type CatalogPin, type PluginPermission,
} from '@mycel/shared/plugins'
import { RELEASE_CHANNEL } from '@mycel/shared'
import type {
  CatalogPlugin, InstalledPlugin, PluginList, PluginPlan, PluginRefusal, PluginTrust, PluginUnsupported, PluginVerifiedBy,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { checkSkill } from '../chat/skills'
import { fileEvent } from '../files/store'
import { disabledHwpEngine, NativeHwpEngine, type HwpEngine } from '../files/hwp-engine'
import { fail, HttpError } from '../http/errors'
import { feature, runKindOf } from '../system/deployment'
import { assertPublicHttps, type Lookup } from '../system/egress'
import { publishChanges } from '../team-files/changes'
import { defaultCatalogDir, loadCatalog, releasePins, revokedKey, revokedKeys, type LoadedCatalog } from './catalog'
import { driverMismatch, HWP_PLUGIN_ID } from './drivers'
import { PackageError, verifyPackage, type VerifiedPackage } from './package'
import { hostInfo, platformMismatch, productMismatch, type HostInfo } from './platform'
import { trustRoot, type TrustRoot } from './trust'

const PLAN_TTL_MS = 15 * 60_000
const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()

export interface PluginOptions {
  trust?: TrustRoot
  catalogDir?: string
  host?: HostInfo
  version?: string
  /** the environment's test trust settings (trust.ts), read when the trust root is built */
  env?: Record<string, string | undefined>
  /** test hooks for downloads from the release feed */
  download?: { fetch?: typeof fetch; lookup?: Lookup; origin?: string }
}

/** The whole download runs inside the admin's request: it must end (and say why) before the HTTP server drops an idle
 * connection (main.ts idleTimeout 120 s) and before the relay gives up on the answer (100 s). 90 s is about 1.5 Mbit/s
 * for the largest HWP build. */
const DOWNLOAD_TIMEOUT_MS = 90_000

interface Plan { token: string; actor: string; expires: number; file: string; archiveSha256: string; manifestSha256: string; source: 'file' | 'catalog' | 'import'; id: string; version: string }
interface PackageRow { plugin_id: string; version: string; archive_sha256: string; manifest_sha256: string; manifest: string; signature: string | null; trust: 'official' | 'test' | 'unverified'; key_id: string | null; source: 'file' | 'catalog' | 'import'; store_dir: string; installed_by: string | null; installed_at: string }
interface InstallRow { plugin_id: string; active_version: string; previous_version: string | null; permissions: string; approved_manifest_sha256: string; approved_by: string | null; approved_at: string; updated_at: string }
interface Installed { install: InstallRow; pkg: PackageRow; manifest: PluginManifest }

const refuse = (reason: PluginRefusal, code: 'validation' | 'conflict' | 'not_found' | 'gone' | 'forbidden' = 'validation', detail?: string): never =>
  fail(code, undefined, { params: { reason, ...(detail ? { detail: detail.slice(0, 300) } : {}) } })
/** A key always records its id; an official package without one was vouched for by a release pin (package.ts). */
const verifiedBy = (trust: PluginTrust, keyId: string | null): PluginVerifiedBy => trust === 'unverified' ? null : keyId ? 'key' : 'release'

export class PluginManager {
  trust: TrustRoot
  host: HostInfo
  version: string
  catalogDir: string
  private download: NonNullable<PluginOptions['download']> = {}
  private catalogCache: LoadedCatalog | null = null
  private plans = new Map<string, Plan>()
  private downloading = new Set<string>()
  private engines = new Map<string, NativeHwpEngine>()
  private roots: { rel: string; key: string; plugin: string }[] | null = null
  private storeRefused = false
  readonly base: string

  constructor(private ctx: AppContext, o: PluginOptions = {}) {
    // team-folder writes under a skill pack's folder are refused (policy/authorize.ts). Installed first, so nothing
    // below that fails can leave placed skill files writable.
    ctx.files.fx.managed = { managerOf: (segs) => this.managerOf(segs), heldBelow: (segs) => this.heldBelow(segs) }
    this.trust = o.trust ?? trustRoot({ runKind: runKindOf(ctx.config), env: o.env ?? process.env })
    this.download = o.download ?? {}
    this.host = o.host ?? hostInfo()
    this.version = o.version ?? ctx.version
    this.catalogDir = o.catalogDir ?? defaultCatalogDir()
    this.base = path.join(ctx.config.dataDir, 'plugins')
    for (const name of this.trust.ignored) ctx.log.warn('plugin test setting ignored on this server', { setting: name })
    if (this.trust.warnings.length) ctx.log.warn('plugin test trust is on: never use this on a customer server', { warnings: this.trust.warnings })
    // the store must never be inside the team folder (file tools, search and share links reach everything there);
    // a misplaced data folder turns plugin installs off instead of stopping the server
    const team = path.resolve(ctx.config.teamRoot) + path.sep
    this.storeRefused = (path.resolve(this.base) + path.sep).startsWith(team)
    if (this.storeRefused) ctx.log.error('the plugin store would be inside the team folder: plugin installs are off', { dataDir: ctx.config.dataDir })
    try { this.sweep() } catch (e) { ctx.log.warn('plugin incoming sweep failed', { err: e }) }
    try { this.turnOffRevoked() } catch (e) { ctx.log.error('could not turn off a revoked plugin build (it stays unusable)', { err: e }) }
  }

  /** Test hook: new trust / catalog / host / download (the trust settings in `env` only count when the trust root is
   * built; pass `trust`). */
  reconfigure(o: PluginOptions) {
    if (o.download) this.download = o.download
    if (o.trust) this.trust = o.trust
    if (o.host) this.host = o.host
    if (o.version) this.version = o.version
    if (o.catalogDir) this.catalogDir = o.catalogDir
    this.catalogCache = null
    this.changed()
    this.turnOffRevoked()
  }

  private dir(...p: string[]) { return path.join(this.base, ...p) }
  get fileInstall() { return feature(this.ctx.config, 'pluginFileInstall') }

  // ------------------------------------------------------------------ state

  catalog(): LoadedCatalog { return (this.catalogCache ??= loadCatalog(this.catalogDir, this.trust)) }

  private installed(id: string): Installed | null {
    const install = this.ctx.db.query('SELECT * FROM plugin_installs WHERE plugin_id = ?').get(id) as InstallRow | null
    if (!install) return null
    const pkg = this.pkg(id, install.active_version)
    if (!pkg) return null
    const manifest = this.manifestOf(pkg)
    return manifest ? { install, pkg, manifest } : null
  }
  private pkg(id: string, version: string): PackageRow | null {
    return this.ctx.db.query('SELECT * FROM plugin_packages WHERE plugin_id = ? AND version = ?').get(id, version) as PackageRow | null
  }
  private manifestOf(pkg: PackageRow): PluginManifest | null {
    try { return PluginManifest.parse(JSON.parse(pkg.manifest)) } catch { return null }
  }
  private allInstalled(): Installed[] {
    const ids = (this.ctx.db.query('SELECT plugin_id FROM plugin_installs ORDER BY plugin_id').all() as { plugin_id: string }[]).map((r) => r.plugin_id)
    return ids.map((id) => this.installed(id)).filter((x): x is Installed => !!x)
  }
  private access(id: string) {
    const rows = this.ctx.db.query('SELECT subject_type, subject_id FROM plugin_access WHERE plugin_id = ?').all(id) as { subject_type: string; subject_id: string }[]
    return { everyone: rows.some((r) => r.subject_type === 'everyone'), groups: rows.filter((r) => r.subject_type === 'group').map((r) => r.subject_id), users: rows.filter((r) => r.subject_type === 'user').map((r) => r.subject_id) }
  }
  private storePath(pkg: PackageRow) { return this.dir('store', pkg.plugin_id, pkg.store_dir) }

  /** The stored files still match the verified manifest. `full`: hash every byte (enable, rollback, renderer start). */
  private storeIntact(pkg: PackageRow, m: PluginManifest, full: boolean): boolean {
    const dir = this.storePath(pkg)
    try {
      for (const f of m.files) {
        const p = path.join(dir, ...f.path.split('/'))
        const st = fs.lstatSync(p)
        if (!st.isFile() || st.size !== f.size) return false
        if (full && sha256(fs.readFileSync(p)) !== f.sha256) return false
      }
      return true
    } catch { return false }
  }

  /** Why an installed plugin cannot run here now (null: it can). */
  private unsupported(x: Installed, full = false): PluginUnsupported | null {
    const m = x.manifest
    if (this.isRevoked(x.pkg.plugin_id, x.pkg.manifest_sha256)) return 'revoked'
    const shas = new Map(m.files.map((f) => [f.path, f.sha256]))
    const why = platformMismatch(m.platforms, this.host) ?? productMismatch(m.product, this.version) ?? driverMismatch(m, (p) => shas.get(p))
    if (why) return why
    if (!this.storeIntact(x.pkg, m, full)) return 'damaged'
    return null
  }

  /** The official list of this release withdrew this build. */
  isRevoked(id: string, manifestSha256: string): boolean {
    try { return revokedKeys(this.catalog()).has(revokedKey(id, manifestSha256)) } catch { return false }
  }

  /** Turn off every installed plugin whose active build the official list withdrew (at start, after a core update):
   * not on for anyone, its skills taken out, one audit line each. It also stays unusable without this (unsupported). */
  private turnOffRevoked() {
    const revoked = revokedKeys(this.catalog())
    if (!revoked.size) return
    for (const x of this.allInstalled()) {
      if (!revoked.has(revokedKey(x.pkg.plugin_id, x.pkg.manifest_sha256))) continue
      if (!this.ctx.db.query('SELECT 1 FROM plugin_access WHERE plugin_id = ?').get(x.pkg.plugin_id)) continue
      const id = x.pkg.plugin_id
      this.ctx.db.transaction(() => {
        this.ctx.db.query('DELETE FROM plugin_access WHERE plugin_id = ?').run(id)
        this.ctx.db.query('UPDATE plugin_installs SET updated_at = ? WHERE plugin_id = ?').run(now(), id)
      })()
      this.changed()
      this.removeSkills(id, null)
      audit(this.ctx.db, { actor: null, action: 'plugin.revoke', target: id, detail: { version: x.manifest.version, manifestSha256: x.pkg.manifest_sha256, reason: 'withdrawn in the official list of this release' } })
      this.ctx.log.warn('a withdrawn plugin build was turned off', { plugin: id, version: x.manifest.version })
    }
  }

  private approved(x: Installed): Set<PluginPermission> {
    if (x.install.approved_manifest_sha256 !== x.pkg.manifest_sha256) return new Set()
    try { return new Set(JSON.parse(x.install.permissions) as PluginPermission[]) } catch { return new Set() }
  }

  /** On for the company, runnable here, and every required permission approved for this exact manifest. */
  usable(id: string): boolean {
    try {
      const x = this.installed(id)
      if (!x || !this.access(id).everyone || this.unsupported(x)) return false
      const ok = this.approved(x)
      return x.manifest.permissions.required.every((p) => ok.has(p))
    } catch { return false }
  }
  granted(id: string, permission: PluginPermission): boolean {
    const x = this.installed(id)
    return !!x && this.usable(id) && this.approved(x).has(permission)
  }

  /** The HWP plugin while it is usable and is the rhwp-v1 native package (plugins/drivers.ts refuses anything else
   * under this id; checked here again so a malformed record can never reach the renderer). */
  private hwpPackage(): (Installed & { runtime: NonNullable<PluginManifest['runtime']> }) | null {
    if (!this.usable(HWP_PLUGIN_ID)) return null
    const x = this.installed(HWP_PLUGIN_ID)
    const runtime = x?.manifest.runtime
    return x && runtime?.driver === 'rhwp-v1' && runtime.fonts.length ? { ...x, runtime } : null
  }

  /** The HWP renderer for previews: the HWP plugin's package while it is usable, otherwise refused ('disabled'). */
  hwpEngine(): HwpEngine {
    const x = this.hwpPackage()
    if (!x) return disabledHwpEngine
    let e = this.engines.get(x.pkg.manifest_sha256)
    if (!e) {
      const dir = this.storePath(x.pkg), rt = x.runtime
      e = new NativeHwpEngine({ bin: path.join(dir, ...rt.executable.split('/')), fontsDir: path.dirname(path.join(dir, ...rt.fonts[0]!.split('/'))), digest: x.pkg.manifest_sha256 })
      this.engines.clear()
      this.engines.set(x.pkg.manifest_sha256, e)
    }
    return e
  }
  /** hwp_render: the preview is usable and the admin allowed page images to go to the AI provider. */
  hwpToolUsable(): boolean { return !!this.hwpPackage() && this.granted(HWP_PLUGIN_ID, 'model.send.preview-pixels') }

  /** After any change: no renderer instance, cached page or managed-path answer survives. */
  private changed() {
    this.engines.clear()
    this.roots = null
    this.ctx.files.events.emit('hwp-invalidate')
  }

  // ------------------------------------------------------------------ managed skill files

  private managedRoots() {
    if (!this.roots) {
      try { this.roots = (this.ctx.db.query('SELECT rel, plugin_id FROM plugin_managed_roots').all() as { rel: string; plugin_id: string }[]).map((r) => ({ rel: r.rel, key: this.fold(r.rel), plugin: r.plugin_id })) } catch { return [] }
    }
    return this.roots
  }
  private heldBelow(segs: readonly string[]): string | null {
    const key = this.fold(segs.join('/'))
    for (const r of this.managedRoots()) if (key === '' || key === r.key || r.key.startsWith(key + '/')) return r.plugin
    return null
  }
  private managerOf(segs: readonly string[]): string | null {
    if (!this.managedRoots().length) return null
    const key = this.fold(segs.join('/'))
    // the managed folder itself and everything in it. Its parent, skills/, is already a folder nobody moves or deletes
    // (team-files managed folders), and creating other entries in skills/ stays allowed.
    for (const r of this.managedRoots()) if (key === r.key || key.startsWith(r.key + '/')) return r.plugin
    return null
  }
  private fold(rel: string) { return this.ctx.files.fx.caseInsensitive ? rel.normalize('NFC').toLowerCase() : rel }
  private skillRoot(id: string) { return `skills/${id}` }

  /** The team-folder path of each payload skill file. */
  private skillTargets(m: PluginManifest): { from: string; rel: string }[] {
    const out: { from: string; rel: string }[] = []
    for (const s of m.contributes.skills ?? []) for (const f of m.files) if (f.path.startsWith(s.path + '/')) out.push({ from: f.path, rel: `${this.skillRoot(m.id)}/${f.path.slice('skills/'.length)}` })
    return out
  }
  /** Every SKILL.md must load as a company skill at its final path (no loader warning). */
  private checkSkills(m: PluginManifest, read: (p: string) => Buffer | undefined) {
    for (const s of m.contributes.skills ?? []) {
      const rel = `${this.skillRoot(m.id)}/${s.name}/SKILL.md`
      const text = read(`${s.path}/SKILL.md`)?.toString('utf8') ?? ''
      const r = checkSkill(text, rel)
      if (!r.ok) refuse('manifest', 'validation', `skill ${s.name} does not load (${r.problem})`)
    }
  }
  private skillsFolderFree(id: string) {
    const rel = this.skillRoot(id)
    const ours = this.ctx.db.query('SELECT 1 FROM plugin_managed_roots WHERE rel = ?').get(rel)
    if (!ours && fs.existsSync(path.join(this.ctx.files.fx.root, ...rel.split('/')))) refuse('skills_conflict', 'conflict', `${rel} already exists`)
  }

  /** Take the placed skill files out of the team folder. Only files that still hold exactly the bytes this plugin wrote
   * are deleted; one changed outside the app (a shell, Finder on the office Mac, a database restore) stays where it is.
   * `keepRoot`: the skills are placed again right away (update, rollback, re-enable), so the folder stays this plugin's
   * and its own leftovers cannot block that. */
  private removeSkills(id: string, actor: string | null, keepRoot = false) {
    const rows = this.ctx.db.query('SELECT rel, sha256 FROM plugin_managed_files WHERE plugin_id = ?').all(id) as { rel: string; sha256: string }[]
    const root = this.ctx.files.fx.root
    const changes: { path: string; action: 'delete'; by: { id: string; name: string }; turnId: null }[] = []
    const by = this.person(actor)
    for (const r of rows) {
      const abs = path.join(root, ...r.rel.split('/'))
      try {
        const st = fs.lstatSync(abs)
        if (!st.isFile() || st.isSymbolicLink()) continue
        if (sha256(fs.readFileSync(abs)) !== r.sha256) { this.ctx.log.warn('a plugin skill file was changed outside the app; it stays in place', { plugin: id, path: r.rel }); continue }
        fs.rmSync(abs)
        // a withdrawn build turned off at start has no person behind it
        fileEvent(this.ctx.db, { turnId: null, userId: actor ?? 'system', path: r.rel, action: 'delete', detail: { plugin: id } })
        changes.push({ path: r.rel, action: 'delete', by, turnId: null })
      } catch { /* already gone */ }
    }
    for (const r of this.ctx.db.query('SELECT rel FROM plugin_managed_roots WHERE plugin_id = ?').all(id) as { rel: string }[]) this.pruneEmpty(path.join(root, ...r.rel.split('/')))
    this.ctx.db.transaction(() => {
      this.ctx.db.query('DELETE FROM plugin_managed_files WHERE plugin_id = ?').run(id)
      if (!keepRoot) this.ctx.db.query('DELETE FROM plugin_managed_roots WHERE plugin_id = ?').run(id)
    })()
    this.roots = null
    if (changes.length) publishChanges(this.ctx, changes)
  }
  /** Remove empty folders below and including `dir` (files someone placed there by other means stay). */
  private pruneEmpty(dir: string): boolean {
    let st: fs.Stats
    try { st = fs.lstatSync(dir) } catch { return true }
    if (!st.isDirectory()) return false
    let empty = true
    for (const n of fs.readdirSync(dir)) if (!this.pruneEmpty(path.join(dir, n))) empty = false
    if (empty) try { fs.rmdirSync(dir) } catch { return false }
    return empty
  }

  private placeSkills(x: Installed, actor: string) {
    const m = x.manifest
    if (!m.contributes.skills?.length) return
    this.skillsFolderFree(m.id)
    const dir = this.storePath(x.pkg), root = this.ctx.files.fx.root, by = this.person(actor)
    const targets = this.skillTargets(m)
    const data = new Map(targets.map((t) => [t.from, fs.readFileSync(path.join(dir, ...t.from.split('/')))]))
    this.checkSkills(m, (p) => data.get(p))
    const rootRel = this.skillRoot(m.id)
    this.ctx.db.query('INSERT OR REPLACE INTO plugin_managed_roots (rel, plugin_id) VALUES (?, ?)').run(rootRel, m.id)
    this.roots = null
    const changes: { path: string; action: 'create'; by: { id: string; name: string }; turnId: null }[] = []
    for (const t of targets) {
      const abs = path.join(root, ...t.rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 })
      const bytes = data.get(t.from)!
      fs.writeFileSync(abs, bytes, { mode: 0o600 })
      const sum = sha256(bytes)
      this.ctx.db.query('INSERT OR REPLACE INTO plugin_managed_files (rel, plugin_id, sha256) VALUES (?, ?, ?)').run(t.rel, m.id, sum)
      // the same record as any skills/ change: audit line and the owner/admin notice (skills/changes.ts)
      fileEvent(this.ctx.db, { turnId: null, userId: actor, path: t.rel, action: 'create', size: bytes.length, sha256: sum, detail: { plugin: m.id } })
      changes.push({ path: t.rel, action: 'create', by, turnId: null })
    }
    publishChanges(this.ctx, changes)
  }
  private skillsOf(id: string): string[] {
    return (this.ctx.db.query("SELECT rel FROM plugin_managed_files WHERE plugin_id = ? AND rel LIKE '%/SKILL.md' ORDER BY rel").all(id) as { rel: string }[]).map((r) => r.rel)
  }

  private person(id: string | null): { id: string; name: string } {
    const r = id ? this.ctx.db.query('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | null : null
    return r ?? { id: id ?? '', name: '' }
  }

  // ------------------------------------------------------------------ views

  private installedView(x: Installed, locale: string): InstalledPlugin {
    const m = x.manifest, s = pluginStrings(m.i18n, locale), access = this.access(m.id), approved = this.approved(x)
    const why = this.unsupported(x)
    return {
      id: m.id, ...s, publisher: { id: m.publisher.id, name: m.publisher.name }, version: m.version, kinds: m.kinds,
      trust: x.pkg.trust, verifiedBy: verifiedBy(x.pkg.trust, x.pkg.key_id), keyId: x.pkg.key_id, manifestSha256: x.pkg.manifest_sha256, archiveSha256: x.pkg.archive_sha256,
      enabled: access.everyone, access,
      status: why ? 'unsupported' : access.everyone ? 'enabled' : 'disabled', unsupported: why,
      permissions: [...m.permissions.required.map((id) => ({ id, required: true, granted: approved.has(id) })), ...m.permissions.optional.map((id) => ({ id, required: false, granted: approved.has(id) }))],
      platforms: m.platforms ?? null, license: m.license,
      components: m.components.map((c) => ({ name: c.name, version: c.version ?? null, license: c.license })),
      source: x.pkg.source, previousVersion: x.install.previous_version, skills: this.skillsOf(m.id),
      installedBy: x.pkg.installed_by ? this.person(x.pkg.installed_by) : null, installedAt: x.pkg.installed_at, updatedAt: x.install.updated_at,
    }
  }

  private catalogView(e: CatalogEntry, locale: string, teamLocale: string, source: LoadedCatalog['source']): CatalogPlugin {
    const inst = this.installed(e.id)
    const platform = platformMismatch(e.platforms, this.host)
    const pins = this.hostPins(e)
    // installable from the list: a pinned build for this server to download from the release feed, or bytes next to the
    // list that it vouches for (a pin; or a plugin-key signed list, stage B5). Pinned without either: the official
    // package file installs through a file or the import folder. A pin never lifts pending_clearance.
    const fromList = pins.some((p) => p.download) || (!!e.package && (source === 'signed' || pins.length > 0))
    const availability: CatalogPlugin['availability'] = platform ? 'unsupported'
      : e.availability !== 'available' ? 'pending_clearance' : fromList ? 'available' : pins.length ? 'file' : 'pending_clearance'
    return {
      id: e.id, ...pluginStrings(e.i18n, locale), publisher: e.publisher, version: e.version, kinds: e.kinds,
      permissions: [...e.permissions.required.map((id) => ({ id, required: true, granted: false })), ...e.permissions.optional.map((id) => ({ id, required: false, granted: false }))],
      platforms: e.platforms ?? null,
      availability,
      unsupported: platform,
      // the workspace's own default language only (never the browser, the person or the network); a suggestion only
      recommended: !!e.recommendedFor?.locales.includes(teamLocale as never),
      installedVersion: inst?.manifest.version ?? null,
      updateAvailable: !!inst && (availability === 'available' || availability === 'file') && compareSemVer(e.version, inst.manifest.version) > 0,
      license: e.license,
    }
  }

  list(locale: string): PluginList {
    const cat = this.catalog()
    const teamLocale = teamDefaultLocale(this.ctx.db)
    return {
      installed: this.allInstalled().map((x) => this.installedView(x, locale)),
      catalog: cat.entries.map((e) => this.catalogView(e, locale, teamLocale, cat.source)),
      catalogSource: cat.source,
      imports: this.fileInstall ? this.importFiles() : [],
      host: { os: this.host.os, arch: this.host.arch, libc: this.host.libc },
      trust: { productionKeys: this.trust.keys.filter((k) => k.kind === 'official').length, testKeys: this.trust.keys.filter((k) => k.kind === 'test').length, allowUnsigned: this.trust.allowUnsigned, hosted: this.trust.hosted },
      trustWarnings: this.trust.warnings,
      fileInstall: this.fileInstall,
    }
  }

  view(id: string, locale: string): InstalledPlugin {
    const x = this.installed(id)
    if (!x) return refuse('not_installed', 'not_found')
    return this.installedView(x, locale)
  }

  // ------------------------------------------------------------------ inspect / install

  private importFiles(): { name: string; size: number }[] {
    const dir = this.dir('import')
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return [] }
    const out: { name: string; size: number }[] = []
    for (const n of names.sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.trinaplugin$/.test(n)) continue
      try { const st = fs.lstatSync(path.join(dir, n)); if (st.isFile() && !st.isSymbolicLink()) out.push({ name: n, size: st.size }) } catch { /* gone */ }
    }
    return out
  }

  private sweep() {
    const now = Date.now()
    for (const [t, p] of this.plans) if (p.expires < now) { this.plans.delete(t); fs.rmSync(p.file, { force: true }) }
    for (const sub of ['incoming', 'staging']) {
      let names: string[] = []
      try { names = fs.readdirSync(this.dir(sub)) } catch { continue }
      const live = new Set([...this.plans.values()].map((p) => path.basename(p.file)))
      for (const n of names) if (!live.has(n)) try { if (now - fs.lstatSync(this.dir(sub, n)).mtimeMs > PLAN_TTL_MS || sub === 'staging') fs.rmSync(this.dir(sub, n), { recursive: true, force: true }) } catch { /* gone */ }
    }
  }

  private verify(bytes: Uint8Array): VerifiedPackage {
    // pins come only from the official list in this release (never from a setting or the environment)
    const cat = this.catalog()
    try { return verifyPackage(bytes, this.trust, releasePins(cat), revokedKeys(cat)) } catch (e) {
      if (e instanceof PackageError) return refuse(e.reason, 'validation', e.message)
      throw e
    }
  }

  private whyNot(v: VerifiedPackage): PluginUnsupported | null {
    return platformMismatch(v.manifest.platforms, this.host) ?? productMismatch(v.manifest.product, this.version) ?? driverMismatch(v.manifest, (p) => {
      const f = v.files.get(p)
      return f ? sha256(f) : undefined
    })
  }

  /** Check a package and hold it for the admin's decision. */
  inspect(actor: string, bytes: Uint8Array, source: 'file' | 'catalog' | 'import', locale: string): PluginPlan {
    if (source !== 'catalog' && !this.fileInstall) refuse('file_install_off', 'forbidden')
    if (this.storeRefused) refuse('archive', 'conflict', 'the plugin store is not usable on this server')
    this.sweep()
    const v = this.verify(bytes)
    const m = v.manifest
    if (m.contributes.skills?.length) this.checkSkills(m, (p) => v.files.get(p))
    const cur = this.installed(m.id)
    if (cur) {
      const c = compareSemVer(m.version, cur.manifest.version)
      if (c === 0) refuse('same_version', 'conflict')
      if (c < 0) refuse('downgrade', 'conflict', `installed ${cur.manifest.version}; use roll back for an earlier version this server installed`)
    }
    if (!cur && m.contributes.skills?.length) this.skillsFolderFree(m.id)
    const token = crypto.randomUUID()
    fs.mkdirSync(this.dir('incoming'), { recursive: true, mode: 0o700 })
    const file = this.dir('incoming', `${token}.trinaplugin`)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    const expires = Date.now() + PLAN_TTL_MS
    this.plans.set(token, { token, actor, expires, file, archiveSha256: v.archiveSha256, manifestSha256: v.manifestSha256, source, id: m.id, version: m.version })
    const had = cur ? this.approved(cur) : new Set<PluginPermission>()
    const why = this.whyNot(v)
    return {
      token, expiresAt: new Date(expires).toISOString(),
      id: m.id, ...pluginStrings(m.i18n, locale), publisher: { id: m.publisher.id, name: m.publisher.name }, version: m.version, kinds: m.kinds,
      trust: v.trust, verifiedBy: verifiedBy(v.trust, v.keyId), keyId: v.keyId, manifestSha256: v.manifestSha256,
      permissions: [...m.permissions.required.map((id) => ({ id, required: true, new: !!cur && !had.has(id) })), ...m.permissions.optional.map((id) => ({ id, required: false, new: !!cur && !had.has(id) }))],
      platforms: m.platforms ?? null, supported: !why, unsupported: why,
      license: m.license, components: m.components.map((c) => ({ name: c.name, version: c.version ?? null, license: c.license })), notices: m.notices,
      skills: (m.contributes.skills ?? []).map((s) => s.name),
      sizeBytes: v.size, archiveSha256: v.archiveSha256,
      update: cur ? { from: cur.manifest.version } : null, source,
    }
  }

  /** The entry's pinned builds for this server's platform that the list has not withdrawn. */
  private hostPins(e: CatalogEntry): CatalogPin[] {
    return (e.pins ?? []).filter((p) => !platformMismatch(p.platform ? [p.platform] : undefined, this.host) && !this.isRevoked(e.id, p.manifestSha256))
  }

  /** Download a pinned build from the release feed: https on the feed's own origin, public addresses only (the hosted
   * outbound rule, system/egress.ts), no redirects, at most the size the list names, then that exact size and SHA-256
   * before anything opens the bytes. */
  private async fetchPinned(d: NonNullable<CatalogPin['download']>): Promise<Buffer> {
    const origin = this.download.origin ?? new URL(RELEASE_CHANNEL.feed).origin
    // the feed's origin first, so no other name is ever looked up
    let at: string | null = null
    try { at = new URL(d.url).origin } catch { /* refused below */ }
    if (at !== origin) return refuse('download', 'conflict', 'the package address is not on the release feed')
    let url: URL
    try { url = await assertPublicHttps(d.url, { lookup: this.download.lookup }) } catch (e) { return refuse('download', 'conflict', (e as Error).message) }
    const max = Math.min(d.size, PLUGIN_DOWNLOAD_MAX)
    let r: Response
    try { r = await (this.download.fetch ?? fetch)(url.href, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }) } catch (e) { return refuse('download', 'conflict', (e as Error).message) }
    if (!r.ok || !r.body) return refuse('download', 'conflict', `HTTP ${r.status}`)
    if (Number(r.headers.get('content-length') ?? 0) > max) return refuse('tampered', 'validation', 'the download is larger than the official list says')
    const chunks: Uint8Array[] = []
    let n = 0
    try {
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
        n += c.byteLength
        // leaving the loop cancels the stream
        if (n > max) return refuse('tampered', 'validation', 'the download is larger than the official list says')
        chunks.push(c)
      }
    } catch (e) {
      if (e instanceof HttpError) throw e
      return refuse('download', 'conflict', (e as Error).message)
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== d.size || sha256(bytes) !== d.sha256) return refuse('tampered', 'validation', 'the download does not match the official list')
    return bytes
  }

  async inspectCatalog(actor: string, id: string, locale: string): Promise<PluginPlan> {
    const cat = this.catalog()
    const e = cat.entries.find((x) => x.id === id)
    if (!e) return refuse('not_available', 'not_found')
    // cleared for distribution (a pin never lifts pending_clearance), made for this server, newer than what is installed:
    // checked before anything is downloaded
    if (e.availability !== 'available') return refuse('not_available', 'conflict')
    const why = platformMismatch(e.platforms, this.host)
    if (why) return refuse('unsupported', 'validation', why)
    const cur = this.installed(e.id)
    if (cur && compareSemVer(e.version, cur.manifest.version) <= 0) return refuse(compareSemVer(e.version, cur.manifest.version) === 0 ? 'same_version' : 'downgrade', 'conflict')
    const pins = this.hostPins(e)
    let bytes: Buffer
    if (e.package && (cat.source === 'signed' || pins.length)) {
      // an offline mirror: the package next to the list
      try { bytes = fs.readFileSync(path.join(cat.dir, ...e.package.file.split('/'))) } catch { return refuse('not_available', 'conflict') }
      if (bytes.length !== e.package.size || sha256(bytes) !== e.package.sha256) return refuse('tampered', 'validation', 'the package does not match the catalog')
    } else {
      const d = pins.find((p) => p.download)?.download
      if (!d) return refuse('not_available', 'conflict')
      // one download per plugin at a time (each holds up to the listed size in memory)
      if (this.downloading.has(e.id)) return refuse('download', 'conflict', 'this plugin is already being downloaded')
      this.downloading.add(e.id)
      try { bytes = await this.fetchPinned(d) } finally { this.downloading.delete(e.id) }
    }
    const plan = this.inspect(actor, bytes, 'catalog', locale)
    if (plan.id !== e.id || plan.version !== e.version) { this.drop(plan.token); return refuse('tampered', 'validation', 'the package is not the catalog entry') }
    // from a list without a plugin-key signature, only the builds it pins
    if (cat.source !== 'signed' && plan.verifiedBy !== 'release') { this.drop(plan.token); return refuse('not_available', 'conflict') }
    return plan
  }

  inspectImport(actor: string, name: string, locale: string): PluginPlan {
    if (!this.fileInstall) return refuse('file_install_off', 'forbidden')
    // only names this server listed: no paths, no links
    if (!this.importFiles().some((f) => f.name === name)) return refuse('import_missing', 'not_found')
    const p = this.dir('import', name)
    const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.size > 64 * 1024 * 1024) return refuse('archive', 'validation', 'not a regular file of a sane size')
      bytes = Buffer.alloc(st.size)
      fs.readSync(fd, bytes, 0, st.size, 0)
    } finally { fs.closeSync(fd) }
    return this.inspect(actor, bytes, 'import', locale)
  }

  private drop(token: string) {
    const p = this.plans.get(token)
    if (p) { this.plans.delete(token); fs.rmSync(p.file, { force: true }) }
  }

  /** Write the verified files into a fresh folder, check them from disk, then move the folder into place at once. */
  private stage(v: VerifiedPackage): string {
    const m = v.manifest
    const final = `${m.version}-${v.archiveSha256.slice(0, 12)}`
    const dest = this.dir('store', m.id, final)
    const tmp = this.dir('staging', crypto.randomUUID())
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 })
    try {
      for (const f of m.files) {
        const abs = path.join(tmp, ...f.path.split('/'))
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o755 })
        fs.writeFileSync(abs, v.files.get(f.path)!, { mode: f.executable ? 0o555 : 0o444, flag: 'wx' })
      }
      fs.writeFileSync(path.join(tmp, PLUGIN_MANIFEST_FILE), v.manifestText, { mode: 0o444, flag: 'wx' })
      if (v.sigText !== null) fs.writeFileSync(path.join(tmp, PLUGIN_SIGNATURE_FILE), v.sigText, { mode: 0o444, flag: 'wx' })
      for (const f of m.files) if (sha256(fs.readFileSync(path.join(tmp, ...f.path.split('/')))) !== f.sha256) throw new PackageError('tampered', `staged ${f.path} differs`)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(tmp, dest)
      return final
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true })
      if (e instanceof PackageError) return refuse(e.reason, 'validation', e.message)
      throw e
    }
  }

  private checkPermissions(m: PluginManifest, asked: readonly PluginPermission[]): PluginPermission[] {
    const set = new Set(asked)
    const allowed = new Set([...m.permissions.required, ...m.permissions.optional])
    if (!m.permissions.required.every((p) => set.has(p)) || [...set].some((p) => !allowed.has(p))) refuse('permissions')
    return [...set].sort()
  }

  install(actor: string, input: { token: string; manifestSha256: string; enable: boolean; permissions: PluginPermission[] }, locale: string): InstalledPlugin {
    const plan = this.plans.get(input.token)
    if (!plan || plan.actor !== actor || plan.expires < Date.now()) { if (plan) this.drop(plan.token); return refuse('expired', 'gone') }
    // the admin approved this digest; a package swapped after the prompt is refused
    if (input.manifestSha256 !== plan.manifestSha256) return refuse('digest', 'conflict')
    let bytes: Buffer
    try { bytes = fs.readFileSync(plan.file) } catch { this.drop(plan.token); return refuse('expired', 'gone') }
    this.drop(plan.token)
    if (sha256(bytes) !== plan.archiveSha256) return refuse('digest', 'conflict')
    const v = this.verify(bytes)
    if (v.manifestSha256 !== plan.manifestSha256) return refuse('digest', 'conflict')
    const m = v.manifest
    const why = this.whyNot(v)
    if (why) return refuse('unsupported', 'validation', why)
    const permissions = this.checkPermissions(m, input.permissions)
    const cur = this.installed(m.id)
    if (cur) {
      const c = compareSemVer(m.version, cur.manifest.version)
      if (c === 0) return refuse('same_version', 'conflict')
      if (c < 0) return refuse('downgrade', 'conflict')
    }
    // before anything is saved: the pack's folder must be free (or already this plugin's), also for an update that
    // turns it on, so a refusal never leaves a half-applied install behind
    if (m.contributes.skills?.length && (!cur || input.enable)) this.skillsFolderFree(m.id)
    const storeDir = this.stage(v)
    const at = now()
    const wasOn = cur ? this.access(m.id).everyone : false
    const on = input.enable
    const db = this.ctx.db
    const pruned: string[] = []
    db.transaction(() => {
      db.query('DELETE FROM plugin_packages WHERE plugin_id = ? AND version = ?').run(m.id, m.version)
      db.query(`INSERT INTO plugin_packages (plugin_id, version, archive_sha256, manifest_sha256, manifest, signature, trust, key_id, source, store_dir, installed_by, installed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, m.version, v.archiveSha256, v.manifestSha256, v.manifestText, v.sigText, v.trust, v.keyId, plan.source, storeDir, actor, at)
      db.query(`INSERT INTO plugin_installs (plugin_id, active_version, previous_version, permissions, approved_manifest_sha256, approved_by, approved_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET active_version = excluded.active_version, previous_version = excluded.previous_version,
        permissions = excluded.permissions, approved_manifest_sha256 = excluded.approved_manifest_sha256, approved_by = excluded.approved_by, approved_at = excluded.approved_at, updated_at = excluded.updated_at`)
        .run(m.id, m.version, cur?.manifest.version ?? null, JSON.stringify(permissions), v.manifestSha256, actor, at, at)
      // keep the active version and one rollback target
      for (const r of db.query('SELECT version, store_dir FROM plugin_packages WHERE plugin_id = ? AND version NOT IN (?, ?)').all(m.id, m.version, cur?.manifest.version ?? m.version) as { version: string; store_dir: string }[]) {
        db.query('DELETE FROM plugin_packages WHERE plugin_id = ? AND version = ?').run(m.id, r.version)
        pruned.push(r.store_dir)
      }
      db.query("DELETE FROM plugin_access WHERE plugin_id = ? AND subject_type = 'everyone'").run(m.id)
      if (on) db.query("INSERT INTO plugin_access (plugin_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(m.id)
    })()
    for (const d of pruned) fs.rmSync(this.dir('store', m.id, d), { recursive: true, force: true })
    this.changed()
    const x = this.installed(m.id)!
    if (cur?.manifest.contributes.skills?.length || m.contributes.skills?.length) {
      const place = on && !!m.contributes.skills?.length
      this.removeSkills(m.id, actor, place)
      if (place) this.placeSkills(x, actor)
    }
    audit(db, { actor, action: cur ? 'plugin.update' : 'plugin.install', target: m.id, detail: {
      version: m.version, ...(cur ? { from: cur.manifest.version } : {}), trust: v.trust, verifiedBy: verifiedBy(v.trust, v.keyId), keyId: v.keyId, source: plan.source,
      archiveSha256: v.archiveSha256, manifestSha256: v.manifestSha256, permissions, enabled: on, ...(cur ? { wasEnabled: wasOn } : {}),
    } })
    return this.installedView(x, locale)
  }

  // ------------------------------------------------------------------ lifecycle

  enable(actor: string, id: string, input: { permissions?: PluginPermission[]; manifestSha256?: string }, locale: string): InstalledPlugin {
    const x = this.installed(id)
    if (!x) return refuse('not_installed', 'not_found')
    // on enable every stored byte is hashed again (a replaced executable is refused here and before every run)
    const why = this.unsupported(x, true)
    if (why === 'damaged') return refuse('tampered', 'conflict')
    if (why === 'revoked') return refuse('revoked', 'conflict')
    if (why) return refuse('unsupported', 'validation', why)
    let permissions: PluginPermission[] | null = null
    if (input.permissions) {
      if (input.manifestSha256 !== x.pkg.manifest_sha256) return refuse('digest', 'conflict')
      permissions = this.checkPermissions(x.manifest, input.permissions)
    } else if (!x.manifest.permissions.required.every((p) => this.approved(x).has(p))) return refuse('permissions')
    // before anything is saved: someone may have made skills/<id>/ while the pack was off
    if (x.manifest.contributes.skills?.length) this.skillsFolderFree(id)
    const at = now()
    this.ctx.db.transaction(() => {
      if (permissions) this.ctx.db.query('UPDATE plugin_installs SET permissions = ?, approved_manifest_sha256 = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE plugin_id = ?').run(JSON.stringify(permissions), x.pkg.manifest_sha256, actor, at, at, id)
      else this.ctx.db.query('UPDATE plugin_installs SET updated_at = ? WHERE plugin_id = ?').run(at, id)
      this.ctx.db.query("INSERT OR IGNORE INTO plugin_access (plugin_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(id)
    })()
    this.changed()
    const now2 = this.installed(id)!
    if (x.manifest.contributes.skills?.length) { this.removeSkills(id, actor, true); this.placeSkills(now2, actor) }
    audit(this.ctx.db, { actor, action: 'plugin.enable', target: id, detail: { version: x.manifest.version, manifestSha256: x.pkg.manifest_sha256, ...(permissions ? { permissions } : {}), scope: 'everyone' } })
    return this.installedView(now2, locale)
  }

  disable(actor: string, id: string, locale: string): InstalledPlugin {
    const x = this.installed(id)
    if (!x) return refuse('not_installed', 'not_found')
    this.ctx.db.transaction(() => {
      this.ctx.db.query('DELETE FROM plugin_access WHERE plugin_id = ?').run(id)
      this.ctx.db.query('UPDATE plugin_installs SET updated_at = ? WHERE plugin_id = ?').run(now(), id)
    })()
    this.changed()
    this.removeSkills(id, actor)
    audit(this.ctx.db, { actor, action: 'plugin.disable', target: id, detail: { version: x.manifest.version } })
    return this.installedView(this.installed(id)!, locale)
  }

  rollback(actor: string, id: string, locale: string): InstalledPlugin {
    const x = this.installed(id)
    if (!x) return refuse('not_installed', 'not_found')
    const prevVersion = x.install.previous_version
    const prev = prevVersion ? this.pkg(id, prevVersion) : null
    const pm = prev ? this.manifestOf(prev) : null
    // only a version this server installed and verified before, and only if its files are still exactly those
    if (!prev || !pm) return refuse('no_rollback', 'conflict')
    const back: Installed = { install: x.install, pkg: prev, manifest: pm }
    const why = this.unsupported(back, true)
    if (why === 'damaged') return refuse('tampered', 'conflict')
    if (why === 'revoked') return refuse('revoked', 'conflict')
    if (why) return refuse('unsupported', 'validation', why)
    const approved = this.approved(x)
    const permissions = [...new Set([...pm.permissions.required, ...pm.permissions.optional.filter((p) => approved.has(p))])].sort()
    const on = this.access(id).everyone
    if (on && pm.contributes.skills?.length) this.skillsFolderFree(id)
    const at = now()
    this.ctx.db.query('UPDATE plugin_installs SET active_version = ?, previous_version = ?, permissions = ?, approved_manifest_sha256 = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE plugin_id = ?')
      .run(pm.version, x.manifest.version, JSON.stringify(permissions), prev.manifest_sha256, actor, at, at, id)
    this.changed()
    const now2 = this.installed(id)!
    if (x.manifest.contributes.skills?.length || pm.contributes.skills?.length) {
      const place = on && !!pm.contributes.skills?.length
      this.removeSkills(id, actor, place)
      if (place) this.placeSkills(now2, actor)
    }
    audit(this.ctx.db, { actor, action: 'plugin.rollback', target: id, detail: { from: x.manifest.version, to: pm.version, manifestSha256: prev.manifest_sha256, permissions } })
    return this.installedView(now2, locale)
  }

  uninstall(actor: string, id: string): void {
    const x = this.installed(id)
    const known = this.ctx.db.query('SELECT 1 FROM plugin_installs WHERE plugin_id = ?').get(id)
    if (!x && !known) return refuse('not_installed', 'not_found')
    this.removeSkills(id, actor)
    this.ctx.db.transaction(() => {
      this.ctx.db.query('DELETE FROM plugin_installs WHERE plugin_id = ?').run(id)
      this.ctx.db.query('DELETE FROM plugin_packages WHERE plugin_id = ?').run(id)
    })()
    this.changed()
    // stored package bytes go; documents, edited copies of skills and the audit trail stay
    fs.rmSync(this.dir('store', id), { recursive: true, force: true })
    audit(this.ctx.db, { actor, action: 'plugin.uninstall', target: id, detail: { version: x?.manifest.version ?? null } })
  }
}

const instances = new WeakMap<AppContext, PluginManager>()
/** The plugin manager of a server instance (created on first use; a broken store never throws here). */
export function pluginsOf(ctx: AppContext): PluginManager {
  let m = instances.get(ctx)
  if (!m) { m = new PluginManager(ctx); instances.set(ctx, m) }
  return m
}
