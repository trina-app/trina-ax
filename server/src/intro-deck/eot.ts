// Fonts embedded in the intro deck's PowerPoint file (docs/DECISIONS.md "D2", the owner's decision 1): PowerPoint keeps
// an embedded font as ppt/fonts/*.fntdata, an Embedded OpenType file: the EOT header (version 0x00020001, the W3C
// submission's layout, little-endian) and the whole TrueType font after it, uncompressed and not obfuscated
// (MS-OE376). The whole font goes in, every character, so the person who gets the file can edit the text. Pretendard's
// licence (OFL-1.1) allows embedding in documents, and its fsType is 0 (installable).

interface Table { offset: number; length: number }

function tables(f: Uint8Array): Map<string, Table> {
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength)
  const n = dv.getUint16(4)
  const out = new Map<string, Table>()
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16
    out.set(String.fromCharCode(f[at]!, f[at + 1]!, f[at + 2]!, f[at + 3]!), { offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) })
  }
  return out
}

/** A name record (Windows, Unicode BMP, English US first) as text. */
function nameOf(f: Uint8Array, t: Table, id: number): string {
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength)
  const count = dv.getUint16(t.offset + 2), strings = t.offset + dv.getUint16(t.offset + 4)
  let best: { off: number; len: number; score: number } | null = null
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + i * 12
    const platform = dv.getUint16(r), enc = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), nid = dv.getUint16(r + 6)
    if (nid !== id || platform !== 3 || (enc !== 1 && enc !== 10)) continue
    const score = lang === 0x409 ? 2 : 1
    if (!best || score > best.score) best = { off: strings + dv.getUint16(r + 10), len: dv.getUint16(r + 8), score }
  }
  if (!best) return ''
  let s = ''
  for (let i = 0; i + 1 < best.len; i += 2) s += String.fromCharCode(dv.getUint16(best.off + i))
  return s
}

export interface FontNames { family: string; style: string; version: string; full: string }

export function fontNames(ttf: Uint8Array): FontNames {
  const t = tables(ttf).get('name')
  if (!t) throw new Error('font without a name table')
  return { family: nameOf(ttf, t, 1), style: nameOf(ttf, t, 2), version: nameOf(ttf, t, 5), full: nameOf(ttf, t, 4) }
}

/** The PANOSE of a TrueType font (OS/2), as PowerPoint writes it on <p:font panose="…">. */
export function panoseHex(ttf: Uint8Array): string {
  const os2 = tables(ttf).get('OS/2')
  if (!os2) return '00000000000000000000'
  return [...ttf.subarray(os2.offset + 32, os2.offset + 42)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** The .fntdata of a TrueType font: its EOT header, then the font. */
export function eotOf(ttf: Uint8Array): Uint8Array {
  const tb = tables(ttf)
  const os2 = tb.get('OS/2'), head = tb.get('head')
  if (!os2 || !head) throw new Error('not a TrueType font with OS/2 and head tables')
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
  const names = fontNames(ttf)
  const utf16 = (s: string) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 255; b[i * 2 + 1] = s.charCodeAt(i) >> 8 } return b }
  const parts = [names.family, names.style, names.version, names.full].map(utf16)
  const headerLen = 82 + parts.reduce((n, p) => n + 2 + p.length, 0) + 2 * 3 + 2 + 2
  const total = headerLen + ttf.length
  const out = new Uint8Array(total)
  const o = new DataView(out.buffer)
  o.setUint32(0, total, true)
  o.setUint32(4, ttf.length, true)
  o.setUint32(8, 0x00020001, true)
  o.setUint32(12, 0, true)
  out.set(ttf.subarray(os2.offset + 32, os2.offset + 42), 16)
  out[26] = 1 // DEFAULT_CHARSET
  out[27] = dv.getUint16(os2.offset + 62) & 1 ? 1 : 0 // fsSelection: italic
  o.setUint32(28, dv.getUint16(os2.offset + 4), true) // usWeightClass
  o.setUint16(32, dv.getUint16(os2.offset + 8), true) // fsType
  o.setUint16(34, 0x504c, true)
  for (let i = 0; i < 4; i++) o.setUint32(36 + i * 4, dv.getUint32(os2.offset + 42 + i * 4), true)
  const os2Version = dv.getUint16(os2.offset)
  if (os2Version >= 1) for (let i = 0; i < 2; i++) o.setUint32(52 + i * 4, dv.getUint32(os2.offset + 78 + i * 4), true)
  o.setUint32(60, dv.getUint32(head.offset + 8), true) // checkSumAdjustment
  // reserved 1–4 and padding 1 stay zero
  let at = 80
  parts.forEach((p, i) => {
    if (i > 0) { o.setUint16(at, 0, true); at += 2 } // padding 2–4
    else { o.setUint16(at, 0, true); at += 2 } // padding 1
    o.setUint16(at, p.length, true); at += 2
    out.set(p, at); at += p.length
  })
  o.setUint16(at, 0, true); at += 2 // padding 5
  o.setUint16(at, 0, true); at += 2 // root string size (no root string)
  out.set(ttf, at)
  if (at + ttf.length !== total) throw new Error('EOT header length mismatch')
  return out
}
