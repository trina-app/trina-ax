// Tiny PDF writer (text lines, Helvetica) for fixtures — no Python/ReportLab needed.
export function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?')
  const stream = 'BT /F1 12 Tf 72 780 Td 16 TL\n' + lines.map((l) => `(${esc(l)}) Tj T*`).join('\n') + '\nET'
  return writePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ])
}

/**
 * Korean text in a CID font the file does not embed (HYGoThic-Medium, predefined CMap UniKS-UCS2-H), as ReportLab's
 * UnicodeCIDFont and many Korean form generators write it: a viewer can only draw it with the Adobe CMap files.
 * The page also fills a DeviceCMYK box (drawn through the CMYK colour profile when the viewer has one).
 */
export function makeCidPdf(lines: string[]): Uint8Array {
  const ucs2 = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  const stream = 'q 0.1 0.7 0 0 k 72 560 300 60 re f Q\n' + 'BT /F1 20 Tf 72 780 Td 28 TL\n' + lines.map((l) => `<${ucs2(l)}> Tj T*`).join('\n') + '\nET'
  return writePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [-6 -145 1003 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
  ])
}

export interface PdfImage {
  width: number
  height: number
  /** image dictionary entries besides size and length: filter, colour space, bits per component, decode parameters */
  dict: string
  bytes: Uint8Array
}

/** A scanned page: one image filling the top of an A4 page, no text. */
export function makeImagePdf(img: PdfImage): Uint8Array {
  const draw = `q 480 0 0 ${Math.round((480 * img.height) / img.width)} 57 500 cm /Im1 Do Q`
  return writePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.dict} /Length ${img.bytes.length} >>\nstream\n`, img.bytes, '\nendstream'],
  ])
}

/** One page of makePagesPdf: text lines (a text layer) or one image and no text (a scanned page). */
export type PdfPage = { lines: string[] } | { image: PdfImage }

/** A PDF with several A4 pages; `rotate` sets every page's /Rotate (a page shown turned clockwise). */
export function makePagesPdf(pages: PdfPage[], o: { rotate?: number } = {}): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?')
  const rotate = o.rotate ? ` /Rotate ${o.rotate}` : ''
  const objs: (string | (string | Uint8Array)[])[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: number[] = []
  for (const p of pages) {
    const n = objs.length + 1
    kids.push(n)
    if ('lines' in p) {
      const stream = 'BT /F1 12 Tf 72 780 Td 16 TL\n' + p.lines.map((l) => `(${esc(l)}) Tj T*`).join('\n') + '\nET'
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]${rotate} /Contents ${n + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    } else {
      const img = p.image
      const draw = `q 480 0 0 ${Math.round((480 * img.height) / img.width)} 57 500 cm /Im1 Do Q`
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]${rotate} /Contents ${n + 1} 0 R /Resources << /XObject << /Im1 ${n + 2} 0 R >> >> >>`)
      objs.push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)
      objs.push([`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.dict} /Length ${img.bytes.length} >>\nstream\n`, img.bytes, '\nendstream'])
    }
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  return writePdf(objs)
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** A fax-style scan (CCITT group 4, 1 bit: what office scanners and fax-to-PDF write): a frame with a bar inside. */
export const CCITT_SCAN: PdfImage = {
  width: 400,
  height: 120,
  dict: '/BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 400 /Rows 120 /BlackIs1 true >>',
  bytes: b64('JqBoC///////IaDYq///+eAzDN///////////////////////+Q0m6v///////////////////////////x///////////////////////+P///x//////gAgAg='),
}

/** A JPEG 2000 image (OpenJPEG, 48x24): a dark blue block on white. */
export const JPX_SCAN: PdfImage = {
  width: 48,
  height: 24,
  dict: '/Filter /JPXDecode',
  bytes: b64(
    'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAGAAAADAAAwcHAAAAAAAPY29scgEAAAAAABAAAACuanAyY/9P/1EALwAAAAAAMAAAABgAAAAAAAAAAAAAADAAAAAYAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAQEBAAB/1wAEEBASEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS4z/5AACgAAAAAAKgAB/5PYYBBIZdwgEEeka84MAeK6gICAgICAgICAgICA/9k=',
  ),
}

/** Objects 1..n (each a string, or string and byte parts) with a correct xref table. */
function writePdf(objs: (string | (string | Uint8Array)[])[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let size = 0
  const put = (p: string | Uint8Array) => {
    const b = typeof p === 'string' ? enc.encode(p) : p
    parts.push(b)
    size += b.length
  }
  put('%PDF-1.4\n')
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(size)
    put(`${i + 1} 0 obj\n`)
    for (const p of typeof o === 'string' ? [o] : o) put(p)
    put('\nendobj\n')
  })
  const xref = size
  put(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''))
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
