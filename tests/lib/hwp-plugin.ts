// The HWP plugin's install state for tests of Hangul writing and filling (make_file .hwpx, edit_hwp), which the server
// offers while the plugin is installed and on for the company (server/src/tools/hwp-writing.ts), whether or not its
// renderer can run. The rows are those an admin's "install and turn on" writes (plugins/manager.ts install), for an HWP
// package whose executable is not the pinned rhwp: no rhwp is needed in the checkout, and the renderer never runs (the
// plugin shows as unsupported: "driver"). The real package and its lifecycle are in tests/unit/plugins-hwp.test.ts.
import crypto from 'node:crypto'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
import { PluginManifest } from '@mycel/shared/plugins'
import hwpPins from '../../resources/hwp/manifest.json'
import type { AppContext } from '../../server/src/context'
import { canonicalJson } from '../../server/src/plugins/json'

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const REQUIRED = ['files.read.selected', 'preview.render', 'runtime.native.isolated']

/** An HWP Preview manifest for this machine whose executable is not the pinned rhwp (so it is never run). */
export function fakeHwpManifest(version = '1.0.0'): PluginManifest {
  return PluginManifest.parse({
    schemaVersion: 1, id: HWP_PLUGIN_ID, version, publisher: { id: 'trina', name: 'Trina' }, kinds: ['native-tool', 'preview'],
    product: { apiVersion: 1, minVersion: '0.1.0' }, scopes: { install: ['company'], enable: ['company'] },
    i18n: { en: { name: 'HWP Preview', description: 'Pages.' }, ko: { name: '한글 문서 미리보기', description: '페이지.' } },
    permissions: { required: REQUIRED, optional: ['model.send.preview-pixels'] },
    platforms: [{ os: process.platform === 'darwin' ? 'darwin' : 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }],
    runtime: { driver: 'rhwp-v1', executable: 'bin/rhwp', fonts: ['fonts/NotoSansKR-Regular.ttf'] },
    contributes: { tools: [{ id: 'render-page', name: 'hwp_render', driver: 'rhwp-v1' }], previews: [{ extensions: ['hwp', 'hwpx'], tool: 'render-page', viewer: 'core-raster-v1' }] },
    license: 'MIT AND OFL-1.1', components: [{ name: 'rhwp', version: hwpPins.version, license: 'MIT' }], notices: [],
    files: [{ path: 'bin/rhwp', sha256: 'c'.repeat(64), size: 1, executable: true }, { path: 'fonts/NotoSansKR-Regular.ttf', sha256: hwpPins.fonts[0]!.sha256, size: 1 }],
  })
}

/** Install the HWP plugin as an admin's install would record it, on for the company or (`on: false`) installed only.
 * `permissions`: what the admin approved (default: the required ones and the page-image permission). Returns the
 * manifest digest. */
export function installHwpPlugin(ctx: AppContext, o: { on?: boolean; version?: string; permissions?: string[] } = {}): string {
  const m = fakeHwpManifest(o.version)
  const text = canonicalJson(m)
  const digest = sha256(text)
  const at = new Date().toISOString()
  const permissions = JSON.stringify([...(o.permissions ?? [...REQUIRED, 'model.send.preview-pixels'])].sort())
  const db = ctx.db
  db.transaction(() => {
    db.query('DELETE FROM plugin_packages WHERE plugin_id = ? AND version = ?').run(HWP_PLUGIN_ID, m.version)
    db.query(`INSERT INTO plugin_packages (plugin_id, version, archive_sha256, manifest_sha256, manifest, signature, trust, key_id, source, store_dir, installed_by, installed_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'official', NULL, 'catalog', ?, NULL, ?)`).run(HWP_PLUGIN_ID, m.version, sha256(`archive ${m.version}`), digest, text, `${m.version}-test`, at)
    db.query(`INSERT INTO plugin_installs (plugin_id, active_version, previous_version, permissions, approved_manifest_sha256, approved_by, approved_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, NULL, ?, ?) ON CONFLICT(plugin_id) DO UPDATE SET active_version = excluded.active_version, permissions = excluded.permissions,
      approved_manifest_sha256 = excluded.approved_manifest_sha256, approved_at = excluded.approved_at, updated_at = excluded.updated_at`).run(HWP_PLUGIN_ID, m.version, permissions, digest, at, at)
  })()
  setHwpPlugin(ctx, o.on ?? true)
  return digest
}

/** Turn the installed HWP plugin on or off for the company: the row the admin's Turn on / Turn off writes. (Turn on
 * itself re-hashes the package first, which a package with a stand-in renderer cannot pass.) */
export function setHwpPlugin(ctx: AppContext, on: boolean) {
  ctx.db.query("DELETE FROM plugin_access WHERE plugin_id = ? AND subject_type = 'everyone'").run(HWP_PLUGIN_ID)
  if (on) ctx.db.query("INSERT INTO plugin_access (plugin_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(HWP_PLUGIN_ID)
}

/** Hangul writing on, for tests of the writers that are not about the plugin. */
export const hwpPluginOn = (ctx: AppContext) => { installHwpPlugin(ctx, { on: true }) }

/** No HWP plugin at all (as after Remove). */
export function removeHwpPlugin(ctx: AppContext) {
  ctx.db.transaction(() => {
    ctx.db.query('DELETE FROM plugin_access WHERE plugin_id = ?').run(HWP_PLUGIN_ID)
    ctx.db.query('DELETE FROM plugin_installs WHERE plugin_id = ?').run(HWP_PLUGIN_ID)
    ctx.db.query('DELETE FROM plugin_packages WHERE plugin_id = ?').run(HWP_PLUGIN_ID)
  })()
}
