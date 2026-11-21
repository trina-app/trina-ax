// A Word preview on a narrow panel (components/viewers/OfficeView.tsx DocxView): docx-preview draws each page at its
// own width (an A4 page is about 794 px), so on a 390 px phone the right side was cut off (QA 2026-11-22 F14). The drawn
// pages are scaled down to the panel's width, never up.

/** The scale that fits a page `page` px wide into a box `box` px wide: box / page, never above 1 (nothing known: 1). */
export function fitScale(page: number, box: number): number {
  if (!(page > 0) || !(box > 0)) return 1
  return Math.min(1, box / page)
}

/**
 * Fit docx-preview's drawn pages (`.docx-wrapper` in `host`) to the host's width: `transform: scale` from the top left
 * (CSS `zoom` shifts pointer and selection coordinates in some engines), the host's height set to the scaled height so
 * nothing below jumps or leaves a gap. Again whenever the host's width or the pages' height changes (a picture or a font
 * that loads late); the returned function stops that.
 */
export function fitDocxPages(host: HTMLElement): () => void {
  const apply = () => {
    const wrapper = host.querySelector<HTMLElement>('.docx-wrapper')
    const page = wrapper?.querySelector<HTMLElement>('section')
    if (!wrapper || !page) return
    const width = host.clientWidth
    const style = getComputedStyle(wrapper)
    const full = page.offsetWidth + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    const s = fitScale(full, width)
    if (s < 1) {
      wrapper.style.width = `${full}px`
      wrapper.style.transformOrigin = 'top left'
      wrapper.style.transform = `scale(${s})`
      host.style.height = `${Math.ceil(wrapper.offsetHeight * s)}px`
      host.style.overflow = 'hidden'
    } else {
      wrapper.style.width = ''
      wrapper.style.transform = ''
      wrapper.style.transformOrigin = ''
      host.style.height = ''
      host.style.overflow = ''
    }
    host.dataset.fitScale = String(Math.round(s * 1000) / 1000)
  }
  apply()
  if (typeof ResizeObserver === 'undefined') return () => {}
  const ro = new ResizeObserver(apply)
  ro.observe(host)
  const wrapper = host.querySelector('.docx-wrapper')
  if (wrapper) ro.observe(wrapper)
  return () => ro.disconnect()
}
