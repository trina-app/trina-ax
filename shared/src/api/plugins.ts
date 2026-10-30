// Admin > Plugins (docs/PLUGINS.md): installed plugins and the official catalog, install with a permission prompt,
// enable / disable / update / roll back / remove. Stage 1: company scope only, owners and admins only. Package and
// catalog checks happen on the server; refusals carry params.reason (one of PluginRefusal) so screens translate them.
import { z } from 'zod'
import { PluginKind, PluginPermission, PluginPlatform } from '../plugins'
import { IsoTime, SMALL_UPLOAD_MAX } from './common'
import { empty, endpoint, multipart } from './endpoint'

/** How a package was authenticated. official: its manifest digest is pinned in the official list that shipped inside
 * this signed product release, or (later, stage B5) a key in this product's plugin trust root signed it; test: a test
 * key trusted only in development (or on a test server the operator marked with MYCEL_PLUGINS_TEST_SERVER=1);
 * unverified: no valid signature, accepted only with the same development settings. Test and unverified never happen
 * on hosted or office servers, and no setting adds pins. */
export const PluginTrust = z.enum(['official', 'test', 'unverified'])
export type PluginTrust = z.infer<typeof PluginTrust>
/** What vouched for the package. release: the digest pinned in this release's official list; key: a plugin signing key
 * (official or test); null: nothing (unverified). */
export const PluginVerifiedBy = z.enum(['release', 'key']).nullable()
export type PluginVerifiedBy = z.infer<typeof PluginVerifiedBy>
/** Why a package cannot run here. damaged: the stored files no longer match the verified package; revoked: the official
 * list of this release withdrew this exact build (it was turned off). */
export const PluginUnsupported = z.enum(['os', 'arch', 'libc', 'product', 'api', 'kind', 'driver', 'damaged', 'revoked'])
export type PluginUnsupported = z.infer<typeof PluginUnsupported>
/** Why an install / enable request was refused (error params.reason). */
export const PluginRefusal = z.enum([
  'archive', 'manifest', 'signature', 'untrusted', 'tampered', 'unsupported', 'kind', 'driver', 'downgrade', 'same_version',
  'skills_conflict', 'expired', 'digest', 'permissions', 'not_available', 'not_installed', 'no_rollback', 'import_missing', 'file_install_off',
  'revoked', 'download', 'schema',
])
export type PluginRefusal = z.infer<typeof PluginRefusal>

const Strings = { name: z.string(), description: z.string() }
const Publisher = z.object({ id: z.string(), name: z.string() })
export const PluginPermissionView = z.object({ id: PluginPermission, required: z.boolean(), granted: z.boolean() })
export type PluginPermissionView = z.infer<typeof PluginPermissionView>
export const PluginComponentView = z.object({ name: z.string(), version: z.string().nullable(), license: z.string() })

export const InstalledPlugin = z.object({
  id: z.string(), ...Strings, publisher: Publisher, version: z.string(), kinds: z.array(PluginKind),
  trust: PluginTrust, verifiedBy: PluginVerifiedBy, keyId: z.string().nullable(),
  manifestSha256: z.string(), archiveSha256: z.string(),
  /** turned on for the whole company (stage 1 shows only this; the table also holds groups and people later) */
  enabled: z.boolean(),
  access: z.object({ everyone: z.boolean(), groups: z.array(z.string()), users: z.array(z.string()) }),
  /** enabled and usable here; disabled; unsupported (installed, but cannot run here now: see `unsupported`) */
  status: z.enum(['enabled', 'disabled', 'unsupported']),
  unsupported: PluginUnsupported.nullable(),
  permissions: z.array(PluginPermissionView),
  platforms: z.array(PluginPlatform).nullable(),
  license: z.string(),
  components: z.array(PluginComponentView),
  source: z.enum(['file', 'catalog', 'import']),
  /** the version a rollback returns to */
  previousVersion: z.string().nullable(),
  /** company skills this pack put in the team folder (paths), while enabled */
  skills: z.array(z.string()),
  installedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  installedAt: IsoTime,
  updatedAt: IsoTime,
})
export type InstalledPlugin = z.infer<typeof InstalledPlugin>

export const CatalogPlugin = z.object({
  id: z.string(), ...Strings, publisher: Publisher, version: z.string(), kinds: z.array(PluginKind),
  permissions: z.array(PluginPermissionView),
  platforms: z.array(PluginPlatform).nullable(),
  /** available: can be installed here from the list (the server downloads the pinned build from the release feed, or
   * reads it next to the list); file: an official build is pinned for this server without a download address, install
   * the official package file (Install from file or the import folder);
   * pending_clearance: listed, not yet distributed; unsupported: not on this server */
  availability: z.enum(['available', 'file', 'pending_clearance', 'unsupported']),
  unsupported: PluginUnsupported.nullable(),
  /** suggested for this company's language; a suggestion only, never installed or enabled automatically */
  recommended: z.boolean(),
  installedVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  license: z.string(),
})
export type CatalogPlugin = z.infer<typeof CatalogPlugin>

export const PluginList = z.object({
  installed: z.array(InstalledPlugin),
  catalog: z.array(CatalogPlugin),
  /** release: the list shipped inside this signed release (its pins vouch for official packages); signed: it also
   * carries a plugin-key signature that verified (stage B5); none: no catalog, or a signature that does not verify
   * (nothing from it is shown or trusted) */
  catalogSource: z.enum(['signed', 'release', 'none']),
  /** package files an operator placed in <data>/plugins/import on this server (self-hosted servers) */
  imports: z.array(z.object({ name: z.string(), size: z.number().int() })),
  host: z.object({ os: z.string(), arch: z.string(), libc: z.string().nullable() }),
  trust: z.object({ productionKeys: z.number().int(), testKeys: z.number().int(), allowUnsigned: z.boolean(), hosted: z.boolean() }),
  /** development trust settings in effect (an admin warning band is shown while any is on) */
  trustWarnings: z.array(z.enum(['test_keys', 'unsigned', 'test_server'])),
  /** this server takes package files (upload, import folder); hosted servers take official catalog packages only */
  fileInstall: z.boolean(),
})
export type PluginList = z.infer<typeof PluginList>

/** What the admin is asked to approve. The token binds this exact package, actor and permission set; it expires. */
export const PluginPlan = z.object({
  token: z.string(), expiresAt: IsoTime,
  id: z.string(), ...Strings, publisher: Publisher, version: z.string(), kinds: z.array(PluginKind),
  trust: PluginTrust, verifiedBy: PluginVerifiedBy, keyId: z.string().nullable(),
  /** the digest the admin approves; the install request must send it back unchanged */
  manifestSha256: z.string(),
  /** `new`: not granted to the installed version (an update asking for more) */
  permissions: z.array(z.object({ id: PluginPermission, required: z.boolean(), new: z.boolean() })),
  platforms: z.array(PluginPlatform).nullable(),
  supported: z.boolean(), unsupported: PluginUnsupported.nullable(),
  license: z.string(), components: z.array(PluginComponentView), notices: z.array(z.string()),
  /** the skills a skill pack adds to the company skills folder */
  skills: z.array(z.string()),
  sizeBytes: z.number().int(), archiveSha256: z.string(),
  update: z.object({ from: z.string() }).nullable(),
  source: z.enum(['file', 'catalog', 'import']),
})
export type PluginPlan = z.infer<typeof PluginPlan>

export const PluginInstallInput = z.object({
  token: z.string().min(1).max(100),
  /** the manifest digest shown in the prompt: refused if the inspected package is not that one */
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** enable for the whole company right away ("Install and enable") */
  enable: z.boolean(),
  /** every required permission plus the optional ones the admin allows */
  permissions: z.array(PluginPermission).max(20),
})
export type PluginInstallInput = z.infer<typeof PluginInstallInput>
export const PluginSourceInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('catalog'), id: z.string().min(1).max(100) }),
  z.object({ source: z.literal('import'), name: z.string().min(1).max(200) }),
])
/** Re-approval (after a rollback to a manifest whose approval is not on record) sends the permissions and the digest. */
export const PluginEnableInput = z.object({ permissions: z.array(PluginPermission).max(20).optional(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })

export const PLUGINS = {
  listPlugins: endpoint({ method: 'GET', path: '/api/admin/plugins', auth: 'admin', owner: 'C', response: PluginList, summary: 'Installed plugins, the official catalog for this server and the trust status.' }),
  inspectPluginFile: endpoint({ method: 'POST', path: '/api/admin/plugins/inspect', auth: 'admin', owner: 'C', body: multipart(z.object({}), SMALL_UPLOAD_MAX), response: PluginPlan, summary: 'Check an uploaded .trinaplugin (signature, files, platform) and return what installing it asks for. Installs nothing.' }),
  inspectPluginSource: endpoint({ method: 'POST', path: '/api/admin/plugins/inspect-source', auth: 'admin', owner: 'C', body: PluginSourceInput, response: PluginPlan, summary: 'The same check for a catalog package or a file in the server import folder.' }),
  installPlugin: endpoint({ method: 'POST', path: '/api/admin/plugins/install', auth: 'admin', owner: 'C', status: 201, body: PluginInstallInput, response: InstalledPlugin, summary: 'Install (or update to) the inspected package after the admin approved its permissions; optionally enable it for the company.' }),
  enablePlugin: endpoint({ method: 'POST', path: '/api/admin/plugins/:id/enable', auth: 'admin', owner: 'C', body: PluginEnableInput, response: InstalledPlugin, summary: 'Turn an installed plugin on for the whole company.' }),
  disablePlugin: endpoint({ method: 'POST', path: '/api/admin/plugins/:id/disable', auth: 'admin', owner: 'C', body: z.object({}), response: InstalledPlugin, summary: 'Turn it off for the company (stays installed).' }),
  rollbackPlugin: endpoint({ method: 'POST', path: '/api/admin/plugins/:id/rollback', auth: 'admin', owner: 'C', body: z.object({}), response: InstalledPlugin, summary: 'Go back to the previously installed version (verified again).' }),
  uninstallPlugin: endpoint({ method: 'DELETE', path: '/api/admin/plugins/:id', auth: 'admin', owner: 'C', status: 204, response: empty, summary: 'Remove the plugin and its files. Documents and edited copies of skills stay.' }),
} as const
