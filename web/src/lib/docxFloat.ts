// A floating picture placed from its line (a seal over a name, wp:positionV relativeFrom="line"): docx-preview draws it
// in a box of height 0 that sits on the text's baseline and forgets what the offset was measured from, so the picture
// came out about 4 mm too low (QA TC-8358). Such a box is lined up with the top of its line, where the offset starts.
// Other floating pictures (from the page, the paragraph) keep the place the renderer gives them.

const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

/** For each floating picture with no text wrap in the document's body, in order: is it placed from its line? */
export function lineFloats(xml: Document): boolean[] {
  return Array.from(xml.getElementsByTagNameNS(WP, 'anchor'))
    .filter((a) => a.getElementsByTagNameNS(WP, 'wrapNone').length > 0)
    .map((a) => a.getElementsByTagNameNS(WP, 'positionV')[0]?.getAttribute('relativeFrom') === 'line')
}

/** Lines up the boxes of the pictures placed from their line. The boxes are paired with the file's pictures by order,
 * so when the counts differ (a picture the renderer left out) nothing is moved. How many moved. */
export function alignLineFloats(boxes: readonly { style: { verticalAlign: string } }[], fromLine: readonly boolean[]): number {
  if (boxes.length !== fromLine.length) return 0
  let n = 0
  boxes.forEach((b, i) => {
    if (fromLine[i]) { b.style.verticalAlign = 'top'; n++ }
  })
  return n
}
