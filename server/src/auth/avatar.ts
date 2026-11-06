// The check of a profile photo upload and the cutting-out of its metadata (docs/DECISIONS.md "프로필과 사람 목록").
// Pure functions, no image library: the photo is stored as sent except that every metadata block (camera EXIF with the
// place a picture was taken, XMP, comments, colour profiles, text chunks) is cut out of the container
// (uploads/metadata.ts, shared with photos sent in rooms). The web app
// already scales and crops the photo in a canvas; the server repeats the rules because it cannot trust the client.
import { AVATAR_MAX_BYTES, AVATAR_MAX_PX, AVATAR_MIN_PX, imageInfo, isTeamIconType, type TeamIconType } from '@mycel/shared'
import { cleanImage, STRICT } from '../uploads/metadata'

export type AvatarProblem = 'type' | 'mismatch' | 'too_big' | 'not_square' | 'too_small' | 'too_large' | 'broken' | 'animated'

export type AvatarResult = { ok: true; bytes: Uint8Array<ArrayBuffer>; type: TeamIconType; width: number } | { ok: false; problem: AvatarProblem }

/**
 * Check an upload and return the bytes to store. `declared` is the type the uploader names. Refused: a type other than
 * PNG / JPEG / WebP (SVG included), first bytes that are not that type, more than 256 KiB, a picture that is not a
 * square of 64–512 pixels, an animation, a file that does not parse.
 */
export function prepareAvatar(input: Uint8Array, declared: string): AvatarResult {
  const type = declared.split(';')[0]!.trim().toLowerCase()
  if (!isTeamIconType(type)) return { ok: false, problem: 'type' }
  if (input.byteLength > AVATAR_MAX_BYTES) return { ok: false, problem: 'too_big' }
  const info = imageInfo(input)
  if (!info || info.type !== type) return { ok: false, problem: 'mismatch' }
  if (info.width !== info.height) return { ok: false, problem: 'not_square' }
  if (info.width < AVATAR_MIN_PX) return { ok: false, problem: 'too_small' }
  if (info.width > AVATAR_MAX_PX) return { ok: false, problem: 'too_large' }
  // the strictest cleaning (uploads/metadata.ts): colour profiles go too, and an animation is refused
  const cleaned = cleanImage(input, STRICT)
  if (cleaned === 'animated') return { ok: false, problem: 'animated' }
  if (!cleaned) return { ok: false, problem: 'broken' }
  // the cleaned file must still read as the same picture
  const again = imageInfo(cleaned)
  if (!again || again.type !== type || again.width !== info.width || again.height !== info.height) return { ok: false, problem: 'broken' }
  return { ok: true, bytes: new Uint8Array(cleaned), type, width: info.width }
}
