// The welcome steps' brand materials (docs/DECISIONS.md "W6 — Onboarding v6": 회사 소개 saves the profile only; before
// it, "D2 — The first result is the company's intro deck" started a deck here). POST /api/onboarding/welcome/brand (the
// owner, who walks the steps), with no AI, no chat and no skill:
//   1. the team's group with its brand folder when missing (welcome.ts setupWelcomeTeam, which installs nothing);
//   2. the pictures the website reading collected (brand-assets.ts) go into the brand images folder, as the owner's
//      saves (versions, file events, the folder rules), each once;
//   3. no file from the owner: 회사 소개.md in the brand folder, written from the saved company profile and the text of
//      the pages the server opened, each part under its source (nothing is invented); one already there is kept as it
//      is (someone may have edited it).
// 회사 소개서, 카드뉴스 and 홍보 영상 read these, so their first run has pictures and an intro. Safe to repeat: 고치기
// saves call it again and it writes only what is missing; the server runs it once on a read for an old row whose
// profile was saved without a deck (brandOnRead), and the skill installs run it while the team has no `brandAt` mark
// (ensureBrand).
import fs from 'node:fs'
import path from 'node:path'
import { profileName, type Locale, type WelcomeBrand, type WelcomeBrandResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getTeamSettings, teamDefaultLocale } from '../admin/settings'
import { audit } from '../admin/audit'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { freeName } from '../team-files/place'
import { assetDir, BRAND_PAGE_TEXT_MAX, pageLines, stagedAssets, type BrandAssetRow } from './brand-assets'
import { readCompanyProfile } from './profile'
import { BRAND_AT, BRAND_OWN_FILES, BRAND_TRIED_AT, brandDone, brandFoldersOf, brandOwnFiles, markBrand, readWelcome, setupWelcomeTeam, wantsBrandOnRead } from './welcome'

const TEXT = {
  intro: { ko: '회사 소개.md', en: 'Company intro.md', id: 'Profil perusahaan.md', ja: '会社紹介.md', es: 'Presentación de la empresa.md' },
  logo: { ko: '로고', en: 'logo', id: 'logo', ja: 'ロゴ', es: 'logotipo' },
  image: { ko: '홈페이지', en: 'website', id: 'situs', ja: 'サイト', es: 'sitio' },
  blocked: {
    ko: '팀 폴더를 만들지 못했어요. 폴더 권한을 확인해 주세요.',
    en: 'The team folder could not be made. Check the folder permissions.',
    id: 'Folder tim tidak bisa dibuat. Periksa izin folder.',
    ja: 'チームのフォルダーを作れませんでした。フォルダーの権限を確認してください。',
    es: 'No se pudo crear la carpeta del equipo. Revise los permisos de la carpeta.',
  },
  noMaterial: {
    ko: '아직 회사 소개가 없어요. 홈페이지를 읽거나 회사 소개 자료를 올려 주세요.',
    en: 'There is no company profile yet. Read the website, or add a company intro file.',
    id: 'Belum ada profil perusahaan. Baca situs web, atau tambahkan berkas profil perusahaan.',
    ja: 'まだ会社紹介がありません。ホームページを読むか、会社紹介の資料を追加してください。',
    es: 'Aún no hay perfil de la empresa. Lea el sitio web o añada un archivo de presentación.',
  },
  badFile: {
    ko: '올린 파일을 찾을 수 없어요. 다시 올려 주세요.',
    en: 'A file you added could not be found. Add it again.',
    id: 'Berkas yang Anda tambahkan tidak ditemukan. Tambahkan lagi.',
    ja: '追加したファイルが見つかりません。もう一度追加してください。',
    es: 'No se encontró un archivo que añadió. Añádalo de nuevo.',
  },
} satisfies Record<string, Record<Locale, string>>

/** 회사 소개.md's own words (the team's language). */
const MD: Record<Locale, { head: (name: string) => string; lead: (site: string) => string; leadNoSite: string; oneLine: string; products: string; audience: string; tone: string; avoid: string; colors: string; pages: string; source: string }> = {
  ko: { head: (n) => `# ${n} 회사 소개`, lead: (s) => `홈페이지(${s})를 읽고 확인한 내용이에요. 숫자와 사실은 아래에 적힌 것만 써요.`, leadNoSite: '회사 소개 단계에서 확인한 내용이에요. 숫자와 사실은 아래에 적힌 것만 써요.', oneLine: '한 줄 소개', products: '제품·서비스', audience: '고객', tone: '말투', avoid: '피하는 표현', colors: '브랜드 색', pages: '홈페이지에서 읽은 글', source: '출처' },
  en: { head: (n) => `# ${n} company intro`, lead: (s) => `What the website (${s}) says, as checked in the welcome steps. Use only the facts and numbers written here.`, leadNoSite: 'What was checked in the welcome steps. Use only the facts and numbers written here.', oneLine: 'In one line', products: 'Products and services', audience: 'Customers', tone: 'Tone of voice', avoid: 'Expressions to avoid', colors: 'Brand colors', pages: 'Text read on the website', source: 'Source' },
  id: { head: (n) => `# Profil perusahaan ${n}`, lead: (s) => `Isi situs web (${s}) yang diperiksa di langkah awal. Gunakan hanya fakta dan angka yang tertulis di sini.`, leadNoSite: 'Yang diperiksa di langkah awal. Gunakan hanya fakta dan angka yang tertulis di sini.', oneLine: 'Satu kalimat', products: 'Produk dan layanan', audience: 'Pelanggan', tone: 'Gaya bahasa', avoid: 'Ungkapan yang dihindari', colors: 'Warna merek', pages: 'Teks dari situs web', source: 'Sumber' },
  ja: { head: (n) => `# ${n} 会社紹介`, lead: (s) => `ホームページ（${s}）を読んで確認した内容です。数字と事実はここに書かれたものだけを使います。`, leadNoSite: '会社紹介のステップで確認した内容です。数字と事実はここに書かれたものだけを使います。', oneLine: 'ひとことで', products: '製品・サービス', audience: '顧客', tone: '話し方', avoid: '避ける表現', colors: 'ブランドカラー', pages: 'ホームページで読んだ文章', source: '出典' },
  es: { head: (n) => `# Presentación de ${n}`, lead: (s) => `Lo que dice el sitio web (${s}), revisado en los primeros pasos. Use solo los datos y cifras escritos aquí.`, leadNoSite: 'Lo revisado en los primeros pasos. Use solo los datos y cifras escritos aquí.', oneLine: 'En una línea', products: 'Productos y servicios', audience: 'Clientes', tone: 'Tono', avoid: 'Expresiones que se evitan', colors: 'Colores de marca', pages: 'Texto leído en el sitio web', source: 'Fuente' },
}

/** All of the website text that goes into 회사 소개.md, at most. */
const INTRO_PAGES_MAX_CHARS = 12_000
/** One page's text in 회사 소개.md, at most (its first lines: the page's own headings and paragraphs). */
const INTRO_PAGE_MAX_CHARS = 2_000

/** The latest website draft chat of this person that collected something (images or page text), or null. */
export function latestDraftChat(ctx: Pick<AppContext, 'db'>, userId: string): string | null {
  try {
    const r = ctx.db.query(`SELECT d.chat_id AS id FROM onboarding_profile_drafts d JOIN chats c ON c.id = d.chat_id
      WHERE d.user_id = ? AND d.source = 'website' AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM onboarding_brand_assets a WHERE a.chat_id = d.chat_id)
      ORDER BY d.created_at DESC LIMIT 1`).get(userId) as { id: string } | null
    return r?.id ?? null
  } catch { return null }
}

/** Page lines as Markdown quotes: each line its own quote (a blank line between, never an empty "> ") so a heading and
 * a paragraph do not run together. */
const quote = (lines: readonly string[]): string => lines.map((l) => `> ${l}`).join('\n\n')

/** 회사 소개.md from the profile (the person confirmed it) and the pages the server opened (quoted, with their address). */
export function introMarkdown(o: { locale: Locale; name: string; profile: ReturnType<typeof readCompanyProfile>; pages: Pick<BrandAssetRow, 'url' | 'title' | 'text'>[] }): string {
  const t = MD[o.locale]
  const p = o.profile
  const out: string[] = [t.head(o.name), '', p?.website ? t.lead(p.website) : t.leadNoSite, '']
  const section = (title: string, body: string | undefined, field?: string) => {
    if (!body?.trim()) return
    out.push(`## ${title}`, '', body.trim())
    const src = field ? p?.sources.find((s) => s.field === field) : undefined
    if (src?.url) out.push('', `${t.source}: ${src.url}${src.excerpt ? ` — "${src.excerpt}"` : ''}`)
    out.push('')
  }
  if (p) {
    section(t.oneLine, p.oneLine, 'oneLine')
    section(t.products, p.products, 'products')
    section(t.audience, p.audience, 'audience')
    section(t.tone, p.tone.join(', '), 'tone')
    section(t.avoid, p.avoid, 'avoid')
    section(t.colors, p.colors?.join(', '))
  }
  // each page's own words (brand-assets.ts pageLines: no menu, no blank or repeated lines; rows kept before that are
  // tidied the same way), a line another page said already left out (the site's footer, a slogan on every page)
  let used = 0
  const said = new Set<string>()
  const pages: { pg: (typeof o.pages)[number]; lines: string[] }[] = []
  for (const pg of o.pages) {
    const room = INTRO_PAGES_MAX_CHARS - used
    if (room < 200) break
    const lines = pageLines(pg.text ?? '', BRAND_PAGE_TEXT_MAX).filter((l) => !said.has(l.normalize('NFC').toLowerCase()))
    for (const l of lines) said.add(l.normalize('NFC').toLowerCase())
    // its first lines up to the page's share (a first line longer than that is cut with "…")
    const kept = pageLines(lines.join('\n'), Math.min(room, INTRO_PAGE_MAX_CHARS))
    if (!kept.length) continue
    used += kept.reduce((n, l) => n + l.length + 1, 0)
    pages.push({ pg, lines: kept })
  }
  if (pages.length) {
    out.push(`## ${t.pages}`, '')
    for (const { pg, lines } of pages) out.push(`### ${(pg.title ?? '').replace(/\s+/g, ' ').trim() || pg.url}`, '', `${t.source}: ${pg.url}`, '', quote(lines), '')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** The staged pictures of a draft chat into the brand images folder (each once), as the owner's saves. */
export function placeBrandAssets(ctx: AppContext, userId: string, chatId: string, imagesFolder: string, locale: Locale): string[] {
  const placed: string[] = []
  const dir = assetDir(ctx.engineConfig.dataDir, chatId)
  let n = 0
  for (const a of stagedAssets(ctx.db, chatId).images) {
    if (a.placed_path) { placed.push(a.placed_path); continue }
    const src = a.file ? path.join(dir, a.file) : null
    if (!src || !fs.existsSync(src)) continue
    const ext = path.extname(a.file!).toLowerCase()
    const base = a.kind === 'logo' ? TEXT.logo[locale] : `${TEXT.image[locale]}-${++n}`
    try {
      const folder = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), imagesFolder, 'write', { mustExist: true })
      const name = freeName(folder.abs, `${base}${ext}`)
      const rel = `${imagesFolder}/${name}`
      ctx.files.humanSave(userId, rel, fs.readFileSync(src), null)
      ctx.db.query('UPDATE onboarding_brand_assets SET placed_path = ? WHERE chat_id = ? AND seq = ?').run(rel, chatId, a.seq)
      fs.rmSync(src, { force: true })
      placed.push(rel)
    } catch (err) {
      ctx.log.warn('brand picture not placed', { err })
    }
  }
  return placed
}

/** Staged pictures that will never be placed: those of chats deleted since, and those of drafts older than the latest
 * one that a first result placed (only the latest draft's pictures are ever placed). Their rows stay with the chat. */
export function sweepStagedAssets(ctx: AppContext): void {
  const root = path.join(ctx.engineConfig.dataDir, 'onboarding-assets')
  let dirs: string[]
  try { dirs = fs.readdirSync(root) } catch { return }
  for (const d of dirs) {
    try {
      const chat = ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND deleted_at IS NULL').get(d)
      const pending = ctx.db.query("SELECT 1 FROM onboarding_brand_assets WHERE chat_id = ? AND file IS NOT NULL AND placed_path IS NULL LIMIT 1").get(d)
      // a later draft of the same person whose pictures were placed (another owner's drafts are theirs to place)
      const placedLater = ctx.db.query(`SELECT 1 FROM onboarding_brand_assets a JOIN onboarding_profile_drafts p ON p.chat_id = a.chat_id
        JOIN onboarding_profile_drafts mine ON mine.chat_id = ?
        WHERE a.placed_path IS NOT NULL AND p.user_id = mine.user_id AND p.created_at > mine.created_at LIMIT 1`).get(d)
      // a draft still collecting (a row in the last ten minutes) is left alone: its file may be on its way
      const busy = ctx.db.query('SELECT 1 FROM onboarding_brand_assets WHERE chat_id = ? AND created_at > ? LIMIT 1').get(d, new Date(Date.now() - 10 * 60_000).toISOString())
      if (!busy && (!chat || !pending || placedLater)) fs.rmSync(path.join(root, d), { recursive: true, force: true })
    } catch (err) { ctx.log.warn('staged brand pictures not swept', { err }) }
  }
}

/** A file the owner gave: a team file they can read (the upload just made it), normalized. */
function ownerFile(ctx: AppContext, userId: string, rel: string, locale: Locale): string {
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), rel, 'read', { mustExist: true })
    if (r.st?.isFile()) return r.rel
  } catch { /* below */ }
  throw new HttpError('validation', TEXT.badFile[locale], { fields: { 'body.files': 'not_found' } })
}

/**
 * The brand materials, as the owner (docs/DECISIONS.md "W6"): the team's start when its group or brand folder is
 * missing, the website's pictures into the brand images folder, and 회사 소개.md unless the owner gave intro files (one
 * there is kept). Records `brandAt` once it ran through. Throws what failed (the folder rules, no material at all):
 * the profile stays saved either way.
 */
export function placeBrand(ctx: AppContext, userId: string, locale: Locale, body: WelcomeBrand): Omit<WelcomeBrandResult, 'progress'> {
  let p = readWelcome(ctx)
  if (!p?.teamGroup?.brandFolder) p = setupWelcomeTeam(ctx, userId, locale).progress
  const group = p.teamGroup
  if (!group) throw new HttpError('conflict', TEXT.blocked[locale])
  const team = teamDefaultLocale(ctx.db)
  const { brandFolder, imagesFolder } = brandFoldersOf(ctx, userId, group.folder, group.brandFolder)
  const files = [...new Set(body.files.map((f) => ownerFile(ctx, userId, f.replace(/^\/+/, ''), locale)))]
  // the website's pictures (the latest website draft of the owner that collected any)
  const draft = latestDraftChat(ctx, userId)
  const images = draft ? placeBrandAssets(ctx, userId, draft, imagesFolder, team) : []
  sweepStagedAssets(ctx)
  let intro: string | null = null
  let wrote = false
  // the owner's own files are the intro, now or since an earlier press (a 고치기 save after a reload sends none)
  if (files.length) markBrand(ctx, BRAND_OWN_FILES)
  else if (!brandOwnFiles(ctx)) {
    const rel = `${brandFolder}/${TEXT.intro[team]}`
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), rel, 'write', { mustExist: false })
    if (!r.exists) {
      const profile = readCompanyProfile(ctx.files, ctx.files.principal(userId))
      const pages = draft ? stagedAssets(ctx.db, draft).pages : []
      if (!profile && !pages.length) throw new HttpError('conflict', TEXT.noMaterial[locale])
      const name = profileName(profile, getTeamSettings(ctx.db).teamName) || group.name
      ctx.files.humanSave(userId, rel, Buffer.from(introMarkdown({ locale: team, name, profile, pages }), 'utf8'), null)
      wrote = true
    }
    intro = r.rel
  }
  const first = !brandDone(ctx)
  markBrand(ctx, BRAND_AT)
  if (first || wrote || images.length) audit(ctx.db, { actor: userId, action: 'onboarding.brand', target: brandFolder, detail: { files: files.length, intro: wrote, images: images.length } })
  return { brandFolder, imagesFolder, images, intro }
}

/** Whose brand materials a read puts in: the active owner with the latest website reading (its pictures are theirs:
 * latestDraftChat is per person), else the oldest active owner. */
const brandOwner = (ctx: Pick<AppContext, 'db'>): string | null => {
  let id: string | null = null
  try {
    id = (ctx.db.query(`SELECT d.user_id AS id FROM onboarding_profile_drafts d JOIN users u ON u.id = d.user_id
      WHERE d.source = 'website' AND u.role = 'owner' AND u.status = 'active' AND u.deleted_at IS NULL
      ORDER BY d.created_at DESC LIMIT 1`).get() as { id: string } | null)?.id ?? null
  } catch { id = null }
  return id ?? (ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL AND status = 'active' ORDER BY created_at LIMIT 1").get() as { id: string } | null)?.id ?? null
}

/** The server's own run on a welcome read (docs/DECISIONS.md "W6", review M6), once: an unfinished old row whose
 * profile was saved without a deck now counts 회사 소개 as answered and would never press 저장하고 계속 again, so its
 * pictures and 회사 소개.md are put in here, as the first owner. Tried once whatever comes of it; never throws. */
export function brandOnRead(ctx: AppContext): void {
  try {
    if (!wantsBrandOnRead(ctx)) return
    markBrand(ctx, BRAND_TRIED_AT)
    const owner = brandOwner(ctx)
    if (!owner) return
    ctx.files.principal(owner)
    placeBrand(ctx, owner, teamDefaultLocale(ctx.db), { files: [] })
  } catch (err) {
    ctx.log.warn('the brand materials were not placed on the welcome read', { err })
  }
}

/** Before an install of 회사 소개서, 카드뉴스 or 홍보 영상 (docs/DECISIONS.md "W6", §2.1 and §4.2 of the plan): the brand
 * materials, while the team has no `brandAt` mark and the welcome row exists, as the installing person. Never throws:
 * the install goes on either way. Returns whether the materials are there now. */
export function ensureBrand(ctx: AppContext, userId: string): boolean {
  try {
    if (brandDone(ctx)) return true
    if (!readWelcome(ctx)) return false
    placeBrand(ctx, userId, teamDefaultLocale(ctx.db), { files: [] })
    return true
  } catch (err) {
    ctx.log.warn('the brand materials were not placed before a skill install', { err })
    return false
  }
}
