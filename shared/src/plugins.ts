// Plugin package contract, schema 0 = experimental (docs/PLUGINS.md, docs/DECISIONS.md "Plugins, stage 1"). The
// format may still change (for example toward Claude Code's `.claude-plugin/plugin.json` + `skills/` layout) before
// the first official package is published (pinned in a release) or a real plugin key signs anything; schema 1 will be
// fixed at that point.
//
// A plugin is a versioned package (`.trinaplugin`: a bounded tar, optionally gzip) with `trina-plugin.json` (this
// manifest) and payload files. The manifest lists every payload byte (path, size, SHA-256), so the SHA-256 of its
// canonical JSON binds the files, platforms, permissions and product range. An official package is trusted because
// that digest is pinned in the official list shipped inside the signed core release (CatalogPin). Later, third-party
// packages carry a detached `trina-plugin.sig`: Ed25519 over "trina-plugin-manifest-v1\n" + the canonical JSON. The
// `signature` field names the key and file; it never carries signature bytes (no self-hash cycle).
//
// Stage 1 installs two kinds: data-only skill packs (company skills) and native tool/preview packages whose driver
// core already knows (HWP: rhwp-v1). The other kinds are accepted by this schema so future packages parse, but the
// installer refuses them until their runtime exists. Unknown fields are refused everywhere (strict objects).
import { z } from 'zod'

export const PLUGIN_MANIFEST_FILE = 'trina-plugin.json'
export const PLUGIN_SIGNATURE_FILE = 'trina-plugin.sig'
export const PLUGIN_EXTENSION = '.trinaplugin'
/** Domain separation: a plugin signature can never be replayed as a release, catalog or other signature. */
export const PLUGIN_MANIFEST_DOMAIN = 'trina-plugin-manifest-v1\n'
export const PLUGIN_CATALOG_DOMAIN = 'trina-plugin-catalog-v1\n'
/** The host API this build implements; a package names the one it was built for. */
export const PLUGIN_API_VERSION = 1

export const PLUGIN_KINDS = ['skill-pack', 'native-tool', 'preview', 'connector-preset', 'region-pack', 'locale-pack'] as const
export const PluginKind = z.enum(PLUGIN_KINDS)
export type PluginKind = z.infer<typeof PluginKind>
/** What stage 1 can install. The rest are documented placeholders (docs/PLUGINS.md). */
export const SUPPORTED_PLUGIN_KINDS: readonly PluginKind[] = ['skill-pack', 'native-tool', 'preview']

/**
 * Permissions a package asks the company to approve. Every id has a fixed, translated explanation in the admin UI; an
 * unknown id is refused, so a package cannot invent wording for something it may do.
 * - skills.company: adds AI instructions (skills) for everyone who can read the company skills folder
 * - files.read.selected: processes only the documents each person selects and can already read
 * - preview.render: shows page images in the file panel
 * - runtime.native.isolated: runs a program on this server in an isolated process without network access
 * - model.send.preview-pixels: lets the AI look at page images, which sends them to the configured AI provider
 */
export const PLUGIN_PERMISSIONS = ['skills.company', 'files.read.selected', 'preview.render', 'runtime.native.isolated', 'model.send.preview-pixels'] as const
export const PluginPermission = z.enum(PLUGIN_PERMISSIONS)
export type PluginPermission = z.infer<typeof PluginPermission>

/** Install scopes. Stage 1 binds company only; group (a team inside the workspace) and personal come next. */
export const PluginScope = z.enum(['company', 'group', 'personal'])
export type PluginScope = z.infer<typeof PluginScope>

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/
export const SemVer = z.string().max(64).regex(SEMVER, 'a version like 1.2.3')
/** Reverse-DNS, lower case: app.trina.hwp-preview. An immutable namespace, never a display title. */
export const PluginId = z.string().max(100).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$/, 'a reverse-DNS id like app.trina.example')
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const KeyId = z.string().regex(/^[a-f0-9]{16}$/)
/** Payload paths: plain relative segments of letters, digits, dot, dash, underscore; no hidden or parent segments. */
export const PluginPath = z.string().max(400).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,7}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, 'a plain relative path')
  .refine((p) => !p.split('/').some((s) => s.endsWith('.')), 'no segment may end with a dot')
  .refine((p) => p !== PLUGIN_MANIFEST_FILE && p !== PLUGIN_SIGNATURE_FILE, 'reserved name')
const SkillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const Text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim() === s && !/[\u0000-\u001f\u007f<>]/.test(s), 'plain text without surrounding spaces')

export const PluginStrings = z.strictObject({ name: Text(60), description: Text(300) })
export const PluginI18n = z.strictObject({ en: PluginStrings, ko: PluginStrings.optional(), id: PluginStrings.optional(), ja: PluginStrings.optional(), es: PluginStrings.optional() })
export type PluginI18n = z.infer<typeof PluginI18n>

export const PluginOs = z.enum(['darwin', 'linux', 'any'])
export const PluginArch = z.enum(['arm64', 'x64', 'any'])
export const PluginPlatform = z.strictObject({
  os: PluginOs,
  arch: PluginArch,
  /** Linux only: the C library the executable needs (the pinned rhwp needs glibc 2.39; Debian 12 has 2.36) */
  libc: z.strictObject({ family: z.literal('glibc'), minVersion: z.string().regex(/^\d+\.\d+$/) }).optional(),
})
export type PluginPlatform = z.infer<typeof PluginPlatform>

export const PluginFile = z.strictObject({ path: PluginPath, sha256: Sha256, size: z.number().int().min(0).max(256 * 1024 * 1024), executable: z.boolean().optional() })
export type PluginFile = z.infer<typeof PluginFile>

/** Native drivers core implements. A package selects one; it cannot supply sandbox rules, argv or a shell command. */
export const PluginDriver = z.enum(['rhwp-v1'])
export type PluginDriver = z.infer<typeof PluginDriver>

export const PLUGIN_SCHEMA_VERSION = 0
export const PluginManifest = z.strictObject({
  schemaVersion: z.literal(PLUGIN_SCHEMA_VERSION),
  id: PluginId,
  version: SemVer,
  publisher: z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), name: Text(60), homepage: z.string().url().max(200).startsWith('https://').optional() }),
  kinds: z.array(PluginKind).min(1).max(PLUGIN_KINDS.length).refine((k) => new Set(k).size === k.length, 'kinds repeat'),
  product: z.strictObject({ apiVersion: z.number().int().min(1).max(99), minVersion: SemVer }),
  scopes: z.strictObject({ install: z.array(PluginScope).min(1).max(3), enable: z.array(PluginScope).min(1).max(3) }),
  i18n: PluginI18n,
  permissions: z.strictObject({ required: z.array(PluginPermission).max(10), optional: z.array(PluginPermission).max(10) }),
  /** absent: data only, any server. Native kinds need exactly one platform (one package per OS/CPU target). */
  platforms: z.array(PluginPlatform).min(1).max(8).optional(),
  runtime: z.strictObject({ driver: PluginDriver, executable: PluginPath, fonts: z.array(PluginPath).max(8) }).optional(),
  contributes: z.strictObject({
    skills: z.array(z.strictObject({ name: SkillName, path: PluginPath })).max(50).optional(),
    tools: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), driver: PluginDriver })).max(8).optional(),
    previews: z.array(z.strictObject({ extensions: z.array(z.string().regex(/^[a-z0-9]{1,10}$/)).min(1).max(8), tool: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), viewer: z.literal('core-raster-v1') })).max(8).optional(),
  }),
  license: z.string().min(1).max(100).regex(/^[A-Za-z0-9.+() -]+$/),
  components: z.array(z.strictObject({ name: Text(100), version: z.string().max(40).optional(), license: z.string().min(1).max(100).regex(/^[A-Za-z0-9.+() -]+$/), notice: PluginPath.optional() })).max(50),
  notices: z.array(PluginPath).max(50),
  source: z.strictObject({ url: z.string().url().max(300).startsWith('https://'), revision: z.string().max(100).optional() }).optional(),
  files: z.array(PluginFile).max(2000),
  signature: z.strictObject({ algorithm: z.literal('Ed25519'), keyId: KeyId, file: z.literal(PLUGIN_SIGNATURE_FILE) }).optional(),
}).superRefine((m, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path })
  const files = new Map(m.files.map((f) => [f.path, f]))
  if (files.size !== m.files.length) issue('a file is listed twice', ['files'])
  const folded = new Set(m.files.map((f) => f.path.toLowerCase()))
  if (folded.size !== m.files.length) issue('two files differ only by letter case', ['files'])
  // a path cannot be both a file and the folder of another file
  for (const f of m.files) for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) if (files.has(f.path.slice(0, i))) issue(`'${f.path.slice(0, i)}' is a file and a folder`, ['files'])
  const req = new Set(m.permissions.required)
  if (req.size !== m.permissions.required.length || new Set(m.permissions.optional).size !== m.permissions.optional.length) issue('a permission repeats', ['permissions'])
  for (const p of m.permissions.optional) if (req.has(p)) issue(`'${p}' is both required and optional`, ['permissions'])
  if (!m.scopes.install.includes('company')) issue('company installation is required', ['scopes'])
  for (const n of m.notices) if (!files.has(n)) issue(`notice '${n}' is not in files`, ['notices'])
  for (const c of m.components) if (c.notice && !files.has(c.notice)) issue(`component notice '${c.notice}' is not in files`, ['components'])
  const kinds = new Set(m.kinds)
  if (kinds.has('skill-pack')) {
    if (!m.contributes.skills?.length) issue('a skill pack contributes skills', ['contributes'])
    if (!req.has('skills.company')) issue("a skill pack requires 'skills.company'", ['permissions'])
    for (const s of m.contributes.skills ?? []) {
      if (s.path !== `skills/${s.name}`) issue(`skill '${s.name}' must live in skills/${s.name}`, ['contributes'])
      if (!files.has(`${s.path}/SKILL.md`)) issue(`skill '${s.name}' has no SKILL.md`, ['contributes'])
    }
    if (new Set((m.contributes.skills ?? []).map((s) => s.name)).size !== (m.contributes.skills ?? []).length) issue('a skill name repeats', ['contributes'])
  } else if (m.contributes.skills?.length) issue('skills need the skill-pack kind', ['kinds'])
  if (kinds.has('native-tool')) {
    if (!m.runtime) issue('a native tool names its runtime', ['runtime'])
    if (!req.has('runtime.native.isolated')) issue("a native tool requires 'runtime.native.isolated'", ['permissions'])
    if (m.platforms?.length !== 1 || m.platforms[0]!.os === 'any' || m.platforms[0]!.arch === 'any') issue('a native tool targets exactly one OS and CPU', ['platforms'])
    if (m.runtime) {
      const exe = files.get(m.runtime.executable)
      if (!exe?.executable) issue('the runtime executable must be listed as executable', ['runtime'])
      for (const f of m.runtime.fonts) if (!files.has(f)) issue(`font '${f}' is not in files`, ['runtime'])
    }
    if (!m.contributes.tools?.length) issue('a native tool contributes a tool', ['contributes'])
  } else if (m.runtime || m.contributes.tools?.length) issue('runtime and tools need the native-tool kind', ['kinds'])
  if (kinds.has('preview')) {
    if (!m.contributes.previews?.length) issue('a preview contributes previews', ['contributes'])
    if (!req.has('preview.render')) issue("a preview requires 'preview.render'", ['permissions'])
    const tools = new Set((m.contributes.tools ?? []).map((t) => t.id))
    for (const p of m.contributes.previews ?? []) if (!tools.has(p.tool)) issue(`preview tool '${p.tool}' is not contributed`, ['contributes'])
  } else if (m.contributes.previews?.length) issue('previews need the preview kind', ['kinds'])
  // no executable bits on data files of packages that run nothing
  if (!kinds.has('native-tool') && m.files.some((f) => f.executable)) issue('only a native tool may contain executables', ['files'])
  if (m.runtime) for (const f of m.files) if (f.executable && f.path !== m.runtime.executable) issue(`'${f.path}' is executable but is not the runtime`, ['files'])
})
export type PluginManifest = z.infer<typeof PluginManifest>

/** Detached signature file: the same shape as release signatures, over a plugin-specific domain. */
export const PluginSignature = z.strictObject({ keyId: KeyId, sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
export type PluginSignature = z.infer<typeof PluginSignature>

/**
 * A release pin: one package the product release vouches for, like a lockfile line. `manifestSha256` is the SHA-256 of
 * the package's canonical manifest — the digest the installer checks end to end (the admin approves it, installs and
 * approvals are bound to it, the renderer identity carries it). The manifest lists every payload file's size and
 * SHA-256 and the installer refuses any other byte, so a match fixes every byte it writes. `version` and `platform`
 * (absent for data-only packages that name no platform) must equal the package's own, so a pin never vouches for
 * another version or another OS, CPU or C library.
 */
export const CatalogPin = z.strictObject({ version: SemVer, platform: PluginPlatform.optional(), manifestSha256: Sha256 })
export type CatalogPin = z.infer<typeof CatalogPin>

/** One platform as a comparable key ('' for none): os/arch and, on Linux, the glibc floor. */
export const platformKey = (p: PluginPlatform | undefined | null): string => p ? `${p.os}/${p.arch}${p.libc ? `/${p.libc.family}-${p.libc.minVersion}` : ''}` : ''

/**
 * The bundled official catalog (stage 1: a static file shipped with the app, `resources/plugins/catalog.json`; stage 3
 * serves the same document from the update feed). It travels inside the signed core release, so the release's
 * signature covers it. Entries describe; an entry authorizes bytes only through `pins` (an official package is one
 * whose manifest digest a pin lists, for an entry that is `available`), or, once a plugin key exists, a detached
 * catalog signature plus a manifest signature by that key.
 */
export const CatalogEntry = z.strictObject({
  id: PluginId,
  version: SemVer,
  publisher: z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), name: Text(60) }),
  kinds: z.array(PluginKind).min(1),
  i18n: PluginI18n,
  permissions: z.strictObject({ required: z.array(PluginPermission), optional: z.array(PluginPermission) }),
  /** where it can run; absent = any server (data only) */
  platforms: z.array(PluginPlatform).optional(),
  /** pending_clearance: listed for discovery, no bytes are distributed yet (HWP: licence and platform review) */
  availability: z.enum(['available', 'pending_clearance']),
  /** a recommendation signal only: never installs or enables anything */
  recommendedFor: z.strictObject({ locales: z.array(z.enum(['ko', 'en', 'id', 'ja', 'es'])).max(5) }).optional(),
  /** where the package bytes come from, pinned by archive digest: a file next to the catalog (tests, offline mirrors;
   * the catalog shipped in default release bundles carries metadata only and never a package) */
  package: z.strictObject({ file: PluginPath, sha256: Sha256, size: z.number().int().positive() }).optional(),
  /** the official builds of this version, one per platform (docs/PLUGINS.md "공식 플러그인 확인"). Written by
   * scripts/plugins/pin-catalog.ts from the built packages, never by hand. A pin never makes a `pending_clearance`
   * entry installable. */
  pins: z.array(CatalogPin).max(16).optional(),
  /** a data-only official pack a new company gets turned on (decision pending, docs/PLUGINS.md); never for packages
   * that run programs */
  default: z.boolean().optional(),
  license: z.string().min(1).max(100),
}).refine((e) => !e.default || !e.kinds.some((k) => k === 'native-tool' || k === 'preview'), 'only data-only packs can be default')
  // pins are for this entry's version and for platforms it lists, at most one per platform
  .refine((e) => (e.pins ?? []).every((p) => p.version === e.version), 'a pin is for another version')
  .refine((e) => (e.pins ?? []).every((p) => e.platforms?.length ? e.platforms.some((q) => platformKey(q) === platformKey(p.platform)) : !p.platform), 'a pin is for a platform the entry does not list')
  .refine((e) => new Set((e.pins ?? []).map((p) => platformKey(p.platform))).size === (e.pins ?? []).length, 'two pins for one platform')
export type CatalogEntry = z.infer<typeof CatalogEntry>
export const PluginCatalog = z.strictObject({ schemaVersion: z.literal(PLUGIN_SCHEMA_VERSION), sequence: z.number().int().min(1), entries: z.array(CatalogEntry).max(200) })
  .refine((c) => new Set(c.entries.map((e) => e.id)).size === c.entries.length, 'an id repeats')
export type PluginCatalog = z.infer<typeof PluginCatalog>

/** Compare two strict SemVer strings (pre-releases sort before their release). */
export function compareSemVer(a: string, b: string): number {
  const p = (v: string) => { const [core, pre] = v.split('-', 2) as [string, string | undefined]; return { n: core.split('.').map(Number), pre: pre ? pre.split('.') : [] } }
  const x = p(a), y = p(b)
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const s = x.pre[i], t = y.pre[i]
    if (s === t) continue
    if (s === undefined) return -1
    if (t === undefined) return 1
    const sn = /^\d+$/.test(s), tn = /^\d+$/.test(t)
    if (sn && tn) return Number(s) < Number(t) ? -1 : 1
    if (sn !== tn) return sn ? -1 : 1
    return s < t ? -1 : 1
  }
  return 0
}

/** The manifest's strings in a language, English when that language is missing. */
export function pluginStrings(i18n: PluginI18n, locale: string): { name: string; description: string } {
  return (i18n as Record<string, { name: string; description: string } | undefined>)[locale] ?? i18n.en
}
