// Detection of legacy Korean text (CP949, a superset of EUC-KR; the Korean Excel CSV default) in a file that is not
// valid UTF-8 (QA R2-FMT-08). The server (read, grep, the AI edit / write guard) and the web text preview use this one
// rule, so they agree on which files are Korean.
//
// Many Western files (Windows-1252 / Latin-1) also decode without error as CP949, but then give rare Hangul syllables
// and Hanja. Thus the rule is strict: a wrong "Korean" text is worse than visible replacement characters.

const HANGUL_SYLLABLE = /[가-힣]/u
// CJK ideographs (Hanja): extension A, the unified block and the compatibility block (CP949 maps bytes to all three)
const HANJA = /[㐀-䶿一-鿿豈-﫿]/u

/** Minimum number of Hangul syllables in the text. */
export const CP949_MIN_SYLLABLES = 2
/** Minimum share of Hangul syllables in the non-ASCII characters. */
export const CP949_MIN_SHARE = 0.8

/** True when the bytes are valid UTF-8 (a BOM is allowed). */
export function isUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

/**
 * The text of bytes in CP949, or null when the bytes are not clearly Korean. Clearly Korean: the decode has no error,
 * the text has at least 2 Hangul syllables, Hangul syllables are at least 80% of the non-ASCII characters, and the text
 * has no Hanja. Call this only for bytes that are not valid UTF-8.
 */
export function cp949Text(bytes: Uint8Array): string | null {
  let text: string
  try { text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes) } catch { return null }
  let syllables = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) continue
    nonAscii++
    if (HANGUL_SYLLABLE.test(ch)) syllables++
    else if (HANJA.test(ch)) return null
  }
  if (syllables < CP949_MIN_SYLLABLES || syllables < nonAscii * CP949_MIN_SHARE) return null
  return text
}

/** True when the bytes are not valid UTF-8 and are clearly Korean CP949 (see `cp949Text`). */
export const isLegacyKorean = (bytes: Uint8Array): boolean => !isUtf8(bytes) && cp949Text(bytes) !== null
