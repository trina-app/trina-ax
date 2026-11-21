// A Word page in the preview fits the panel's width (src/lib/docxFit.ts): scaled down, never up.
import { describe, expect, test } from 'bun:test'
import { docxFitZoom, docxPageWidth } from '../../src/lib/docxFit'

describe('docx preview fit', () => {
  test('a page wider than the panel is scaled down to its width (1440 panel and a phone)', () => {
    // an A4 page (794 px) with the wrapper's 12 px padding on each side
    expect(docxFitZoom(660, 818)).toBeCloseTo(660 / 818, 6)
    expect(docxFitZoom(390, 818)).toBeCloseTo(390 / 818, 6)
    expect(818 * docxFitZoom(390, 818)).toBeCloseTo(390, 6)
  })
  test('a page that fits, or a width not known yet, stays at 1 (never scaled up)', () => {
    expect(docxFitZoom(960, 818)).toBe(1)
    expect(docxFitZoom(818, 818)).toBe(1)
    expect(docxFitZoom(0, 818)).toBe(1)
    expect(docxFitZoom(660, 0)).toBe(1)
    expect(docxFitZoom(Number.NaN, 818)).toBe(1)
  })
  test('the widest page with the wrapper padding, measured with the zoom cleared', () => {
    const style = new Map<string, string>([['zoom', '0.5']])
    const section = (w: number) => ({ tagName: 'SECTION', offsetWidth: w })
    const wrapper = {
      style: { removeProperty: (k: string) => style.delete(k) },
      children: [section(794), { tagName: 'STYLE', offsetWidth: 5000 }, section(1123)],
    } as unknown as HTMLElement
    const was = globalThis.getComputedStyle
    globalThis.getComputedStyle = (() => ({ paddingLeft: '12px', paddingRight: '12px' })) as unknown as typeof getComputedStyle
    try {
      expect(docxPageWidth(wrapper)).toBe(1123 + 24)
      expect(style.has('zoom')).toBe(false)
      expect(docxPageWidth({ style: { removeProperty: () => {} }, children: [] } as unknown as HTMLElement)).toBe(0)
    } finally { globalThis.getComputedStyle = was }
  })
})
