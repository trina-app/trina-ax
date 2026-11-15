// A Word list bullet is a private-use character of the Symbol or Wingdings font (U+F0B7, U+F0A7 ...). docx-preview writes
// it into its numbering style as it is; where those fonts are not installed (macOS, Linux, phones) the browser draws an
// empty box in place of the bullet. This turns the common ones into real Unicode bullets and drops the symbol font.
const MAP: Record<string, string> = {
  '\uF0B7': '•', '\uF0A7': '▪', '\uF0D8': '➢', '\uF0FC': '✓', '\uF076': '❖', '\uF0A8': '◻', '\uF06E': '■', '\uF0B2': '□',
}
const SYMBOL_FONT = /\s*font-family:\s*(?:"?(?:Symbol|Wingdings(?: \d)?|Webdings)"?)(?:\s*,[^;}]*)?\s*;?/gi

export function fixSymbolBullets(css: string): string {
  return css.replace(/[^{}]*:before\s*\{[^}]*\}/g, (rule) => {
    if (!/[\uF000-\uF0FF]/.test(rule)) return rule
    return rule.replace(/[\uF000-\uF0FF]/g, (ch) => MAP[ch] ?? '•').replace(SYMBOL_FONT, '')
  })
}

/** docx-preview's <style> elements inside `root`, rewritten in place */
export function fixRenderedBullets(root: HTMLElement): void {
  for (const s of Array.from(root.querySelectorAll('style'))) {
    const t = s.textContent ?? ''
    if (/[\uF000-\uF0FF]/.test(t)) s.textContent = fixSymbolBullets(t)
  }
}
