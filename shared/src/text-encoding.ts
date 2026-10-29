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
/**
 * Minimum share of the Hangul syllables that come from KS X 1001 byte pairs (EUC-KR's 2350 syllables: lead byte
 * 0xB0-0xC8, trail byte 0xA1-0xFE). The other syllables are CP949 (UHC) extension pairs. Windows-1252 punctuation
 * (0x80-0x9F) followed by an ASCII letter is also an extension pair, so a text with many of them is not Korean.
 */
export const CP949_MIN_KS_SHARE = 0.9

/** True when the bytes are valid UTF-8 (a BOM is allowed). */
export function isUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

/**
 * Counts of the CP949 byte pairs, or null when a pair has a lead byte 0x80-0xA0 and an ASCII trail byte. In
 * Windows-1252 such a lead byte is a smart quote, a dash, a bullet or a no-break space, and an ASCII letter after it is
 * normal ("don't" with 0x92). In CP949 the same pair is a rare extension syllable (for example 0x8C 0x63), so the rule
 * refuses it.
 */
function cp949Pairs(bytes: Uint8Array): { ksHangul: number } | null {
  let ksHangul = 0
  for (let i = 0; i < bytes.length; i++) {
    const lead = bytes[i]!
    if (lead < 0x80) continue
    const trail = bytes[i + 1]
    if (trail === undefined) return null
    i++
    if (lead <= 0xa0 && trail < 0x80) return null
    if (lead >= 0xb0 && lead <= 0xc8 && trail >= 0xa1 && trail <= 0xfe) ksHangul++
  }
  return { ksHangul }
}

/**
 * The text of bytes in CP949, or null when the bytes are not clearly Korean. Clearly Korean: the decode has no error,
 * no byte pair has a lead byte 0x80-0xA0 and an ASCII trail byte, the text has at least 2 Hangul syllables, Hangul
 * syllables are at least 80% of the non-ASCII characters, at least 90% of the Hangul syllables are KS X 1001 pairs, and
 * the text has no Hanja. Call this only for bytes that are not valid UTF-8.
 */
export function cp949Text(bytes: Uint8Array): string | null {
  let text: string
  try { text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes) } catch { return null }
  const pairs = cp949Pairs(bytes)
  if (!pairs) return null
  let syllables = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) continue
    nonAscii++
    if (HANGUL_SYLLABLE.test(ch)) syllables++
    else if (HANJA.test(ch)) return null
  }
  if (syllables < CP949_MIN_SYLLABLES || syllables < nonAscii * CP949_MIN_SHARE) return null
  if (pairs.ksHangul < syllables * CP949_MIN_KS_SHARE) return null
  return text
}

/** True when the bytes are not valid UTF-8 and are clearly Korean CP949 (see `cp949Text`). */
export const isLegacyKorean = (bytes: Uint8Array): boolean => !isUtf8(bytes) && cp949Text(bytes) !== null
