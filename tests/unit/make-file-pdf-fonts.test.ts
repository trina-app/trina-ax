// PDFs the AI makes (make_file, typst) draw Korean, Japanese and Chinese with real glyphs (0.2.15 QA B1: on a Linux server,
// which has only DejaVu fonts, they came out as empty boxes in Libertinus Serif, typst's own fallback).
// A Linux bundle brings Noto Sans CJK in app/<v>/fonts (config.ts bundledFontDir); typst gets it with --font-path and the
// converter isolation (bwrap / sandbox-exec) lets it read that folder. A Mac uses its system fonts.
//
// "Real glyphs" is checked in the PDF itself: typst maps every glyph it draws from a font to its text in the font's
// ToUnicode map; a character no font has is drawn as glyph 0 (.notdef, the box) and gets no entry there. pdftotext alone
// cannot tell (it still finds the text), so every character of the sample must be in some ToUnicode map, and pdffonts
// must not list Libertinus Serif.
//
// MYCEL_FONT_DIR set (the Linux container, tests/linux/Dockerfile): typst and pdffonts must be there, nothing is skipped.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { bundledFontDir, which } from '../../server/src/config'
import { findConverters, PDF_FONTS, pdfFonts, pdfLanguage, typstArgs, typstPreamble } from '../../server/src/tools/make-file'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)

/** each character here must be drawn with a glyph of its own */
const KO = '한국어 보고서: 매출이 늘었습니다. 굵은 글씨'
const JA = '日本語のテキスト、カタカナ。'
const ZH = '简体中文：这是测试。繁體中文：這是測試。'
const MD = `# 3분기 보고서 제목\n\n${KO} **굵은 글씨**.\n\n${JA}\n\n${ZH}\n\n| 항목 | 금액 |\n|---|---|\n| 광고비 | 1,234 |\n\nEnglish text 123.\n`

/** Every text the PDF's ToUnicode maps give a drawn glyph (bfchar and bfrange entries of each Flate stream). */
export function mappedText(pdf: Buffer): Set<string> {
  const out = new Set<string>()
  const utf16 = (hex: string) => Buffer.from(hex.length % 4 ? hex.padStart(Math.ceil(hex.length / 4) * 4, '0') : hex, 'hex').swap16().toString('utf16le')
  for (let at = pdf.indexOf('stream'); at >= 0; at = pdf.indexOf('stream', at + 6)) {
    if (pdf.subarray(at - 3, at).toString() === 'end') continue
    let start = at + 6
    if (pdf[start] === 0x0d) start++
    if (pdf[start] === 0x0a) start++
    const end = pdf.indexOf('endstream', start)
    if (end < 0) break
    let s: string
    try { s = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1') } catch { continue }
    if (!s.includes('begincmap')) continue
    for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) if (parseInt(m[1]!, 16) !== 0) out.add(utf16(m[2]!))
    for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
      for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(m[1]!, 16), hi = parseInt(m[2]!, 16), base = parseInt(m[3]!, 16)
        for (let c = Math.max(lo, 1); c <= hi && c - lo < 65_536; c++) out.add(String.fromCodePoint(base + c - lo))
      }
  }
  return out
}
/** the characters of `text` (no spaces) that no drawn glyph stands for */
export function unmapped(pdf: Buffer, text: string): string[] {
  const mapped = mappedText(pdf)
  const all = [...mapped].join('')
  return [...new Set([...text.replace(/\s/g, '')])].filter((ch) => !mapped.has(ch) && !all.includes(ch))
}

describe('typst command line', () => {
  test('the bundled fonts come first (--font-path), the system ones stay', () => {
    expect(typstArgs({ work: '/w', doc: 'doc.typ', fonts: '/app/v/fonts', jobs: 2 })).toEqual(['compile', '--jobs', '2', '--font-path', '/app/v/fonts', '--root', '/w', 'doc.typ', 'out.pdf'])
    expect(typstArgs({ work: '/w', doc: 'doc.typ', fonts: null, jobs: null })).toEqual(['compile', '--root', '/w', 'doc.typ', 'out.pdf'])
    expect(typstArgs({ work: '/w', doc: 'doc.typ' })).not.toContain('--ignore-system-fonts')
  })
  test('the font list names the bundled family before the Latin and fallback fonts', () => {
    expect(PDF_FONTS.indexOf('Noto Sans CJK KR')).toBeGreaterThanOrEqual(0)
    expect(PDF_FONTS.indexOf('Noto Sans CJK KR')).toBeLessThan(PDF_FONTS.indexOf('Helvetica Neue'))
    expect(PDF_FONTS.at(-1)).toBe('Libertinus Serif')
  })
  test('bundledFontDir: MYCEL_FONT_DIR as its real path, a missing folder is none', () => {
    const saved = process.env.MYCEL_FONT_DIR
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-fonts-'))
    try {
      process.env.MYCEL_FONT_DIR = d
      expect(bundledFontDir()).toBe(fs.realpathSync(d))
      expect(findConverters(null).fonts).toBe(fs.realpathSync(d))
      process.env.MYCEL_FONT_DIR = path.join(d, 'nope')
      expect(bundledFontDir()).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.MYCEL_FONT_DIR
      else process.env.MYCEL_FONT_DIR = saved
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
  test('the ToUnicode check tells a box from a glyph', () => {
    const cmap = '/CIDInit /ProcSet findresource begin begincmap 2 beginbfchar <0000> <D55C> <0001> <AD6D> endbfchar 1 beginbfrange <0002> <0003> <0041> endbfrange endcmap'
    const pdf = Buffer.concat([Buffer.from('1 0 obj << /Filter /FlateDecode >> stream\n'), zlib.deflateSync(cmap), Buffer.from('\nendstream endobj')])
    expect(unmapped(pdf, '한국AB')).toEqual(['한'])
  })
})

describe('the language of a PDF and its font order', () => {
  test('the writing decides: Hangul Korean, kana Japanese, Han alone Chinese (simplified or traditional)', () => {
    expect(pdfLanguage('# 3분기 보고서\n\n매출이 늘었어요.', 'en')).toBe('ko')
    expect(pdfLanguage('# 第3四半期の報告\n\n売上が増えました。カタカナも。', 'ko')).toBe('ja')
    // a Korean report naming a Japanese product, a Japanese one naming a Korean company: the main writing wins
    expect(pdfLanguage('신제품 「スマートウォッチ」 출시 계획과 일정, 예산을 정리했어요.', 'ko')).toBe('ko')
    expect(pdfLanguage('韓国の「삼성」との打ち合わせについて、議事録をまとめました。', 'ko')).toBe('ja')
    expect(pdfLanguage('这是我们的季度报告，销售额增长了。', 'ko')).toBe('zh-Hans')
    expect(pdfLanguage('這是我們的季度報告，銷售額增長了。', 'ko')).toBe('zh-Hant')
    // Han characters alone in a Japanese team: Japanese
    expect(pdfLanguage('第三四半期売上報告', 'ja')).toBe('ja')
  })
  test('no CJK: the team language when it is written in Latin letters, else English', () => {
    expect(pdfLanguage('Quarterly report: sales grew.', 'es')).toBe('es')
    expect(pdfLanguage('Quarterly report: sales grew.', 'id')).toBe('id')
    expect(pdfLanguage('Quarterly report: sales grew.', 'ko')).toBe('en')
    expect(pdfLanguage('Quarterly report: sales grew.', 'ja')).toBe('en')
  })
  test("a Japanese PDF lists the JP faces first and sets typst's lang to ja; Chinese gets its own faces and region", () => {
    const ja = pdfFonts('ja')
    expect(ja[0]).toBe('Hiragino Sans')
    expect(ja.indexOf('Noto Sans CJK JP')).toBeLessThan(ja.indexOf('Noto Sans CJK KR'))
    expect(ja.indexOf('Apple SD Gothic Neo')).toBeGreaterThan(ja.indexOf('Noto Sans CJK JP'))
    expect(typstPreamble('ja')).toContain('#set text(font: ("Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP"')
    expect(typstPreamble('ja')).toContain('lang: "ja")')
    expect(pdfFonts('zh-Hant').indexOf('Noto Sans CJK TC')).toBeLessThan(pdfFonts('zh-Hant').indexOf('Noto Sans CJK SC'))
    expect(typstPreamble('zh-Hant')).toContain('lang: "zh", region: "tw")')
    expect(typstPreamble('zh-Hans')).toContain('lang: "zh", region: "cn")')
    // Korean, and Latin-script documents, keep the order they had
    expect(pdfFonts('ko')).toEqual(PDF_FONTS)
    expect(pdfFonts('en')).toEqual(PDF_FONTS)
    expect(PDF_FONTS[0]).toBe('Pretendard')
    expect(typstPreamble('ko')).toContain('lang: "ko")')
    // every list names each bundled family once and ends with the Latin fallbacks
    for (const l of ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'en'] as const) {
      const f = pdfFonts(l)
      for (const n of ['Noto Sans CJK KR', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Sans CJK TC']) expect(f.filter((x) => x === n)).toHaveLength(1)
      expect(f.slice(-3)).toEqual(['Helvetica Neue', 'Arial', 'Libertinus Serif'])
    }
  })
})

const typst = process.env.MYCEL_TYPST_BIN ?? which('typst')
const pdffonts = which('pdffonts')
const required = process.env.MYCEL_FONT_DIR !== undefined
const runnable = !!(typst && pdffonts && which('pandoc'))
if (!runnable && required) throw new Error(`MYCEL_FONT_DIR is set but typst, pandoc or pdffonts is missing (typst=${typst}, pdffonts=${pdffonts})`)

describe.skipIf(!runnable)('make_file pdf: Korean, Japanese and Chinese are drawn with real glyphs', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('make-file-pdf-fonts') })
  afterAll(async () => { await A.close() })

  test(`${process.platform}${bundledFontDir() ? ' with the bundled fonts' : ' with the system fonts'}`, async () => {
    if (process.platform === 'linux' && !bundledFontDir()) console.log('no MYCEL_FONT_DIR on this Linux machine: the system fonts must have CJK')
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const r = await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'make_file', arguments: { content: MD, format: 'pdf', output: 'users/alice/out/cjk.pdf' } } })
    expect(r.result.isError, r.result.content[0].text).toBeFalsy()
    const file = path.join(A.team, 'users/alice/out/cjk.pdf')
    const pdf = fs.readFileSync(file)
    const fonts = Bun.spawnSync([pdffonts!, file]).stdout.toString()
    if (process.env.MYCEL_PDF_EVIDENCE) { fs.mkdirSync(process.env.MYCEL_PDF_EVIDENCE, { recursive: true }); fs.copyFileSync(file, path.join(process.env.MYCEL_PDF_EVIDENCE, `make-file-cjk-${process.platform}.pdf`)) }
    console.log(fonts)
    expect(unmapped(pdf, KO + JA + ZH + '3분기보고서제목항목금액광고비')).toEqual([])
    expect(fonts).not.toMatch(/Libertinus/)
    if (bundledFontDir()) expect(fonts).toMatch(/NotoSansCJKkr-Regular/)
    // the headings and **bold** are drawn with a bold face, not the regular one
    if (bundledFontDir()) expect(fonts).toMatch(/NotoSansCJKkr-Bold/)
  })

  test('a Japanese PDF is drawn with the JP face first (in a Korean team too), not Korean-style kanji', async () => {
    updateTeamSettings(A.ctx.db, { defaultLocale: 'ko' })
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const md = '# 第3四半期の報告\n\n売上が増えました。骨・直・角の字形を確認します。\n'
    const r = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'make_file', arguments: { content: md, format: 'pdf', output: 'users/alice/out/ja.pdf' } } })
    expect(r.result.isError, r.result.content[0].text).toBeFalsy()
    const file = path.join(A.team, 'users/alice/out/ja.pdf')
    const listed = Bun.spawnSync([pdffonts!, file]).stdout.toString().split('\n').slice(2).filter(Boolean).map((l) => l.split(/\s+/)[0]!.replace(/^[A-Z]{6}\+/, ''))
    console.log(listed)
    // the first face drawn is a Japanese one (a Mac's Hiragino, or the bundled Noto Sans CJK JP); no Korean face at all
    expect(listed[0]).toMatch(bundledFontDir() ? /^NotoSansCJKjp-/ : /^(Hiragino|NotoSansCJKjp-|NotoSansJP|YuGothic)/)
    expect(listed.join(' ')).not.toMatch(/AppleSDGothic|NotoSansCJKkr|Pretendard|Malgun/)
    expect(unmapped(fs.readFileSync(file), '第3四半期の報告売上が増えました骨直角')).toEqual([])
  })
})
