// The team's logo as the tab icon (Admin › Team settings; docs/DECISIONS.md "팀 로고"). One file, <data>/team-icon,
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
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

/** Refusals of an upload, in the uploader's language. */
export const TEXT: Record<TeamIconProblem, T> = {
  type: t('PNG, JPEG, WebP 이미지만 올릴 수 있어요.', 'Only PNG, JPEG or WebP images can be used.', 'Hanya gambar PNG, JPEG, atau WebP yang bisa dipakai.', "PNG、JPEG、WebP画像のみ使用できます。", "Solo se pueden usar imágenes PNG, JPEG o WebP."),
  mismatch: t('파일 내용이 PNG, JPEG, WebP 이미지가 아니에요. 이미지 파일을 다시 골라 주세요.', 'The file is not really a PNG, JPEG or WebP image. Choose the image file again.', 'Isi berkas bukan gambar PNG, JPEG, atau WebP. Pilih lagi berkas gambarnya.', "実際のファイル形式がPNG、JPEG、WebPではありません。画像ファイルを選び直してください。", "El archivo no es realmente una imagen PNG, JPEG o WebP. Vuelva a elegir el archivo."),
  too_big: t(`이미지는 ${TEAM_ICON_MAX_BYTES / 1024 / 1024}MB까지 올릴 수 있어요.`, `The image can be at most ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`, `Gambar paling besar ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`, `画像は最大${TEAM_ICON_MAX_BYTES / 1024 / 1024} MBです。`, `La imagen puede ocupar como máximo ${TEAM_ICON_MAX_BYTES / 1024 / 1024} MB.`),
  too_small: t(`가로와 세로가 ${TEAM_ICON_MIN_PX}px 이상인 이미지를 올려 주세요.`, `Use an image at least ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} pixels.`, `Pakai gambar minimal ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} piksel.`, `${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX}ピクセル以上の画像を使ってください。`, `Use una imagen de al menos ${TEAM_ICON_MIN_PX} × ${TEAM_ICON_MIN_PX} píxeles.`),
  too_large: t(`가로와 세로가 ${TEAM_ICON_MAX_PX}px 이하인 이미지를 올려 주세요.`, `Use an image at most ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} pixels.`, `Pakai gambar paling besar ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} piksel.`, `${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX}ピクセル以下の画像を使ってください。`, `Use una imagen de como máximo ${TEAM_ICON_MAX_PX} × ${TEAM_ICON_MAX_PX} píxeles.`),
}
const refuse = (problem: TeamIconProblem, locale: Locale): never =>
  fail(problem === 'too_big' ? 'payload_too_large' : 'validation', TEXT[problem][locale] ?? TEXT[problem].en, {
    params: { reason: problem },
    ...(problem === 'too_big' ? {} : { fields: { [problem === 'type' ? 'query.type' : 'body']: problem } }),
  })

/**
 * Realtime notice: the team logo changed. Open windows ask GET /api/me again and point their icon links at the new
 * version (or back at the default). The message carries nothing.
 */
export const TEAM_ICON_CHANGED = { type: 'notice', data: { level: 'info', code: 'team_icon_changed', message: '' } } as const

/** The one file (never a path from a request). Not inside the team folder: people and the AI cannot reach it. */
export const teamIconFile = (dataDir: string) => path.join(dataDir, 'team-icon')

const versionOf = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)

// read on every page load, favicon and manifest request: kept in memory while the file's stat stays the same
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

export const teamIconVersion = (dataDir: string): string | null => readTeamIcon(dataDir)?.version ?? null

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

/** Remove the logo (the default icon again). False when there was none. */
export function removeTeamIcon(dataDir: string): boolean {
  cache.delete(dataDir)
  try {
    fs.rmSync(teamIconFile(dataDir))
    return true
  } catch {
    return false
  }
}
