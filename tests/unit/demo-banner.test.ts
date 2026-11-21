// The demo's banner kit (server/src/demo/fakes/banner.ts, banners.ts) and its local tool change_banner_text
// (server/src/tools/demo-banner.ts): a banner is a text-free photo made in advance plus its words, so "change the
// headline to … two cups" gives a new banner back (owner, 11-21: the AI said the words were baked into the picture).
// Since 11-22 the words are the server's own tool, never Higgsfield's: the owner got Higgsfield's send card ("AI가
// Higgsfield에 이 내용을 보내려고 해요") and a literal "\n" for "작지 않아 큰 햇살이야!". Covered: Steepling's kit in en
// and ko (scripts/demo/steepling/banner/kit.ts) draws every scene and size; new words give a new picture and only the
// words given change; a "\n" the AI writes as two letters is a real line break, never a backslash on the banner; the
// words go into typst as strings (markup and code in them stay words); the scene follows `scene` ("두 잔" → two
// glasses), never the headline's words, so a words-only change keeps the launch photo, the headline keeps its size while
// it fits, and no word is left alone on a last line (QA 11-22 A3); end to end on a demo server, change_banner_text saves the banner into the chat's project folder with no card
// and a step that names no Higgsfield, and the fake Higgsfield no longer offers make_banner; and the AI's demo note says
// words → change_banner_text, a new background → generate_image, and a short phrase after a banner is applied at once.
// typst is needed to draw (the server's PDF converter); without it the drawing tests are skipped. Fake data only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { balancedHeadline, bannerTypst, BANNER_SIZES, findTypst, headlineLines, headlineScale, loadBannerKit, NBSP, pickScene, renderBanner, sizeOf, typstString, unbrokenPieces, type BannerKit } from '../../server/src/demo/fakes/banner'
import { BANNERS_DIR, BANNERS_KEPT, DemoBanners, PREPARED_BANNER, withLineBreaks } from '../../server/src/demo/fakes/banners'
import { HIGGSFIELD_TOOLS, MAKE_BANNER_MOVED, PREPARED_PHOTO, SAVE_NEXT } from '../../server/src/demo/fakes/higgsfield'
import { FakeState } from '../../server/src/demo/fakes/state'
import { demoFakesOf } from '../../server/src/demo/fakes'
import { DEMO_BANNER_NOTE, DEMO_FAKES_NOTE, demoRule } from '../../server/src/chat/prompt'
import { writeSteepling } from '../../scripts/demo/steepling/make'
import { makeCApp, type CApp } from '../lib/c-app'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { CHANGE_BANNER_TEXT_DESCRIPTION, ChangeBannerTextInput, DEMO_BANNER_TOOL } from '../../server/src/tools/demo-banner'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import { stepLabel } from '../../shared/src/step-labels'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(120_000)

const typst = findTypst()
const drawing = typst ? test : test.skip
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-banner-'))
const content: Record<'en' | 'ko', string> = { en: path.join(tmp, 'en'), ko: path.join(tmp, 'ko') }
const kits = {} as Record<'en' | 'ko', BannerKit>
/** a PNG's width and height */
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })
const isPng = (b: Buffer) => b.subarray(1, 4).toString() === 'PNG'

beforeAll(() => {
  for (const l of ['en', 'ko'] as const) {
    writeSteepling(l, content[l])
    kits[l] = loadBannerKit(path.join(content[l], 'fakes'))!
  }
})
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe("Steepling's banner kit", () => {
  test('en and ko: the launch banner\'s words, four scenes, every size of the default scene, the fonts', () => {
    expect(kits.en.words.headline).toBe('A little sun\nfor *grey mornings.*')
    expect(kits.ko.words.headline).toBe('흐린 아침에,\n*작은 햇살 한 잔.*')
    expect(kits.ko.words.badge).toBe('20% 할인')
    expect(kits.ko.scenes.map((s) => s.id)).toEqual(['one-cup', 'two-cups', 'pouch', 'cafe'])
    expect(Object.keys(kits.ko.scenes[0]!.photos).sort()).toEqual([...BANNER_SIZES].sort())
    for (const s of kits.ko.scenes) for (const p of Object.values(s.photos)) {
      const f = path.join(kits.ko.dir, p.file)
      expect(fs.statSync(f).size, p.file).toBeLessThan(400_000)
    }
    for (const f of ['Fraunces-SemiBold.ttf', 'NotoSerifKR-SemiBold.ttf', 'NotoSansKR-Medium.ttf', 'OFL-Fraunces.txt']) expect(fs.existsSync(path.join(kits.ko.dir, 'fonts', f)), f).toBe(true)
    // the other scenes are generate_image pictures too, after the story's own (still the default)
    const pics = fs.readdirSync(path.join(content.ko, 'fakes', 'higgsfield')).filter((n) => n.endsWith('.jpg')).sort()
    expect(pics.length).toBe(4)
    expect(pics[0]!.startsWith('00-')).toBe(true)
  })

  test('the scene follows the words; a size missing in a scene goes to the closest that has it', () => {
    const k = kits.ko
    expect(pickScene(k, '1200x628', '흐린 아침에, 작은 햇살 두 잔.')!.id).toBe('two-cups')
    expect(pickScene(k, '1200x628', '작은 햇살 두잔')!.id).toBe('two-cups')
    expect(pickScene(k, '1200x628', 'A little sun for two cups')!.id).toBe('two-cups')
    expect(pickScene(k, '1200x628', 'pouch close up')!.id).toBe('pouch')
    expect(pickScene(k, '1200x628', '카페 테이블')!.id).toBe('cafe')
    expect(pickScene(k, '1200x628', 'something else')!.id).toBe('one-cup')
    expect(pickScene(k, '1080x1080', 'pouch close up')!.id).toBe('one-cup')
    expect(sizeOf('1:1')).toBe('1080x1080')
    expect(sizeOf('story')).toBe('1080x1920')
    expect(sizeOf('1080×1920')).toBe('1080x1920')
    expect(sizeOf(undefined)).toBe('1200x628')
  })

  test('the words are typst strings: markup and code in them stay words', () => {
    expect(typstString('a "b" \\ #c\nd')).toBe('"a \\"b\\" \\\\ #c\\nd"')
    const evil = 'x")#read("/etc/passwd")#("'
    const doc = bannerTypst(kits.en, '1200x628', { label: null }, { ...kits.en.words, headline: evil, subline: '*bold* _x_ $1$ #import "y"', cta: '"]' }, 'bg.jpg')
    expect(doc).not.toContain('#read("/etc/passwd")')
    expect(doc).toContain(typstString(evil))
  })

  drawing('every scene and size draws, en and ko', async () => {
    for (const l of ['en', 'ko'] as const) for (const s of kits[l].scenes) for (const size of BANNER_SIZES) {
      if (!s.photos[size]) continue
      const png = await renderBanner(kits[l], size, s, kits[l].words, typst)
      expect(isPng(png)).toBe(true)
      const [w, h] = size.split('x').map(Number)
      expect(pngSize(png), `${l} ${s.id} ${size}`).toEqual({ w: w!, h: h! })
    }
  })

  drawing('new words draw a new picture (en and ko); the rest stay the launch banner\'s', async () => {
    for (const [l, headline, want] of [['ko', '흐린 아침에,\\n작은 햇살 두 잔.', '흐린 아침에,\n작은 햇살 두 잔.'], ['en', 'A little sun\\nfor *two cups.*', 'A little sun\nfor *two cups.*']] as const) {
      const data = fs.mkdtempSync(path.join(tmp, 'data-'))
      const b = new DemoBanners(new FakeState(data), kits[l], typst)
      const before = await b.make({})
      const after = await b.make({ headline, scene: 'two glasses' })
      expect(after.words.headline).toBe(want)
      expect(after.words.badge).toBe(kits[l].words.badge)
      expect(after.words.cta).toBe(kits[l].words.cta)
      expect(after.scene).toBe('two-cups')
      expect(isPng(after.png)).toBe(true)
      expect(after.png.equals(before.png)).toBe(false)
      // the same words again: the same picture (only the words changed it); the photo stays without `scene`
      const again = await b.make({ headline })
      expect(again.png.equals(after.png)).toBe(true)
    }
  })

  test('a line break the AI writes as the two letters "\\n" (or "\\r\\n", <br>) is a real one', () => {
    expect(withLineBreaks('작지 않아\\n큰 햇살이야!')).toBe('작지 않아\n큰 햇살이야!')
    expect(withLineBreaks('작지 않아\\\\n큰 햇살이야!')).toBe('작지 않아\n큰 햇살이야!')
    expect(withLineBreaks('a\\r\\nb')).toBe('a\nb')
    expect(withLineBreaks('a\r\nb<br/>c<BR>d')).toBe('a\nb\nc\nd')
    expect(withLineBreaks('작지 않아\n큰 햇살이야!')).toBe('작지 않아\n큰 햇살이야!')
    // typst gets two lines with a line break between them, never a backslash and an n
    const doc = bannerTypst(kits.ko, '1200x628', { label: null }, { ...kits.ko.words, headline: withLineBreaks('작지 않아\\n큰 햇살이야!') }, 'bg.jpg')
    // Korean breaks only between words: each word is a box (QA 11-22 A3)
    expect(doc).toContain(`#box(${typstString('작지')}) #box(${typstString('않아')})#linebreak()#box(${typstString('큰')}) #box(${typstString('햇살이야!')})`)
    expect(doc).not.toContain('작지 않아\\\\n')
    expect(doc).not.toContain('작지 않아\\n')
  })

  drawing('"작지 않아\\n큰 햇살이야!" is drawn on two lines with no backslash', async () => {
    const pdftotext = Bun.which('pdftotext')
    const work = fs.mkdtempSync(path.join(tmp, 'lines-'))
    const photo = kits.ko.scenes[0]!.photos['1200x628']!
    fs.copyFileSync(path.join(kits.ko.dir, photo.file), path.join(work, 'bg.jpg'))
    const b = new DemoBanners(new FakeState(fs.mkdtempSync(path.join(tmp, 'lines-data-'))), kits.ko, typst)
    const made = await b.make({ headline: '작지 않아\\n큰 햇살이야!' })
    expect(made.words.headline).toBe('작지 않아\n큰 햇살이야!')
    fs.writeFileSync(path.join(work, 'b.typ'), bannerTypst(kits.ko, '1200x628', photo, made.words, 'bg.jpg'))
    const r = Bun.spawnSync([typst!, 'compile', '--font-path', path.join(kits.ko.dir, 'fonts'), '--root', work, 'b.typ', 'b.pdf'], { cwd: work })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    if (!pdftotext) return
    const got = Bun.spawnSync([pdftotext, path.join(work, 'b.pdf'), '-']).stdout.toString()
    expect(got).not.toContain('\\')
    const lines = got.split('\n').map((x) => x.trim())
    expect(lines).toContain('작지 않아')
    expect(lines).toContain('큰 햇살이야!')
  })

  drawing('words not given, and the photo, stay as on the last banner; a 400-letter headline is cut to 300', async () => {
    const data = fs.mkdtempSync(path.join(tmp, 'last-'))
    const b = new DemoBanners(new FakeState(data), kits.ko, typst)
    const call = async (a: Record<string, string>) => { const m = await b.make(a); return { size: m.size, scene: m.scene, words: m.words } }
    const first = await call({ headline: '흐린 아침에,\n작은 햇살 두 잔.', scene: '두 잔' })
    expect(first.scene).toBe('two-cups')
    const second = await call({ badge: '30% 할인' })
    expect(second.words.headline).toBe('흐린 아침에,\n작은 햇살 두 잔.')
    expect(second.words.badge).toBe('30% 할인')
    expect(second.scene).toBe('two-cups')
    const square = await call({ size: '1080x1080' })
    expect([square.size, square.scene, square.words.badge]).toEqual(['1080x1080', 'two-cups', '30% 할인'])
    // a new headline keeps the photo, even one whose words name a scene; only `scene` changes it (QA 11-22 A3)
    expect((await call({ headline: '작은 햇살, 큰 기쁨.' })).scene).toBe('two-cups')
    expect((await call({ headline: '카페 테이블 위의 햇살', size: '1200x628' })).scene).toBe('two-cups')
    expect((await call({ scene: '카페 테이블' })).scene).toBe('cafe')
    const long = await call({ headline: '가'.repeat(400) })
    expect(long.words.headline.length).toBe(300)
  })

  drawing('a words-only change of the launch banner keeps its photo, the launch scene (QA 11-22 A3)', async () => {
    expect(kits.ko.defaultScene).toBe('one-cup')
    expect(kits.en.defaultScene).toBe('one-cup')
    for (const [l, headline] of [['ko', '흐린 아침에,\n작은 햇살 두 잔.'], ['ko', '카페에서 만나는\n작은 햇살.'], ['en', 'A little sun\nfor two cups.']] as const) {
      const b = new DemoBanners(new FakeState(fs.mkdtempSync(path.join(tmp, 'keep-'))), kits[l], typst)
      const made = await b.make({ headline })
      expect(made.scene, `${l} ${headline}`).toBe(kits[l].defaultScene!)
      expect((await b.make({ subline: 'x y z' })).scene).toBe(kits[l].defaultScene!)
    }
  })

  test('the headline keeps the layout\'s size while it fits; only overflowing words get smaller type', () => {
    const h1Of = (kit: BannerKit, size: (typeof BANNER_SIZES)[number], headline: string) => Number(/text\(size: (\d+)pt, font: \([^)]*\), weight: 600, tracking: [^,]+, fill: deep/.exec(bannerTypst(kit, size, { label: null }, { ...kit.words, headline }, 'bg.jpg'))![1])
    for (const size of BANNER_SIZES) {
      const ko = h1Of(kits.ko, size, kits.ko.words.headline), en = h1Of(kits.en, size, kits.en.words.headline)
      // a bit longer than the launch headline: the same size (before 11-22 it shrank, QA A3)
      expect(h1Of(kits.ko, size, '추운 아침에,\n따뜻한 햇살 한 잔 했어요.'), size).toBe(ko)
      if (size === '1200x628') expect(h1Of(kits.en, size, 'A little sun\nfor the grey winter mornings.'), size).toBe(en)
      // the launch headline itself: the layout's size
      expect([ko, en], size).toEqual(size === '1200x628' ? [56, 68] : size === '1080x1080' ? [78, 92] : [96, 118])
      // far longer: smaller, so it stays on the banner
      expect(h1Of(kits.ko, size, '추운 아침에 마시는 따뜻한 햇살 한 잔, 유자와 생강이 만나 하루를 깨우는 작은 기쁨이 되어 드려요.'), size).toBeLessThan(ko)
      expect(h1Of(kits.en, size, 'A little sun for grey mornings, bright yuzu and a warm kick of ginger in every single cup we make.'), size).toBeLessThan(en)
    }
    expect(headlineScale(kits.ko.words.headline, 'ko', 56, 520)).toBe(1)
    expect(headlineLines(kits.ko.words.headline, 'ko', 56, 520)).toBe(2)
    // a piece that never breaks and is wider than the block is never drawn off the banner
    expect(headlineLines('Supercalifragilisticexpialidocious', 'en', 68, 520)).toBe(Infinity)
    expect(headlineScale('Supercalifragilisticexpialidocious', 'en', 68, 520)).toBeLessThan(1)
  })

  test('no word alone on a last line: the last two words stay together, Korean breaks only between words (QA 11-22 A3)', () => {
    const ko = bannerTypst(kits.ko, '1200x628', { label: null }, { ...kits.ko.words, headline: '추운 아침에 마시는 작은 햇살 했어요.', subline: '유자 진저 콜드브루. 상큼한 유자에 생강의 따뜻함을 더했어요.' }, 'bg.jpg')
    expect(ko).toContain('#set text(costs: (runt: 500%, orphan: 300%, widow: 300%))')
    expect(ko).toContain('#set par(linebreaks: "optimized")')
    // (two even lines since the demo re-test of 11-22: the breaks are chosen in code, balancedHeadline)
    expect(ko).toContain(`#box(${typstString('추운')}) #box(${typstString('아침에 마시는')})#linebreak()#box(${typstString('작은')}) #box(${typstString('햇살 했어요.')})`)
    expect(ko).toContain(`#box(${typstString('따뜻함을 더했어요.')})`)
    expect(unbrokenPieces('작지 않아', 'ko')).toEqual(['작지', '않아'])
    const en = bannerTypst(kits.en, '1200x628', { label: null }, { ...kits.en.words, subline: 'Bright yuzu and a warm kick of ginger in every cup.' }, 'bg.jpg')
    expect(en).toContain(typstString(`Bright yuzu and a warm kick of ginger in every${NBSP}cup.`))
    expect(unbrokenPieces('a b c', 'en')).toEqual(['a', `b${NBSP}c`])
    // Japanese and Chinese break anywhere, as they are written
    expect(unbrokenPieces('小さな 陽だまり', 'ja')).toEqual([])
  })

  // demo re-test 11-22: "작지 않아 큰 햇살이야!" broke as "작지 / 않아 큰 햇살이야!" (one word alone on the FIRST line)
  test('a headline of 2 or 3 lines gets even lines, chosen in code; the user\'s own line break stays', () => {
    expect(balancedHeadline('작지 않아 큰 햇살이야!', 'ko', 56, 520)).toBe('작지 않아\n큰 햇살이야!')
    expect(balancedHeadline('작은 햇살 두 잔.', 'ko', 78, 560)).toBe('작은 햇살\n두 잔.')
    // one line: as it is
    expect(balancedHeadline('작은 햇살 두 잔.', 'ko', 56, 520)).toBe('작은 햇살 두 잔.')
    expect(balancedHeadline('A little sun for two cups, every single morning.', 'en', 68, 520)).toBe('A little sun for\ntwo cups, every\nsingle morning.')
    // a *starred* italic run is never split
    expect(balancedHeadline('A little sun for *two cups.*', 'en', 68, 520)).toBe('A little sun\nfor *two cups.*')
    // the user's own "\n", Japanese and Chinese: as they are
    expect(balancedHeadline('작지\n않아 큰 햇살이야!', 'ko', 56, 520)).toBe('작지\n않아 큰 햇살이야!')
    expect(balancedHeadline('小さくない、大きな陽だまり！', 'ja', 56, 520)).toBe('小さくない、大きな陽だまり！')
    // never a short word alone on a line when there are 3 words or more
    for (const [t, l, s, w] of [['작지 않아 큰 햇살이야!', 'ko', 56, 520], ['작은 햇살 두 잔.', 'ko', 78, 560], ['Sun in a cup, all day long for you', 'en', 68, 520], ['오늘도 작은 햇살 한 잔으로 시작하는 우리의 아침', 'ko', 56, 520]] as const) {
      const lines = balancedHeadline(t, l, s, w).split('\n')
      expect(lines.filter((x) => !x.includes(' ')), `${t}: ${lines.join(' / ')}`).toEqual([])
    }
    // in the banner: the breaks as typst line breaks
    const doc = bannerTypst(kits.ko, '1200x628', { label: null }, { ...kits.ko.words, headline: '작지 않아 큰 햇살이야!' }, 'bg.jpg')
    expect(doc).toContain(`#box(${typstString('작지')}) #box(${typstString('않아')})#linebreak()#box(${typstString('큰')}) #box(${typstString('햇살이야!')})`)
  })

  drawing('drawn: balanced headlines split where chosen (Korean, English and a long one)', async () => {
    const pdftotext = Bun.which('pdftotext')
    if (!pdftotext) return
    const work = fs.mkdtempSync(path.join(tmp, 'balance-'))
    const draw = (kit: BannerKit, size: (typeof BANNER_SIZES)[number], headline: string) => {
      const photo = kit.scenes[0]!.photos[size]!
      fs.copyFileSync(path.join(kit.dir, photo.file), path.join(work, 'bg.jpg'))
      fs.writeFileSync(path.join(work, 'b.typ'), bannerTypst(kit, size, photo, { ...kit.words, eyebrow: '', subline: '', badge: '', badgeNote: '', cta: '', headline }, 'bg.jpg'))
      const r = Bun.spawnSync([typst!, 'compile', '--font-path', path.join(kit.dir, 'fonts'), '--root', work, 'b.typ', 'b.pdf'], { cwd: work })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return Bun.spawnSync([pdftotext, path.join(work, 'b.pdf'), '-']).stdout.toString().split('\n').map((x) => x.trim()).filter(Boolean)
        // the headline's lines only (the pouch's label is drawn too)
        .filter((l) => headline.includes(l))
    }
    expect(draw(kits.ko, '1200x628', '작지 않아 큰 햇살이야!')).toEqual(['작지 않아', '큰 햇살이야!'])
    expect(draw(kits.ko, '1080x1080', '작은 햇살 두 잔.')).toEqual(['작은 햇살', '두 잔.'])
    expect(draw(kits.en, '1200x628', 'A little sun for two cups, every single morning.')).toEqual(['A little sun for', 'two cups, every', 'single morning.'])
    const long = draw(kits.ko, '1200x628', '오늘도 작은 햇살 한 잔으로 시작하는 우리의 아침')
    expect(long.join(' ')).toBe('오늘도 작은 햇살 한 잔으로 시작하는 우리의 아침')
    for (const l of long) expect(l.includes(' '), long.join(' / ')).toBe(true)
  })

  drawing('drawn: no line holds only the last word, and no Korean word is cut in two', async () => {
    const pdftotext = Bun.which('pdftotext')
    if (!pdftotext) return
    const work = fs.mkdtempSync(path.join(tmp, 'runt-'))
    for (const size of BANNER_SIZES) {
      const photo = kits.ko.scenes[0]!.photos[size]!
      fs.copyFileSync(path.join(kits.ko.dir, photo.file), path.join(work, 'bg.jpg'))
      const words = { ...kits.ko.words, headline: '추운 아침에 마시는 작은 햇살 했어요.', subline: '유자 진저 콜드브루. 상큼한 유자에 생강의 따뜻함을 듬뿍 더해 만들었어요.' }
      fs.writeFileSync(path.join(work, 'b.typ'), bannerTypst(kits.ko, size, photo, words, 'bg.jpg'))
      const r = Bun.spawnSync([typst!, 'compile', '--font-path', path.join(kits.ko.dir, 'fonts'), '--root', work, 'b.typ', 'b.pdf'], { cwd: work })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      const lines = Bun.spawnSync([pdftotext, path.join(work, 'b.pdf'), '-']).stdout.toString().split('\n').map((x) => x.trim()).filter(Boolean)
      expect(lines, size).not.toContain('했어요.')
      expect(lines, size).not.toContain('만들었어요.')
      // every word of the headline and the line under it is whole on one line
      const all = lines.join(' ')
      for (const w of [...words.headline.split(' '), ...words.subline.split(' ')]) expect(all, `${size} ${w}`).toContain(w)
    }
  })

  drawing('hostile words in every field are drawn as they are, never run', async () => {
    const pdftotext = Bun.which('pdftotext')
    const HOSTILE = [
      'x")#read("/etc/passwd")#("', 'ends with a backslash \\', '\\u{22}#read("/etc/passwd")', 'bell\u0007 tab\t sep\u2028 end',
      '#import "@preview/cetz:0.3.0": *', ']#read("/etc/passwd")[', '$x^2$ _u_ @ref <lbl> // c /* d */', '`raw` = - + 1. #set text(red)',
      `${'long '.repeat(60)}`.slice(0, 300),
    ]
    const FIELDS = ['eyebrow', 'headline', 'subline', 'badge', 'badgeNote', 'cta'] as const
    const MAX = { eyebrow: 200, headline: 300, subline: 400, badge: 80, badgeNote: 80, cta: 80 }
    const work = fs.mkdtempSync(path.join(tmp, 'hostile-'))
    const photo = kits.en.scenes[0]!.photos['1200x628']!
    fs.copyFileSync(path.join(kits.en.dir, photo.file), path.join(work, 'bg.jpg'))
    const flat = (t: string) => t.toLowerCase().replace(/\s+/g, '')
    for (const field of FIELDS) for (const bad of [...HOSTILE, '*he said "hi" \\ ]#read("/x")[*']) {
      const words = { ...kits.en.words, [field]: bad.slice(0, MAX[field]) }
      fs.writeFileSync(path.join(work, 'b.typ'), bannerTypst(kits.en, '1200x628', photo, words, 'bg.jpg'))
      for (const out of ['b.png', 'b.pdf']) {
        const r = Bun.spawnSync([typst!, 'compile', '--font-path', path.join(kits.en.dir, 'fonts'), '--root', work, 'b.typ', out], { cwd: work })
        expect(r.exitCode, `${field} ${bad}: ${r.stderr.toString()}`).toBe(0)
      }
      if (!pdftotext) continue
      const got = Bun.spawnSync([pdftotext, path.join(work, 'b.pdf'), '-']).stdout.toString()
      // what the banner shows: the words, control letters as spaces, the stars around an italic headline word dropped
      const shown = words[field].replace(/[\u0000-\u001f\u2028]/g, ' ')
      const want = field === 'headline' ? shown.replace(/\*/g, '') : shown
      expect(flat(got), `${field}: ${bad}`).toContain(flat(want))
      expect(got).not.toContain('root:')
    }
  }, 300_000) // 120 typst runs: about 1.5 s each on a busy Mac

  test('the banners folder keeps the newest pictures only', () => {
    const data = fs.mkdtempSync(path.join(tmp, 'prune-'))
    const state = new FakeState(data)
    const dir = path.join(data, 'demo-fakes', BANNERS_DIR)
    fs.mkdirSync(dir, { recursive: true })
    state.update((d) => {
      for (let i = 0; i < BANNERS_KEPT + 10; i++) {
        const id = `old${String(i).padStart(3, '0')}`
        d.generations.push({ id, prompt: 'p', model: 'banner', picture: `${BANNERS_DIR}/${id}.png`, mime: 'image/png', createdAt: new Date().toISOString() })
        fs.writeFileSync(path.join(dir, `${id}.png`), 'x')
      }
    })
    fs.writeFileSync(path.join(dir, 'trimmed-long-ago.png'), 'x')
    ;(new DemoBanners(state, kits.en) as unknown as { pruneBanners(d: string): void }).pruneBanners(dir)
    const left = fs.readdirSync(dir).sort()
    expect(left.length).toBe(BANNERS_KEPT)
    expect(left[0]).toBe('old010.png')
  })

  test('without a kit there is no banner maker (the built-in data)', async () => {
    const b = new DemoBanners(new FakeState(fs.mkdtempSync(path.join(tmp, 'none-'))), null)
    expect(b.ready).toBe(false)
    await expect(b.make({ headline: 'x' })).rejects.toThrow('not set up')
  })
})

describe('the AI knows the demo\'s services are practice copies', () => {
  test('the demo rule carries the note when the demo has fakes, and the banner line only with a banner kit', () => {
    expect(demoRule('Steepling', true)).toContain(DEMO_FAKES_NOTE)
    expect(demoRule('Steepling')).not.toContain(DEMO_FAKES_NOTE)
    expect(DEMO_FAKES_NOTE).toContain('prepared set of photos')
    expect(DEMO_FAKES_NOTE).toContain('never really sent')
    expect(demoRule('Steepling', true)).not.toContain(DEMO_BANNER_TOOL)
    expect(demoRule('Steepling', true, true)).toContain(DEMO_BANNER_NOTE)
    expect(demoRule('Steepling', false, true)).not.toContain(DEMO_BANNER_NOTE)
  })

  test('words → the local change_banner_text, a new background → Higgsfield generate_image; never make_banner', () => {
    expect(DEMO_BANNER_NOTE).toContain('call change_banner_text')
    expect(DEMO_BANNER_NOTE).toContain('nothing is sent to Higgsfield')
    expect(DEMO_BANNER_NOTE).toContain("Use Higgsfield's generate_image only for a new background, photo or scene")
    expect(DEMO_BANNER_NOTE).not.toContain('make_banner')
    expect(CHANGE_BANNER_TEXT_DESCRIPTION).toContain('nothing is generated or sent anywhere')
    expect(CHANGE_BANNER_TEXT_DESCRIPTION).toContain("For a new background, photo or scene use Higgsfield's generate_image instead")
    const gen = HIGGSFIELD_TOOLS.find((t) => t.name === 'generate_image')!.description
    expect(gen).toContain('Use it for a new background, photo or scene')
    expect(gen).toContain('change_banner_text')
    expect(HIGGSFIELD_TOOLS.map((t) => t.name as string)).not.toContain('make_banner')
  })

  test('practice Drive files get no drive.google.com link; a scene with no prepared photo gets one line, no retry (QA 11-22 B3, A4)', () => {
    expect(DEMO_FAKES_NOTE).toContain('Practice Drive files have no web address: name the file and its folder, never write a drive.google.com link.')
    expect(DEMO_FAKES_NOTE).toContain('When a new scene is not among the prepared photos, say so in one line and offer the prepared ones; do not try again.')
    expect(DEMO_BANNER_NOTE).toContain('give scene only when the user asks for another of the prepared photos')
    expect(ChangeBannerTextInput.shape.scene.description).toContain('words alone never change the photo')
  })

  test('a short phrase right after a banner is its new headline: applied at once, undo offered after (owner, 11-22)', () => {
    expect(DEMO_BANNER_NOTE).toContain('A short phrase sent right after a banner is its new headline: apply it at once without asking, then offer to undo.')
  })

  test('say the photo is a prepared one, in one short sentence; save and show every picture without being asked (QA TC-6791, TC-6792)', () => {
    expect(DEMO_FAKES_NOTE).toContain("the photo comes from the demo's prepared photos")
    expect(DEMO_FAKES_NOTE).toContain('one short sentence')
    expect(DEMO_FAKES_NOTE).toContain('without being asked')
    expect(DEMO_FAKES_NOTE).toContain('save_connector_file')
    // the Markdown image the web draws inline (web/src/lib/markdown.ts classifyImage: /api/files/download?path=)
    expect(DEMO_FAKES_NOTE).toContain('![<name>](/api/files/download?path=')
    expect(DEMO_BANNER_NOTE).toContain('change_banner_text saves the banner; show it with the Markdown image its result gives')
    expect(DEMO_BANNER_NOTE).toContain("demo's prepared photos")
    // one sentence each in the result, no nagging
    for (const line of [PREPARED_PHOTO, PREPARED_BANNER, SAVE_NEXT]) expect(line.length).toBeLessThan(160)
  })

  test('the step says "배너 글자 바꾸기", never Higgsfield, and the headline on one line', () => {
    const ko = stepLabel(DEMO_BANNER_TOOL, { headline: '작지 않아\\n큰 햇살이야!' }, 'ko', new Set())
    expect(ko).toBe('배너 글자 바꾸기 · 작지 않아 큰 햇살이야!')
    expect(stepLabel(DEMO_BANNER_TOOL, { headline: 'A little sun\nfor *two cups.*' }, 'en', new Set())).toBe('Change banner text · A little sun for *two cups.*')
    expect(stepLabel(DEMO_BANNER_TOOL, { badge: '30% 할인' }, 'ko', new Set())).toBe('배너 글자 바꾸기')
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      const s = stepLabel(DEMO_BANNER_TOOL, { headline: '작지 않아\\n큰 햇살이야!' }, l, new Set())
      expect(s, l).not.toMatch(/higgsfield/i)
      expect(s, l).not.toContain('\\')
    }
  })
})

describe('end to end on a demo server', () => {
  let A: CApp
  beforeAll(async () => {
    A = await makeCApp('demo-banner')
    ;(A.ctx.config as any).demo = { company: 'Steepling', password: 'demo-password-1', personas: [], fakes: { content: path.join(content.ko, 'fakes') } }
    expect(demoFakesOf(A.ctx)).toBeTruthy()
    integrationsOf(A.ctx, { net: { lookup: async (h: string) => { throw new Error(`no lookup in the demo: ${h}`) } } })
  })
  afterAll(async () => { await A?.close() })

  test('the Higgsfield connection no longer offers make_banner; an old saved list that calls it is pointed to change_banner_text', async () => {
    const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mcp', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } }) })
    expect(r.body.status).toBe('connected')
    const chat = A.chat('alice'), turnId = A.turn('alice', chat)
    const built = integrationToolProvider(A.ctx).build({ userId: 'alice', chatId: chat, turnId, browser: false, scheduled: false })
    const names = built.tools.map((t) => t.name)
    expect(names).toContain('team_higgsfield__generate_image')
    expect(names.filter((n) => /banner/.test(n))).toEqual([])
    // the step in the person's language (demo re-test 11-22: "Higgsfield · Generate image" in a Korean chat)
    const gen = built.tools.find((t) => t.name === 'team_higgsfield__generate_image')!
    expect(gen.label?.({ prompt: 'x' }, 'ko')).toBe('Higgsfield · 이미지 만들기')
    expect(gen.label?.({ prompt: 'x' }, 'ja')).toBe('Higgsfield · 画像を生成')
    expect(gen.label?.({ prompt: 'x' }, 'en')).toBe('Higgsfield · Generate image')
    const res = await demoFakesOf(A.ctx)!.higgsfield.answer(new URL('https://mcp.higgsfield.ai/mcp'), { method: 'POST', headers: [], body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'make_banner', arguments: { headline: 'x' } } })) } as any)
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'))
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe(MAKE_BANNER_MOVED)
  })

  drawing('"작지 않아\\n큰 햇살이야!": change_banner_text saves the banner into the project folder, with no card and no Higgsfield', async () => {
    expect(toolRegistry(A.ctx.files).available(DEMO_BANNER_TOOL)).toBe(true)
    const chat = A.chat('alice'), turnId = A.turn('alice', chat)
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('yuzu', '유자 진저', 'users/alice/유자 진저')").run()
    A.ctx.db.query("UPDATE chats SET project_id = 'yuzu' WHERE id = ?").run(chat)
    // every card the turn could raise is recorded: none may come up (nothing leaves the server)
    const asked: string[] = []
    const files = { user: A.ctx.files.principal('alice'), turnId, files: new TurnFiles() } as TurnToolContext['files']
    files.person = { locale: 'ko', async confirm(q) { asked.push(q); return false }, async choose(q) { asked.push(q); return null }, *turnUrls() {}, allSitesHere: () => true }
    const tc: TurnToolContext = { turnId, chatId: chat, userId: 'alice', messageId: 'm', locale: 'ko', signal: new AbortController().signal, files }
    const tool = (A.ctx.services.turnTools ?? []).find((t) => t.name === DEMO_BANNER_TOOL) as TurnTool
    expect(tool).toBeTruthy()
    expect(tool.description).toBe(CHANGE_BANNER_TEXT_DESCRIPTION)
    // a local tool: no connection's read-only flag, so no send card for it (chat/tools.ts connections)
    expect(tool.readOnly).toBeUndefined()
    const out = await tool.call({ headline: '작지 않아\\n큰 햇살이야!' }, tc)
    const text = out.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(out.isError, text).toBeFalsy()
    expect(asked).toEqual([])
    expect(text).not.toMatch(/higgsfield/i)
    expect(text).toContain(PREPARED_BANNER)
    const view = JSON.parse(text.split('\n')[0]!)
    expect(view.words.headline).toBe('작지 않아\n큰 햇살이야!')
    expect(view.words.badge).toBe(kits.ko.words.badge)
    expect(view.saved.startsWith('users/alice/유자 진저/banner-1200x628-')).toBe(true)
    // shown inline right away (the Markdown image the web draws) and handed to the AI as a picture
    expect(text).toContain(`](/api/files/download?path=${encodeURIComponent(view.saved)})`)
    const img = out.content.find((c) => c.type === 'image') as { data: string } | undefined
    expect(img).toBeTruthy()
    const bytes = fs.readFileSync(path.join(A.team, ...view.saved.split('/')))
    expect(isPng(bytes)).toBe(true)
    expect(pngSize(bytes)).toEqual({ w: 1200, h: 628 })
    expect(Buffer.from(img!.data, 'base64').equals(bytes)).toBe(true)
    // the next change starts from this banner: only the badge changes
    const out2 = await tool.call({ badge: '30% 할인' }, tc)
    const view2 = JSON.parse(out2.content.map((c) => (c.type === 'text' ? c.text : '')).join('').split('\n')[0]!)
    expect([view2.words.headline, view2.words.badge]).toEqual(['작지 않아\n큰 햇살이야!', '30% 할인'])
    expect(view2.saved).not.toBe(view.saved)
    expect(asked).toEqual([])
  })
})
