// Admin > Plugins for the mock team server: an in-memory version of server/src/plugins/manager.ts with the same
// contract. The official list holds HWP Preview (not yet available, recommended for a Korean workspace) and one
// installable skill pack; an uploaded file named "*bad*" is refused as unsigned, any other upload is a test-signed pack.
import type { CatalogPlugin, InstalledPlugin, Locale, PluginList, PluginPlan } from '@mycel/shared/api'

type Pack = { id: string; version: string; name: Record<string, string>; description: Record<string, string>; trust: InstalledPlugin['trust']; skills: string[]; source: InstalledPlugin['source'] }
const now = () => new Date().toISOString()
const hex = (seed: string) => [...new Bun.CryptoHasher('sha256').update(seed).digest('hex')].join('')

const STARTER: Pack = {
  id: 'app.trina.office-starter', version: '1.0.0', trust: 'official', source: 'catalog', skills: ['meeting-minutes', 'weekly-report'],
  name: { en: 'Office starter skills', ko: '업무 시작 스킬', id: 'Skill awal kantor', ja: 'オフィス入門スキル', es: 'Habilidades de oficina iniciales' },
  description: { en: 'Meeting minutes and weekly reports for the whole company.', ko: '회사 전체가 쓰는 회의록·주간 보고 스킬입니다.', id: 'Notulen rapat dan laporan mingguan untuk seluruh perusahaan.', ja: '会社全体で使う議事録と週次報告のスキルです。', es: 'Actas de reuniones e informes semanales para toda la empresa.' },
}
const HWP = {
  id: 'app.trina.hwp-preview', version: '1.0.0',
  name: { en: 'HWP Preview', ko: '한글 문서 미리보기', id: 'Pratinjau HWP', ja: 'HWPプレビュー', es: 'Vista previa de HWP' },
  description: { en: 'Preview Hangul (HWP/HWPX) documents page by page in the file panel, and let the AI look at a page. Original files are not changed.', ko: '한글(HWP/HWPX) 문서를 파일 화면에서 페이지별로 미리 보고, AI가 페이지를 볼 수 있게 합니다. 원본 파일은 바꾸지 않습니다.', id: 'Pratinjau dokumen Hangul (HWP/HWPX) per halaman di panel berkas, dan biarkan AI melihat satu halaman. Berkas asli tidak diubah.', ja: 'ハングル文書（HWP/HWPX）をファイルパネルでページごとにプレビューし、AIがページを確認できるようにします。元のファイルは変更しません。', es: 'Vista previa página a página de documentos Hangul (HWP/HWPX) en el panel de archivos; la IA también puede ver una página. Los archivos originales no cambian.' },
}

export class MockPlugins {
  installed: (InstalledPlugin & { pack: Pack })[] = []
  plans = new Map<string, { plan: PluginPlan; pack: Pack; actor: string }>()

  reset() { this.installed = []; this.plans.clear() }

  private catalog(locale: Locale, teamLocale: Locale): CatalogPlugin[] {
    const inst = this.installed.find((p) => p.id === STARTER.id)
    return [
      {
        id: HWP.id, name: HWP.name[locale] ?? HWP.name.en, description: HWP.description[locale] ?? HWP.description.en, publisher: { id: 'trina', name: 'Trina' }, version: HWP.version,
        kinds: ['native-tool', 'preview'],
        permissions: [{ id: 'files.read.selected', required: true, granted: false }, { id: 'preview.render', required: true, granted: false }, { id: 'runtime.native.isolated', required: true, granted: false }, { id: 'model.send.preview-pixels', required: false, granted: false }],
        platforms: [{ os: 'darwin', arch: 'arm64' }, { os: 'darwin', arch: 'x64' }, { os: 'linux', arch: 'x64', libc: { family: 'glibc', minVersion: '2.39' } }, { os: 'linux', arch: 'arm64', libc: { family: 'glibc', minVersion: '2.39' } }],
        availability: 'pending_clearance', unsupported: null, recommended: teamLocale === 'ko', installedVersion: null, updateAvailable: false, license: 'MIT AND OFL-1.1',
      },
      {
        id: STARTER.id, name: STARTER.name[locale] ?? STARTER.name.en, description: STARTER.description[locale] ?? STARTER.description.en, publisher: { id: 'trina', name: 'Trina' }, version: STARTER.version,
        kinds: ['skill-pack'], permissions: [{ id: 'skills.company', required: true, granted: false }], platforms: null,
        availability: 'available', unsupported: null, recommended: false, installedVersion: inst?.version ?? null, updateAvailable: false, license: 'CC0-1.0',
      },
    ]
  }

  list(locale: Locale, teamLocale: Locale): PluginList {
    return {
      installed: this.installed.map(({ pack, ...p }) => ({ ...p, name: pack.name[locale] ?? pack.name.en, description: pack.description[locale] ?? pack.description.en })),
      catalog: this.catalog(locale, teamLocale), catalogSource: 'signed', imports: [],
      host: { os: 'linux', arch: 'x64', libc: '2.39' },
      trust: { productionKeys: 1, testKeys: 0, allowUnsigned: false, hosted: false }, trustWarnings: [], hwpReleaseGate: 'closed', fileInstall: true,
    }
  }

  plan(pack: Pack, actor: string, locale: Locale): PluginPlan {
    const cur = this.installed.find((p) => p.id === pack.id)
    const token = crypto.randomUUID()
    const plan: PluginPlan = {
      token, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), id: pack.id, name: pack.name[locale] ?? pack.name.en, description: pack.description[locale] ?? pack.description.en,
      publisher: { id: 'trina', name: 'Trina' }, version: pack.version, kinds: ['skill-pack'], trust: pack.trust, keyId: pack.trust === 'official' ? 'a1b2c3d4e5f60718' : '0f1e2d3c4b5a6978',
      manifestSha256: hex(pack.id + pack.version), permissions: [{ id: 'skills.company', required: true, new: false }], platforms: null, supported: true, unsupported: null,
      license: 'CC0-1.0', components: [], notices: [], skills: pack.skills, sizeBytes: 4096, archiveSha256: hex('archive' + pack.id + pack.version),
      update: cur ? { from: cur.version } : null, source: pack.source,
    }
    this.plans.set(token, { plan, pack, actor })
    return plan
  }

  inspectFile(name: string, actor: string, locale: Locale): PluginPlan | { reason: string } {
    if (/bad/i.test(name)) return { reason: 'signature' }
    return this.plan({ id: 'app.example.sample-skills', version: '0.1.0', trust: 'test', source: 'file', skills: ['sample'], name: { en: 'Sample skills' }, description: { en: 'A test-signed skill pack.' } }, actor, locale)
  }
  inspectCatalog(id: string, actor: string, locale: Locale): PluginPlan | { reason: string } {
    if (id === STARTER.id) return this.plan(STARTER, actor, locale)
    return { reason: 'not_available' }
  }

  install(token: string, digest: string, enable: boolean, actor: { id: string; name: string }): InstalledPlugin | { reason: string; status: number } {
    const p = this.plans.get(token)
    if (!p || p.actor !== actor.id) return { reason: 'expired', status: 410 }
    if (digest !== p.plan.manifestSha256) return { reason: 'digest', status: 409 }
    this.plans.delete(token)
    const prev = this.installed.find((x) => x.id === p.pack.id)
    this.installed = this.installed.filter((x) => x.id !== p.pack.id)
    const row = {
      pack: p.pack, id: p.pack.id, name: p.plan.name, description: p.plan.description, publisher: p.plan.publisher, version: p.pack.version, kinds: p.plan.kinds,
      trust: p.pack.trust, keyId: p.plan.keyId, manifestSha256: p.plan.manifestSha256, archiveSha256: p.plan.archiveSha256,
      enabled: enable, access: { everyone: enable, groups: [], users: [] }, status: enable ? 'enabled' as const : 'disabled' as const, unsupported: null,
      permissions: [{ id: 'skills.company' as const, required: true, granted: true }], platforms: null, license: 'CC0-1.0', components: [], source: p.pack.source,
      previousVersion: prev?.version ?? null, skills: enable ? p.pack.skills.map((s) => `skills/${p.pack.id}/${s}/SKILL.md`) : [],
      installedBy: actor, installedAt: now(), updatedAt: now(),
    }
    this.installed.push(row)
    const { pack: _pack, ...view } = row
    return view
  }

  set(id: string, enabled: boolean): InstalledPlugin | null {
    const p = this.installed.find((x) => x.id === id)
    if (!p) return null
    Object.assign(p, { enabled, status: enabled ? 'enabled' : 'disabled', access: { everyone: enabled, groups: [], users: [] }, skills: enabled ? p.pack.skills.map((s) => `skills/${p.id}/${s}/SKILL.md`) : [], updatedAt: now() })
    const { pack: _pack, ...view } = p
    return view
  }
  remove(id: string): boolean {
    const n = this.installed.length
    this.installed = this.installed.filter((x) => x.id !== id)
    return this.installed.length !== n
  }
}
