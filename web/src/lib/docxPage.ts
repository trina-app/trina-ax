// A Word file with no page size or margins of its own (pandoc's default .docx, which make_file writes: its last w:sectPr
// has neither w:pgSz nor w:pgMar) was drawn by docx-preview as a page as narrow as its longest line, with the text on the
// page's edge and empty space beside it (QA TC-6942). Word itself opens such a file on its default page; the preview
// now does the same: a Letter page with 1 inch margins, only where the file says nothing. The same viewer shows a team
// file (Files) and a chat's file, so both read alike.

/** Word's page when a file gives none: US Letter, 1 inch margins (in CSS points, as docx-preview writes sizes) */
export const DOCX_DEFAULT_PAGE = { width: '612pt', minHeight: '792pt', margin: '72pt' } as const

/** Each page (a `section` right under the wrapper) with no width set gets the default page; one with no padding the
 * default margins. A page the file sized keeps its own. How many pages got a default. */
export function defaultDocxPages(wrapper: { children: ArrayLike<unknown> }): number {
  let n = 0
  for (const c of Array.from(wrapper.children) as { tagName?: string; style?: CSSStyleDeclaration }[]) {
    if (c.tagName !== 'SECTION' || !c.style) continue
    let changed = false
    if (!c.style.width) { c.style.width = DOCX_DEFAULT_PAGE.width; c.style.minHeight ||= DOCX_DEFAULT_PAGE.minHeight; changed = true }
    if (!c.style.paddingLeft && !c.style.paddingRight && !c.style.paddingTop && !c.style.paddingBottom) { c.style.padding = DOCX_DEFAULT_PAGE.margin; changed = true }
    if (changed) n++
  }
  return n
}
