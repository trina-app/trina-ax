// Name rules for every path segment the tools accept (design tab 2, rule 6). Applied on all platforms so a
// team folder can move between macOS / Linux / Windows servers without becoming unsafe.
import { PRODUCT } from '@mycel/shared'

// control chars, DEL, C1 controls
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// bidi overrides/isolates/marks, zero-width chars, BOM, soft hyphen, word joiner, interlinear annotations,
// Hangul fillers and other default-ignorables that render as nothing
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]|[\u{e0000}-\u{e0fff}]/u
// look-alike path separators: fullwidth solidus/reverse solidus, division slash, fraction slash, big solidus, etc.
const FAKE_SEPARATORS = /[／＼∕⁄⧸⧹∖﹨╱╲〳〵]/
// characters Windows cannot store (':' also covers NTFS alternate data streams)
const WINDOWS_ILLEGAL = /[<>:"|?*\\/]/
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 (+ superscript digits) with or without extension
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i
// 8.3 short names (PROGRA~1, REPORT~2.DOC) alias a different long name on Windows
const SHORT_83 = /~\d+(\.[^.]{0,3})?$/

export const MAX_SEGMENT_BYTES = 255
export const MAX_PATH_CHARS = 1024
export const MAX_DEPTH = 64

/** Returns a reason string if `name` is not allowed as a path segment, else null. */
export function badSegment(name: string): string | null {
  if (name.length === 0) return 'empty name'
  if (name === '.' || name === '..') return `'${name}' is not allowed`
  if (Buffer.byteLength(name, 'utf8') > MAX_SEGMENT_BYTES) return 'name too long'
  if (CONTROL.test(name)) return 'control characters are not allowed in names'
  if (INVISIBLE.test(name)) return 'invisible or direction-changing characters are not allowed in names'
  if (FAKE_SEPARATORS.test(name)) return 'look-alike slash characters are not allowed in names'
  if (WINDOWS_ILLEGAL.test(name)) return 'characters < > : " | ? * \\ are not allowed in names'
  if (/[. ]$/.test(name)) return 'names cannot end with a dot or a space'
  if (/^\s/.test(name)) return 'names cannot start with a space'
  if (WINDOWS_RESERVED.test(name)) return `'${name}' is a reserved device name`
  if (SHORT_83.test(name)) return 'names like ABCDEF~1 (Windows short names) are not allowed'
  if (name.startsWith(PRODUCT.tmpPrefix)) return 'reserved name'
  if (name.normalize('NFKC') !== name.normalize('NFC') && /[！-～]/.test(name) && /^[！-～]+$/.test(name)) {
    // fully fullwidth ASCII names (ｆｉｎａｎｃｅ) are look-alikes of real folders
    return 'fullwidth look-alike names are not allowed'
  }
  return null
}

/** Key used to detect siblings that differ only by case / Unicode normalization / width. */
export const foldKey = (name: string) => name.normalize('NFKC').toLowerCase().normalize('NFKC')

/** Names the tools never show and never accept (server temp files, the reserved system folder at root). */
export function hiddenEntry(name: string, depth: number): boolean {
  return name.startsWith(PRODUCT.tmpPrefix) || (depth === 0 && name === PRODUCT.systemDir)
}
