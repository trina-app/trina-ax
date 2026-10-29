// Text previews decode legacy Korean CSV / text files (QA R2-FMT-08): the Korean Excel default (CP949) showed as
// broken characters because the preview always decoded UTF-8.
import { describe, expect, test } from 'bun:test'
import { decodePreviewText } from '../../src/lib/preview'

// "회사,메모\n똠방,QA-7070\n" in CP949 (똠 is a CP949-only syllable, outside EUC-KR's 2350)
const CP949 = new Uint8Array([0xc8, 0xb8, 0xbb, 0xe7, 0x2c, 0xb8, 0xde, 0xb8, 0xf0, 0x0a, 0x8c, 0x63, 0xb9, 0xe6, 0x2c, 0x51, 0x41, 0x2d, 0x37, 0x30, 0x37, 0x30, 0x0a])

describe('decodePreviewText', () => {
  test('CP949 bytes show as Korean', () => {
    expect(decodePreviewText(CP949)).toBe('회사,메모\n똠방,QA-7070\n')
  })
  test('UTF-8 with a BOM and plain UTF-8 stay as they are', () => {
    const utf8 = new TextEncoder().encode('회사,메모\n')
    expect(decodePreviewText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe('회사,메모\n')
    expect(decodePreviewText(utf8)).toBe('회사,메모\n')
  })
  test('a cut preview drops the half character at the end instead of falling back', () => {
    const utf8 = new TextEncoder().encode('가나다')
    expect(decodePreviewText(utf8.subarray(0, 7), true)).toBe('가나')
    expect(decodePreviewText(CP949.subarray(0, 11), true)).toBe('회사,메모\n')
  })
  test('bytes that are neither stay UTF-8 with replacement characters', () => {
    expect(decodePreviewText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('caf�')
  })
})
