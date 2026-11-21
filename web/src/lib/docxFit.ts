// A Word page in the preview (components/viewers/OfficeView.tsx DocxView) fits the width it is shown in: docx-preview
// draws each page at its paper width (an A4 page is about 794 px), so in the side panel (1440: about 660 px; a phone:
// 390 px) it was cut off on the right. The page is scaled down to the width (never up), the way it already fits in the
// file viewer's wider reading column.

/** The scale for a page `page` px wide (with the wrapper's padding) shown in `width` px: 1 when it fits or when either
 * is not known yet (0 before the first layout), else width / page. */
export function docxFitZoom(width: number, page: number): number {
  if (!(width > 0) || !(page > 0) || page <= width) return 1
  return width / page
}

/** The widest page of a rendered preview, with the wrapper's own side padding, at scale 1 (`zoom` cleared first). */
export function docxPageWidth(wrapper: HTMLElement): number {
  wrapper.style.removeProperty('zoom')
  let widest = 0
  for (const s of Array.from(wrapper.children)) if (s.tagName === 'SECTION') widest = Math.max(widest, (s as HTMLElement).offsetWidth)
  if (!widest) return 0
  const cs = getComputedStyle(wrapper)
  return widest + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
}
