// A PDF make_file prints from an .html page (tools/make-file.ts fromHtml) or draws from a .pptx deck (fromDeck) can
// carry links the browser put in from the page's <a href>: the headless browser turns every anchor into a PDF link
// annotation with a URI action, whatever its scheme. So a page that links to file:///C:/...exe, \\host\share,
// javascript: or ms-msdt: would print to a PDF whose links open those when clicked (QA TC-4949). Before the PDF is
// saved, every action in it is read: a URI action to a web page or a mail address stays, and anything else — another
// scheme, a share, a relative path, or an action that launches a file, opens another document, runs JavaScript or
// submits a form — is turned into a link that does nothing. It runs in renderHtmlPdf, so every browser-printed PDF
// (make_file from .html or a deck, and the preview's "save as PDF") is covered. The Markdown PDF path (typst) does not
// go through it: its links are cleaned in pandoc's tree before typst runs (tools/office-links.ts).
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFStream, PDFString, type PDFObject } from 'pdf-lib'
import { allowedLinkTarget } from './office-rules'

/** action types that reach outside the document; a URI one may stay when its target is allowed, the rest never do */
const ACTION_TYPES = new Set(['URI', 'Launch', 'GoToR', 'GoToE', 'JavaScript', 'SubmitForm', 'ImportData', 'Movie', 'Sound', 'RichMediaExecute', 'Rendition', 'Trans', 'SetOCGState'])

const str = (o: PDFObject | undefined): string | undefined => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined)

/**
 * The PDF with every link that leaves it for something other than a web page or a mail address made inert. Returns the
 * bytes (unchanged when there was nothing to do) and how many links were neutralised. A PDF that cannot be parsed is
 * refused to the caller (throws), never passed through.
 */
export async function sanitizePdfLinks(pdf: Uint8Array): Promise<{ bytes: Uint8Array; removed: number }> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true })
  const ctx = doc.context
  const K = (k: string) => PDFName.of(k)
  let removed = 0
  const nameOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? o.decodeText() : undefined)
  // neutralise: drop everything but the action type, and make it a URI action with an empty target (a click does nothing)
  const neutralise = (d: PDFDict) => {
    for (const [k] of [...d.entries()]) d.delete(k)
    d.set(K('Type'), K('Action'))
    d.set(K('S'), K('URI'))
    d.set(K('URI'), PDFString.of(''))
    removed++
  }
  const considerAction = (d: PDFDict) => {
    // /S and /URI may be indirect objects: resolved, so a reference cannot hide the action type or target
    const s = nameOf(ctx.lookup(d.get(K('S'))))
    if (s === 'URI') {
      const uri = str(ctx.lookup(d.get(K('URI')))) ?? ''
      if (!allowedLinkTarget(uri) || uri.startsWith('#')) neutralise(d)
    } else if (s && ACTION_TYPES.has(s)) {
      neutralise(d)
    }
  }
  // every dict reachable in the file: each indirect object, and the direct dicts and arrays inside it (a ref is its own
  // indirect object, so following only direct children still reaches all of them). Action dicts hang off /A, /AA and
  // /Next, and /OpenAction on the catalog; reading every dict's /S covers them without having to know each place.
  const seen = new Set<PDFObject>()
  const walk = (o: PDFObject | undefined, depth: number) => {
    if (!o || depth > 60 || seen.has(o)) return
    seen.add(o)
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined
    if (d) {
      if (d.get(K('S')) !== undefined || d.get(K('URI')) !== undefined) considerAction(d)
      for (const [, v] of d.entries()) if (!(v instanceof PDFName)) walk(v, depth + 1)
      return
    }
    if (o instanceof PDFArray) for (const v of o.asArray()) walk(v, depth + 1)
  }
  for (const [, o] of ctx.enumerateIndirectObjects()) walk(o, 0)
  if (!removed) return { bytes: pdf, removed }
  return { bytes: await doc.save({ updateFieldAppearances: false }), removed }
}
