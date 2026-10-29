// Text previews decode legacy Korean CSV / text files (QA R2-FMT-08): the Korean Excel default (CP949) showed as
// broken characters because the preview always decoded UTF-8.
import { describe, expect, test } from 'bun:test'
import { decodePreviewText } from '../../src/lib/preview'

/** CP949 bytes of a text (from the decoder's own table; the runtime has no CP949 encoder). */
function cp949(text: string): Uint8Array {
  const table = new Map<string, number[]>()
  const dec = new TextDecoder('euc-kr')
  for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x41; b <= 0xfe; b++) {
    const ch = dec.decode(new Uint8Array([a, b]))
    if (ch.length === 1 && ch !== '\ufffd' && !table.has(ch)) table.set(ch, [a, b])
  }
  return new Uint8Array([...text].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : table.get(ch)!)))
}
// 샾 (0x98 0xDE) is a CP949-only syllable, outside EUC-KR's 2350; the other 14 syllables are KS X 1001 pairs
const TEXT = '회사,담당자,메모\n샾방각하 주식회사,QA-7070\n'
const CP949 = cp949(TEXT)
const latin1 = (t: string) => new Uint8Array([...t].map((ch) => ch.charCodeAt(0)))

describe('decodePreviewText', () => {
  test('CP949 bytes show as Korean', () => {
    expect(decodePreviewText(CP949)).toBe(TEXT)
  })
  test('UTF-8 with a BOM and plain UTF-8 stay as they are', () => {
    const utf8 = new TextEncoder().encode('회사,메모\n')
    expect(decodePreviewText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe('회사,메모\n')
    expect(decodePreviewText(utf8)).toBe('회사,메모\n')
  })
  test('a cut preview drops the half character at the end instead of falling back', () => {
    const utf8 = new TextEncoder().encode('가나다')
    expect(decodePreviewText(utf8.subarray(0, 7), true)).toBe('가나')
    const head = cp949('회사,담당자,메모\n가나')
    expect(decodePreviewText(head.subarray(0, head.length - 1), true)).toBe('회사,담당자,메모\n가')
  })
  test('bytes that are neither stay UTF-8 with replacement characters', () => {
    expect(decodePreviewText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('caf�')
  })
  test('Windows-1252 German / French bytes are not taken as Korean (no Hangul or Hanja guess)', () => {
    for (const t of ['Gr\xfc\xdfe \xc4\xd6', 'Stra\xdfe,M\xfcller,\xc4rger\n', 'Caf\xe9 cr\xe8me br\xfbl\xe9e\n']) {
      const text = decodePreviewText(latin1(t))
      expect(text).not.toMatch(/[\uac00-\ud7a3\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/)
      expect(text).toContain('\ufffd')
    }
  })
  test('one Hangul syllable, or Hanja in the text, is not enough', () => {
    // "A가" and "회사 會社" in CP949
    expect(decodePreviewText(new Uint8Array([0x41, 0xb0, 0xa1]))).toBe('A\ufffd\ufffd')
    expect(decodePreviewText(new Uint8Array([0xc8, 0xb8, 0xbb, 0xe7, 0x20, 0xfc, 0xe5, 0xde, 0xe4]))).toContain('\ufffd')
  })
  test("Windows-1252 smart quotes and dashes in English text are not taken as Korean ('don’t' is not 'don뭪')", () => {
    expect(decodePreviewText(latin1("We don\x92t know if it\x92s ready.\r\n"))).toBe('We don\ufffdt know if it\ufffds ready.\r\n')
    expect(decodePreviewText(latin1('Name,Note\r\nAnn,don\x92t ship\r\nBob,it\x92s ok'))).toBe('Name,Note\r\nAnn,don\ufffdt ship\r\nBob,it\ufffds ok')
    expect(decodePreviewText(latin1('Wait\x97now we go\x96there'), true)).not.toMatch(/[\uac00-\ud7a3]/)
  })
  test('known limit: an extension syllable with lead 0x81-0xA0 and an ASCII trail (똠 = 0x8C 0x63) is refused', () => {
    expect(decodePreviewText(cp949('똠방각하 주식회사 회의록'))).toContain('\ufffd')
  })
})
