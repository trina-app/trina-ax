// Direct tests for the CP949 detection in shared/src/text-encoding.ts (QA R2-FMT-08, issue #466).
// The bytes are hex arrays with the text they stand for, so the cases do not depend on an encoder.
// A wrong "Korean" result is worse than replacement characters, so most of these cases are about refusal.
import { describe, expect, test } from 'bun:test'
import { cp949Text, isLegacyKorean, isUtf8 } from '@mycel/shared/text-encoding'

const bytes = (...values: number[]) => new Uint8Array(values)
/** `times` copies of one CP949 byte pair (one Hangul syllable each). */
const repeated = (pair: number[], times: number) => {
  const values: number[] = []
  for (let i = 0; i < times; i++) values.push(...pair)
  return new Uint8Array(values)
}

describe('isUtf8', () => {
  test('accepts ASCII, UTF-8 Hangul and a UTF-8 BOM', () => {
    expect(isUtf8(bytes(0x68, 0x69))).toBe(true) // hi
    expect(isUtf8(bytes(0xed, 0x95, 0x9c, 0xea, 0xb8, 0x80))).toBe(true) // 한글 in UTF-8
    expect(isUtf8(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69))).toBe(true) // BOM + hi
  })

  test('rejects CP949 and invalid bytes', () => {
    expect(isUtf8(bytes(0xc7, 0xd1, 0xb1, 0xdb))).toBe(false) // 한글 in CP949
    expect(isUtf8(bytes(0xff, 0xff))).toBe(false)
  })
})

describe('cp949Text', () => {
  test('decodes a file of two KS X 1001 syllables', () => {
    // C7 D1 = 한, B1 DB = 글
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1, 0xdb))).toBe('한글')
  })

  test('refuses a Windows-1252 text with a curly apostrophe', () => {
    // don’t: CP949 decodes 92 74 as a rare extension syllable, so the pair itself must be refused
    expect(cp949Text(bytes(0x64, 0x6f, 0x6e, 0x92, 0x74))).toBeNull()
    // 한 × 9 + 92 74: 9/10 KS pairs and 100% Hangul, so only the lead 0x92 / ASCII trail rule can reject this
    expect(cp949Text(bytes(...repeated([0xc7, 0xd1], 9), 0x92, 0x74))).toBeNull()
  })

  test('refuses Korean text that also holds one Hanja', () => {
    // 한글漢: F9 D3 = 漢
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1, 0xdb, 0xf9, 0xd3))).toBeNull()
    // 한 × 9 + F9 D3: 90% Hangul and 9/10 KS pairs, so only the Hanja rule can reject this
    expect(cp949Text(bytes(...repeated([0xc7, 0xd1], 9), 0xf9, 0xd3))).toBeNull()
  })

  test('needs at least two Hangul syllables', () => {
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1, 0xdb))).not.toBeNull() // 한글
    expect(cp949Text(bytes(0xc7, 0xd1))).toBeNull() // 한
  })

  test('needs 80% of the non-ASCII characters to be Hangul', () => {
    // 한글한글※: 4 of 5 non-ASCII characters are Hangul, exactly the boundary (A1 D8 = ※)
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1, 0xdb, 0xc7, 0xd1, 0xb1, 0xdb, 0xa1, 0xd8))).not.toBeNull()
    // 한글한※: 3 of 4 (75%) is not enough
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1, 0xdb, 0xc7, 0xd1, 0xa1, 0xd8))).toBeNull()
  })

  test('needs 90% of the Hangul syllables to be KS X 1001 pairs', () => {
    // 한 × 9 (C7 D1, KS X 1001) + A1 41 (a CP949 extension syllable): 9 of 10, exactly the boundary
    expect(cp949Text(bytes(...repeated([0xc7, 0xd1], 9), 0xa1, 0x41))).not.toBeNull()
    // 한 × 8 + two extension syllables: 8 of 10 (80%) is not enough
    expect(cp949Text(bytes(...repeated([0xc7, 0xd1], 8), 0xa1, 0x41, 0xa1, 0x42))).toBeNull()
  })

  test('returns null when the last lead byte has no trail byte', () => {
    // 한 + a dangling B1
    expect(cp949Text(bytes(0xc7, 0xd1, 0xb1))).toBeNull()
  })
})

describe('isLegacyKorean', () => {
  test('is true for CP949 Korean that is not valid UTF-8', () => {
    expect(isLegacyKorean(bytes(0xc7, 0xd1, 0xb1, 0xdb))).toBe(true) // 한글
  })

  test('is false for plain ASCII and valid UTF-8 Korean', () => {
    expect(isLegacyKorean(bytes(0x68, 0x69))).toBe(false) // hi
    expect(isLegacyKorean(bytes(0xed, 0x95, 0x9c, 0xea, 0xb8, 0x80))).toBe(false) // 한글 in UTF-8
  })

  test('is false for bytes the CP949 rule refuses', () => {
    expect(isLegacyKorean(bytes(0x64, 0x6f, 0x6e, 0x92, 0x74))).toBe(false) // don’t in Windows-1252
    expect(isLegacyKorean(bytes(0xc7, 0xd1, 0xb1, 0xdb, 0xf9, 0xd3))).toBe(false) // 한글漢
    expect(isLegacyKorean(bytes(0xc7, 0xd1, 0xb1))).toBe(false) // odd length
  })
})
