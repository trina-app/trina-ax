// Test helpers for make_file's .hwpx: template files built here (no third-party documents in the repo) and a reader
// of a written file's parts.
import * as XLSX from 'xlsx'
import { defaultHeaderXml, defaultSecPrXml, NS_ATTRS, XML_DECL } from '../../server/src/files/hwpx-template'
import { writeZip } from '../../server/src/files/zip-write'

export const enc = (s: string) => new TextEncoder().encode(s)

/** the parts of a .hwpx (SheetJS reads zips too), as text */
export function hwpxParts(bytes: Uint8Array): Map<string, string> {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const out = new Map<string, string>()
  c.FullPaths.forEach((p: string, i: number) => {
    const content = c.FileIndex[i]?.content
    if (content && content.length) out.set(p.replace(/^Root Entry\//, ''), Buffer.from(content as Uint8Array).toString('utf8'))
  })
  return out
}

/** a template .hwpx: the built-in header (or `head`), a section with page setup `secPr` and a text of its own */
export function hwpxTemplate(o: { head?: string; secPr?: string; extra?: Record<string, Uint8Array | string>; mimetype?: string | null; text?: string } = {}): Uint8Array {
  const sec = XML_DECL + `<hs:sec ${NS_ATTRS}><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${o.secPr ?? defaultSecPrXml()}` +
    `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t>${o.text ?? '템플릿 안내 문구'}</hp:t></hp:run></hp:p></hs:sec>`
  const files: { name: string; data: Uint8Array; store?: boolean }[] = []
  if (o.mimetype !== null) files.push({ name: 'mimetype', data: enc(o.mimetype ?? 'application/hwp+zip'), store: true })
  files.push({ name: 'Contents/header.xml', data: enc(o.head ?? defaultHeaderXml()) }, { name: 'Contents/section0.xml', data: enc(sec) })
  for (const [n, v] of Object.entries(o.extra ?? {})) files.push({ name: n, data: typeof v === 'string' ? enc(v) : v })
  return writeZip(files)
}
