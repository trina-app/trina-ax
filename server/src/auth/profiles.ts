// Profiles and the people directory (docs/DECISIONS.md "프로필과 사람 목록"): the one-line title and status and the
// photo of each person, in user_profiles (migration 115). A row exists only for people who set something.
import type { Database } from 'bun:sqlite'
import { AVATAR_MAX_BYTES, AVATAR_MAX_PX, AVATAR_MIN_PX } from '@mycel/shared'
import type { Locale, Person } from '@mycel/shared/api'
import { fail, HttpError } from '../http/errors'
import { prepareAvatar, type AvatarProblem } from './avatar'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })
const KB = AVATAR_MAX_BYTES / 1024

/** Refusals of a photo, in the uploader's language. */
export const AVATAR_TEXT: Record<AvatarProblem, T> = {
  type: t('PNG, JPEG, WebP 사진만 올릴 수 있어요.', 'Only PNG, JPEG or WebP photos can be used.', 'Hanya foto PNG, JPEG, atau WebP yang bisa dipakai.', 'PNG、JPEG、WebPの写真のみ使用できます。', 'Solo se pueden usar fotos PNG, JPEG o WebP.'),
  mismatch: t('파일 내용이 PNG, JPEG, WebP 사진이 아니에요. 다른 사진을 골라 주세요.', 'The file is not really a PNG, JPEG or WebP photo. Choose another photo.', 'Isi berkas bukan foto PNG, JPEG, atau WebP. Pilih foto lain.', '実際のファイル形式がPNG、JPEG、WebPではありません。別の写真を選んでください。', 'El archivo no es realmente una foto PNG, JPEG o WebP. Elija otra foto.'),
  too_big: t(`사진은 ${KB}KB까지 올릴 수 있어요.`, `The photo can be at most ${KB} KB.`, `Foto paling besar ${KB} KB.`, `写真は最大${KB} KBです。`, `La foto puede ocupar como máximo ${KB} KB.`),
  not_square: t('사진은 정사각형이어야 해요. 화면에서 고르면 알아서 잘라 드려요.', 'The photo must be square. Choosing it in the app crops it for you.', 'Foto harus persegi. Memilihnya di aplikasi akan memotongnya otomatis.', '写真は正方形である必要があります。アプリで選ぶと自動で切り抜きます。', 'La foto debe ser cuadrada. Al elegirla en la app se recorta sola.'),
  too_small: t(`가로와 세로가 ${AVATAR_MIN_PX}px 이상인 사진을 올려 주세요.`, `Use a photo at least ${AVATAR_MIN_PX} × ${AVATAR_MIN_PX} pixels.`, `Pakai foto minimal ${AVATAR_MIN_PX} × ${AVATAR_MIN_PX} piksel.`, `${AVATAR_MIN_PX} × ${AVATAR_MIN_PX}ピクセル以上の写真を使ってください。`, `Use una foto de al menos ${AVATAR_MIN_PX} × ${AVATAR_MIN_PX} píxeles.`),
  too_large: t(`가로와 세로가 ${AVATAR_MAX_PX}px 이하인 사진을 올려 주세요.`, `Use a photo at most ${AVATAR_MAX_PX} × ${AVATAR_MAX_PX} pixels.`, `Pakai foto paling besar ${AVATAR_MAX_PX} × ${AVATAR_MAX_PX} piksel.`, `${AVATAR_MAX_PX} × ${AVATAR_MAX_PX}ピクセル以下の写真を使ってください。`, `Use una foto de como máximo ${AVATAR_MAX_PX} × ${AVATAR_MAX_PX} píxeles.`),
  broken: t('사진 파일이 손상된 것 같아요. 다른 사진을 골라 주세요.', 'The photo file seems damaged. Choose another photo.', 'Berkas foto tampaknya rusak. Pilih foto lain.', '写真ファイルが破損しているようです。別の写真を選んでください。', 'El archivo de la foto parece dañado. Elija otra foto.'),
  animated: t('움직이는 사진은 쓸 수 없어요.', 'Animated photos cannot be used.', 'Foto bergerak tidak bisa dipakai.', '動く写真は使用できません。', 'No se pueden usar fotos animadas.'),
}
const refuse = (problem: AvatarProblem, locale: Locale): never =>
  fail(problem === 'too_big' ? 'payload_too_large' : 'validation', AVATAR_TEXT[problem][locale] ?? AVATAR_TEXT[problem].en, {
    params: { reason: problem },
    ...(problem === 'too_big' ? {} : { fields: { [problem === 'type' ? 'query.type' : 'body']: problem } }),
  })

/** Realtime notice: someone's profile or photo changed. Open windows ask GET /api/people again. The message carries nothing. */
export const PROFILE_CHANGED = { type: 'notice', data: { level: 'info', code: 'profile_changed', message: '' } } as const
/** The same to the person who changed it: their windows also read their own account again (GET /api/me). */
export const MY_PROFILE_CHANGED = { type: 'notice', data: { level: 'info', code: 'my_profile_changed', message: '' } } as const
/** publishEach builder: MY_PROFILE_CHANGED to `userId`, PROFILE_CHANGED to everyone else. */
export const profileChangedFor = (userId: string) => (to: string) => (to === userId ? MY_PROFILE_CHANGED : PROFILE_CHANGED)

interface ProfileRow { title: string; status_text: string; avatar_version: number | null }
const person = (id: string, name: string, p: ProfileRow | null): Person => ({
  id, name,
  ...(p?.title ? { title: p.title } : {}),
  ...(p?.status_text ? { status: p.status_text } : {}),
  ...(p?.avatar_version ? { avatarVersion: p.avatar_version } : {}),
})

/** Everyone who can sign in (not deactivated, not deleted), by name. Nothing else about them. */
export function listPeople(db: Database): Person[] {
  const rows = db.query(`SELECT u.id, u.name, p.title, p.status_text, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.deleted_at IS NULL AND u.status = 'active' ORDER BY lower(u.name), u.id`).all() as { id: string; name: string; title: string | null; status_text: string | null; avatar_version: number | null }[]
  return rows.map((r) => person(r.id, r.name, { title: r.title ?? '', status_text: r.status_text ?? '', avatar_version: r.avatar_version }))
}

/** One person's profile fields (the signed-in person's own, for /api/me). */
export function profileOf(db: Database, userId: string): { title?: string; status?: string; avatarVersion?: number } {
  const p = db.query('SELECT title, status_text, avatar_version FROM user_profiles WHERE user_id = ?').get(userId) as ProfileRow | null
  const { id: _id, name: _name, ...rest } = person(userId, '', p)
  return rest
}

/** Save the given fields; returns the old and new values of what changed (for the audit log), empty when nothing did. */
export function updateProfile(db: Database, userId: string, body: { name?: string; title?: string; status?: string }): Record<string, { from: string; to: string }> {
  const changes: Record<string, { from: string; to: string }> = {}
  db.transaction(() => {
    const u = db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as { name: string } | null
    if (!u) fail('unauthorized')
    const p = db.query('SELECT title, status_text FROM user_profiles WHERE user_id = ?').get(userId) as { title: string; status_text: string } | null
    if (body.name !== undefined && body.name !== u!.name) {
      db.query('UPDATE users SET name = ? WHERE id = ?').run(body.name, userId)
      changes.name = { from: u!.name, to: body.name }
    }
    const title = body.title !== undefined && body.title !== (p?.title ?? '') ? body.title : null
    const status = body.status !== undefined && body.status !== (p?.status_text ?? '') ? body.status : null
    if (title !== null) changes.title = { from: p?.title ?? '', to: title }
    if (status !== null) changes.status = { from: p?.status_text ?? '', to: status }
    if (title !== null || status !== null) {
      db.query(`INSERT INTO user_profiles (user_id, title, status_text) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, status_text = excluded.status_text`).run(userId, title ?? p?.title ?? '', status ?? p?.status_text ?? '')
    }
  })()
  return changes
}

/** Read the upload (bounded by the contract), check it, cut out its metadata and store it. Returns the new version. */
export async function saveAvatar(db: Database, userId: string, body: AsyncIterable<Uint8Array>, declared: string, locale: Locale): Promise<{ version: number; before: number | null; size: number }> {
  const parts: Uint8Array[] = []
  try {
    for await (const ch of body) parts.push(ch)
  } catch (e) {
    if (e instanceof HttpError && e.code === 'payload_too_large') refuse('too_big', locale)
    throw e
  }
  // the upload took a while: an account deleted meanwhile gets no photo back (admin/users.ts deleteUser removed it;
  // nothing below waits, so the check holds until the write)
  if (!db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(userId)) fail('unauthorized')
  const r = prepareAvatar(new Uint8Array(Buffer.concat(parts)), declared)
  if (!r.ok) return refuse(r.problem, locale)
  const prev = db.query('SELECT avatar_version FROM user_profiles WHERE user_id = ?').get(userId) as { avatar_version: number | null } | null
  const before = prev?.avatar_version ?? null
  // a clock that only grows: an address with ?v= is never reused for another photo, even within one millisecond
  const version = Math.max(Date.now(), (before ?? 0) + 1)
  db.query(`INSERT INTO user_profiles (user_id, avatar, avatar_type, avatar_version) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET avatar = excluded.avatar, avatar_type = excluded.avatar_type, avatar_version = excluded.avatar_version`).run(userId, r.bytes, r.type, version)
  return { version, before, size: r.bytes.byteLength }
}

/** Remove the photo. The old version when there was one, else null. */
export function removeAvatar(db: Database, userId: string): number | null {
  const prev = db.query('SELECT avatar_version FROM user_profiles WHERE user_id = ?').get(userId) as { avatar_version: number | null } | null
  if (!prev?.avatar_version) return null
  db.query('UPDATE user_profiles SET avatar = NULL, avatar_type = NULL, avatar_version = NULL WHERE user_id = ?').run(userId)
  return prev.avatar_version
}

/** The photo of an active person, or null (unknown or deactivated person, no photo). */
export function readAvatar(db: Database, userId: string): { bytes: Uint8Array; type: string; version: number } | null {
  const r = db.query(`SELECT p.avatar, p.avatar_type, p.avatar_version FROM user_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND u.deleted_at IS NULL AND u.status = 'active' AND p.avatar IS NOT NULL`).get(userId) as { avatar: Uint8Array; avatar_type: string; avatar_version: number } | null
  return r ? { bytes: r.avatar, type: r.avatar_type, version: r.avatar_version } : null
}
