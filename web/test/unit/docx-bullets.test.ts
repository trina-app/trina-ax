// Word bullets in the preview: the Symbol/Wingdings private-use characters become real bullets (src/lib/docxBullets.ts).
import { describe, expect, test } from 'bun:test'
import { fixSymbolBullets } from '../../src/lib/docxBullets'

describe('docx preview bullets', () => {
  test('a Symbol bullet becomes a Unicode bullet and loses the symbol font', () => {
    const css = 'p.docx-num-1-0:before {\r\n  content: "\uF0B7\\9";\r\n  counter-increment: docx-num-1-0;\r\n  font-family: Symbol;\r\n}\r\np.docx-num-1-0 {\r\n  display: list-item;\r\n}'
    const out = fixSymbolBullets(css)
    expect(out).toContain('content: "•\\9"')
    expect(out).not.toMatch(/Symbol/)
    expect(out).toContain('p.docx-num-1-0 {\r\n  display: list-item;')
  })
  test('Wingdings squares, unknown private-use characters and plain rules', () => {
    expect(fixSymbolBullets('p.a:before { content: "\uF0A7"; font-family: Wingdings; }')).toBe('p.a:before { content: "▪"; }')
    expect(fixSymbolBullets('p.a:before { content: "\uF0EE"; font-family: "Wingdings 2"; }')).toBe('p.a:before { content: "•"; }')
    const plain = 'p.n:before { content: "1.\\9"; font-family: Calibri; }\np.o:before { content: "o\\9"; font-family: "Courier New"; }'
    expect(fixSymbolBullets(plain)).toBe(plain)
  })
})

describe('docx preview bullets: font lists', () => {
  test('a font list that starts with Symbol goes away whole', () => {
    expect(fixSymbolBullets('p.a:before { content: "\\9"; font-family: Symbol, serif; }')).not.toMatch(/serif|Symbol/)
  })
})
