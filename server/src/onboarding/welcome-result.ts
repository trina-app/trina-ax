// The welcome steps' first result: the company's intro deck (docs/DECISIONS.md "D2 — The first result is the company's
// intro deck"; the promo video of "V" and the card news of "N" before it, both still installed with the general pack).
// POST /api/onboarding/welcome/first-result (the owner, who walks the steps):
//   1. the team's start if it is missing (the general pack and the team's group with its brand folder, welcome.ts);
//   2. "/intro-deck": the pack's skill, added on its own once for a row recorded before the skill existed;
//   3. the pictures the website reading collected (brand-assets.ts) go into the brand images folder, as the owner's
//      saves (versions, file events, the folder rules), each once;
//   4. no file from the owner: 회사 소개.md in the brand folder, written from the saved company profile and the text of
//      the pages the server opened, each part under its source (no AI here: nothing is invented); one already there is
//      kept as it is (someone may have edited it);
//   5. a new chat of the owner titled after the result ("우리 회사 소개서", a title the AI does not rename).
// No picture is made here or in that chat: a slide without a fitting picture is made in its type-only version.
// The page then attaches the files and sends "/intro-deck …" like any message of the owner's (pages/Welcome.tsx), so
// the turn is an ordinary skill run (the goal, the receipt and the transcript need nothing new); the deck opens beside
// the chat by itself (its artifact key, web/src/store/chats.ts).
import fs from 'node:fs'
import path from 'node:path'
import { GENERAL_DECK_SKILL, profileName, type FirstResultStarted, type Locale, type StartFirstResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AuthInfo } from '../services'
import type { ChatRuntime } from '../chat/runtime'
import { getTeamSettings, teamDefaultLocale } from '../admin/settings'
import { newChatEngine } from '../admin/engine-choice'
import { claudeModels } from '../admin/engines'
import { deckTier, TIERS } from '../intro-deck/tiers'
import { audit } from '../admin/audit'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { freeName } from '../team-files/place'
import { assetDir, BRAND_PAGE_TEXT_MAX, pageLines, stagedAssets, type BrandAssetRow } from './brand-assets'
import { readCompanyProfile } from './profile'
import { installPackSkill } from './skill-packs'
import { brandFoldersOf, introDeckSkill, readWelcome, setupWelcomeTeam } from './welcome'

const TEXT = {
  title: { ko: '우리 회사 소개서', en: 'Our company profile', id: 'Profil perusahaan kami', ja: '会社紹介資料', es: 'Presentación corporativa' },
  intro: { ko: '회사 소개.md', en: 'Company intro.md', id: 'Profil perusahaan.md', ja: '会社紹介.md', es: 'Presentación de la empresa.md' },
  logo: { ko: '로고', en: 'logo', id: 'logo', ja: 'ロゴ', es: 'logotipo' },
  image: { ko: '홈페이지', en: 'website', id: 'situs', ja: 'サイト', es: 'sitio' },
  blocked: {
    ko: '회사 소개서 스킬을 넣지 못했어요. 폴더 권한을 확인해 주세요.',
    en: 'The company profile skill could not be added. Check the folder permissions.',
    id: 'Skill profil perusahaan tidak bisa ditambahkan. Periksa izin folder.',
    ja: '会社紹介資料のスキルを追加できませんでした。フォルダーの権限を確認してください。',
    es: 'No se pudo añadir la habilidad de presentación corporativa. Revise los permisos de la carpeta.',
  },
  noMaterial: {
    ko: '아직 회사 소개가 없어요. 앞 단계에서 홈페이지를 읽거나 회사 소개 자료를 올려 주세요.',
    en: 'There is no company profile yet. Read the website in the previous step, or add a company intro file.',
    id: 'Belum ada profil perusahaan. Baca situs web di langkah sebelumnya, atau tambahkan berkas profil perusahaan.',
    ja: 'まだ会社紹介がありません。前のステップでホームページを読むか、会社紹介の資料を追加してください。',
    es: 'Aún no hay perfil de la empresa. Lea el sitio web en el paso anterior o añada un archivo de presentación.',
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

export function startFirstResult(ctx: AppContext, rt: ChatRuntime, auth: AuthInfo, locale: Locale, body: StartFirstResult): FirstResultStarted {
  const userId = auth.user.id
  let p = readWelcome(ctx)
  // the team's start (pack and group) when it is missing or from before the brand folder
  if (!p?.general || !p.teamGroup?.brandFolder) p = setupWelcomeTeam(ctx, userId, locale).progress
  const group = p.teamGroup
  if (!group || !p.general) throw new HttpError('conflict', TEXT.blocked[locale])
  const skillPath = introDeckSkill(ctx, userId, () => installPackSkill(ctx, userId, 'general', 'intro-deck'))
  if (!skillPath) throw new HttpError('conflict', TEXT.blocked[locale])
  const team = teamDefaultLocale(ctx.db)
  const { brandFolder, imagesFolder } = brandFoldersOf(ctx, userId, group.folder, group.brandFolder)
  const files = [...new Set(body.files.map((f) => ownerFile(ctx, userId, f.replace(/^\/+/, ''), locale)))]
  // the website's pictures (the latest website draft of the owner that collected any)
  const draft = latestDraftChat(ctx, userId)
  const images = draft ? placeBrandAssets(ctx, userId, draft, imagesFolder, team) : []
  sweepStagedAssets(ctx)
  let intro: string | null = null
  if (!files.length) {
    const profile = readCompanyProfile(ctx.files, ctx.files.principal(userId))
    const pages = draft ? stagedAssets(ctx.db, draft).pages : []
    if (!profile && !pages.length) throw new HttpError('conflict', TEXT.noMaterial[locale])
    const rel = `${brandFolder}/${TEXT.intro[team]}`
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), rel, 'write', { mustExist: false })
    if (!r.exists) {
      const name = profileName(profile, getTeamSettings(ctx.db).teamName) || group.name
      ctx.files.humanSave(userId, rel, Buffer.from(introMarkdown({ locale: team, name, profile, pages }), 'utf8'), null)
      intro = rel
    }
    files.push(r.rel)
  }
  // the chat: titled after the result (the AI does not rename a title the server gave)
  const chosen = newChatEngine(ctx, auth.user, {}, locale)
  // the deck's longest time budget (intro-deck/tiers.ts) writes its outline and copy with the strongest model the engine
  // offers (Claude Code's "opus" when it is on the list); otherwise the team's choice as for any chat
  const strong = TIERS[deckTier(ctx.db, ctx.config.mode === 'dev')].strongModel && chosen.engine === 'claude-code' && claudeModels(ctx.config).some((m) => m.id === 'opus') ? 'opus' : null
  const { engine, model } = { engine: chosen.engine, model: strong ?? chosen.model }
  const id = newId(), now = new Date().toISOString()
  ctx.db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?,?,NULL,?,'user',?,?,?,?)")
    .run(id, userId, TEXT.title[locale], engine, model ?? null, now, now)
  audit(ctx.db, { actor: userId, action: 'onboarding.first_result', target: id, detail: { files: files.length, intro: !!intro, images: images.length } })
  rt.publishChat(userId, id, 'created')
  return { chatId: id, title: TEXT.title[locale], skillPath: skillPath ?? GENERAL_DECK_SKILL, files, intro, imagesFolder, images }
}
