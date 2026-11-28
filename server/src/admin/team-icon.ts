// The team's logo (Admin › Team settings; docs/DECISIONS.md "Team logo as the tab icon", changed 2026-11-07): shown
// only inside the page, at the top of the computer's rail; the tab and app icons stay the product's. One file, <data>/team-icon,
// written atomically; its type and pixel size are read back from its header and its version is the start of its
// SHA-256, so nothing about it lives anywhere else (a database restored from a backup cannot disagree with it).
// Validation and the links are shared/src/team-icon.ts; the public /team-icon route is routes/web-static.ts.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkTeamIcon, imageInfo, TEAM_ICON_MAX_BYTES, TEAM_ICON_MAX_PX, TEAM_ICON_MIN_PX, type TeamIconFile, type TeamIconProblem } from '@mycel/shared'
import type { Locale, TeamIconInfo } from '@mycel/shared/api'
import { fail, HttpError } from '../http/errors'
import { writeAtomic } from '../system/streams'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

/** Refusals of an upload, in the uploader's language. */
export const TEXT: Record<TeamIconProblem, T> = {
  type: t('PNG, JPEG, WebP 이미지만 올릴 수 있어요.', 'Only PNG, JPEG or WebP images can be used.', 'Hanya gambar PNG, JPEG, atau WebP yang bisa dipakai.', "PNG、JPEG、WebP画像のみ使用できます。", "Solo se pueden usar imágenes PNG, JPEG o WebP.", "只能使用PNG、JPEG或WebP图片。"),
  mismatch: t('파일 내용이 PNG, JPEG, WebP 이미지가 아니에요. 이미지 파일을 다시 골라 주세요.', 'The file is not really a PNG, JPEG or WebP image. Choose the image file again.', 'Isi berkas bukan gambar PNG, JPEG, atau WebP. Pilih lagi berkas gambarnya.', "実際のファイル形式がPNG、JPEG、WebPではありません。画像ファイルを選び直してください。", "El archivo no es realmente una imagen PNG, JPEG o WebP. Vuelva a elegir el archivo.", "这个文件实际上不是PNG、JPEG或WebP图片。请重新选择图片文件。"),
  too_big: t(`이미지는 ${TEAM_ICON_MAX_BYTES / 1024 / 1024}MB까지 올릴 수 있어요.`, `The image can be at most ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`, `Gambar paling besar ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`, `画像は最大${TEAM_ICON_MAX_BYTES / 1024 / 1024} MBです。`, `La imagen puede ocupar como máximo ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`, `图片最大为${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB。`),
  too_small: t(`가로와 세로가 ${TEAM_ICON_MIN_PX}px 이상인 이미지를 올려 주세요.`, `Use an image at least ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} pixels.`, `Pakai gambar minimal ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} piksel.`, `${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX}ピクセル以上の画像を使ってください。`, `Use una imagen de al menos ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} píxeles.`, `请使用至少${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX}像素的图片。`),
  too_large: t(`가로와 세로가 ${TEAM_ICON_MAX_PX}px 이하인 이미지를 올려 주세요.`, `Use an image at most ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} pixels.`, `Pakai gambar paling besar ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} piksel.`, `${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX}ピクセル以下の画像を使ってください。`, `Use una imagen de como máximo ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} píxeles.`, `请使用最大${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX}像素的图片。`),
}
/** The words of Admin › Team logo › "From the website" (admin/team-icon-site.ts; the web mock says them too). */
export const SITE_ICON_TEXT = {
  noWebsite: t('회사 소개에 홈페이지 주소가 없어요. 회사 소개에서 홈페이지를 먼저 저장해 주세요.', 'The company profile has no website. Save the website in the company profile first.', 'Profil perusahaan belum punya situs web. Simpan dulu situs webnya di profil perusahaan.', '会社紹介にホームページがありません。先に会社紹介でホームページを保存してください。', 'El perfil de la empresa no tiene sitio web. Guarde primero el sitio web en el perfil de la empresa.', '公司介绍里没有网站地址。请先在公司介绍中保存网站。'),
  notReady: t('서버가 아직 준비 중이에요. 잠시 후 다시 눌러 주세요.', 'The server is still getting ready. Press it again in a moment.', 'Server masih bersiap. Tekan lagi sebentar lagi.', 'サーバーはまだ準備中です。少し待ってからもう一度押してください。', 'El servidor aún se está preparando. Vuelva a pulsarlo en un momento.', '服务器还在准备中。请稍后再按一次。'),
  notFound: t('홈페이지에서 쓸 만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요.', "We couldn't find an icon on the website that works as a logo. Upload a logo file instead.", 'Kami tidak menemukan ikon di situs web yang bisa dipakai sebagai logo. Unggah berkas logo saja.', 'ホームページにロゴとして使えるアイコンが見つかりませんでした。ロゴファイルをアップロードしてください。', 'No encontramos en el sitio web un icono que sirva como logo. Suba un archivo de logo.', '没有在网站上找到可以用作标志的图标。请上传标志文件。'),
  busy: t('홈페이지에서 아이콘을 가져오는 중이에요. 잠시 후 다시 눌러 주세요.', 'The icon is already being fetched from the website. Try again in a moment.', 'Ikon sedang diambil dari situs web. Coba lagi sebentar lagi.', 'ホームページからアイコンを取得中です。少し待ってからもう一度お試しください。', 'Ya se está obteniendo el icono del sitio web. Vuelva a intentarlo en un momento.', '正在从网站获取图标。请稍后再试。'),
} as const
const refuse = (problem: TeamIconProblem, locale: Locale): never =>
  fail(problem === 'too_big' ? 'payload_too_large' : 'validation', TEXT[problem][locale] ?? TEXT[problem].en, {
    params: { reason: problem },
    ...(problem === 'too_big' ? {} : { fields: { [problem === 'type' ? 'query.type' : 'body']: problem } }),
  })

/**
 * Realtime notice: the team logo changed. Open windows ask GET /api/me again and the top of their rail shows the new
 * version (or the product's mark again). The message carries nothing.
 */
export const TEAM_ICON_CHANGED = { type: 'notice', data: { level: 'info', code: 'team_icon_changed', message: '' } } as const

/** The one file (never a path from a request). Not inside the team folder: people and the AI cannot reach it. */
export const teamIconFile = (dataDir: string) => path.join(dataDir, 'team-icon')

const versionOf = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)

// read on every GET /api/me and /team-icon request: kept in memory while the file's stat stays the same
const cache = new Map<string, { key: string; icon: TeamIconFile | null }>()

/** The stored logo, or null (none, or a file that is no longer a logo we accept). */
export function readTeamIcon(dataDir: string): TeamIconFile | null {
  const file = teamIconFile(dataDir)
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { cache.delete(dataDir); return null }
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`
  const hit = cache.get(dataDir)
  if (hit && hit.key === key) return hit.icon
  let icon: TeamIconFile | null = null
  if (st.isFile() && st.size <= TEAM_ICON_MAX_BYTES) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(file))
      const info = imageInfo(bytes)
      if (info && checkTeamIcon(bytes, info.type).ok) icon = { bytes, ...info, version: versionOf(bytes) }
    } catch { /* unreadable: the default icon */ }
  }
  cache.set(dataDir, { key, icon })
  return icon
}

/** What GET /api/me says about the logo: its version (null: none). */
export function teamIconOfMe(dataDir: string): { iconVersion: string | null } {
  return { iconVersion: readTeamIcon(dataDir)?.version ?? null }
}

export const teamIconInfo = (i: TeamIconFile): TeamIconInfo => ({ version: i.version, type: i.type, width: i.width, height: i.height, size: i.bytes.byteLength })

/** Read the upload (at most 1 MiB), check it and store it in place of the old one. */
export async function saveTeamIcon(dataDir: string, body: AsyncIterable<Uint8Array>, declared: string, locale: Locale): Promise<TeamIconFile> {
  const parts: Uint8Array[] = []
  try {
    for await (const ch of body) parts.push(ch)
  } catch (e) {
    if (e instanceof HttpError && e.code === 'payload_too_large') refuse('too_big', locale)
    throw e
  }
  const bytes = new Uint8Array(Buffer.concat(parts))
  const r = checkTeamIcon(bytes, declared)
  if (!r.ok) return refuse(r.problem, locale)
  await writeAtomic([bytes], teamIconFile(dataDir), 0o600)
  cache.delete(dataDir)
  return { bytes, type: r.type, width: r.width, height: r.height, version: versionOf(bytes) }
}

/** Store checked bytes in place of the old logo (the admin's "from the website": an explicit press may replace one). */
export async function saveTeamIconBytes(dataDir: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<TeamIconFile | null> {
  const r = checkTeamIcon(bytes, type)
  if (!r.ok) return null
  await writeAtomic([bytes], teamIconFile(dataDir), 0o600)
  cache.delete(dataDir)
  return { bytes, type: r.type, width: r.width, height: r.height, version: versionOf(bytes) }
}

/**
 * Store checked bytes as the logo only if the team has none at this moment (onboarding: never over an uploaded one).
 * Not a check, then a write: the bytes go to a temporary file that is then hard-linked to <data>/team-icon, which fails
 * at once when a logo appeared meanwhile. Null when one is there (or the bytes are no logo).
 */
export function saveTeamIconIfAbsent(dataDir: string, bytes: Uint8Array<ArrayBuffer>, type: string): TeamIconFile | null {
  const r = checkTeamIcon(bytes, type)
  if (!r.ok) return null
  const target = teamIconFile(dataDir)
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    try { fs.linkSync(tmp, target) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw e
    }
  } finally {
    fs.rmSync(tmp, { force: true })
    cache.delete(dataDir)
  }
  return { bytes, type: r.type, width: r.width, height: r.height, version: versionOf(bytes) }
}

/** Remove the logo (the default icon again). False when there was none; 'stale' when `version` is given and the logo
 * now is another one (an undo never removes a newer logo). With a version it is not a check, then a remove (an upload's
 * rename could land between the two): the file is renamed aside first, so the bytes compared are the bytes removed;
 * another version is linked back unless a newer logo took the place meanwhile (that one stays). */
export function removeTeamIcon(dataDir: string, version?: string): boolean | 'stale' {
  cache.delete(dataDir)
  const target = teamIconFile(dataDir)
  if (version !== undefined) {
    const aside = `${target}.${crypto.randomBytes(6).toString('hex')}.undo`
    try { fs.renameSync(target, aside) } catch { return false }
    try {
      let bytes: Uint8Array | null = null
      try { bytes = new Uint8Array(fs.readFileSync(aside)) } catch { /* unreadable: put back */ }
      if (bytes && versionOf(bytes) === version) return true
      try { fs.linkSync(aside, target) } catch { /* a newer logo is there now: it stays */ }
      return 'stale'
    } finally {
      fs.rmSync(aside, { force: true })
      cache.delete(dataDir)
    }
  }
  try {
    fs.rmSync(teamIconFile(dataDir))
    return true
  } catch {
    return false
  }
}
