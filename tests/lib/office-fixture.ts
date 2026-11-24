// A minimal Word file for the Office safety check tests (files/office-exit.ts).
import { writeZip } from '../../server/src/files/zip-write'

const enc = new TextEncoder()
/** a minimal Word file; `link`: an external hyperlink target, `body`: the paragraph text */
export function docx(o: { link?: string; body?: string; extra?: string } = {}): Uint8Array {
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${o.link ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${o.link}" TargetMode="External"/>` : ''}</Relationships>`
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${o.body ?? 'Hello'}</w:t></w:r></w:p>${o.extra ?? ''}</w:body></w:document>`) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels) },
  ])
}
export const UNC = '\\\\files.example\\share\\logo.png'
