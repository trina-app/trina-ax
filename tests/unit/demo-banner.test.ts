// The demo's banner kit (server/src/demo/fakes/banner.ts, the fake Higgsfield's make_banner): a banner is a text-free
// photo made in advance plus its words, so "change the headline to … two cups" gives a new banner back (owner, 11-21:
// the AI said the words were baked into the picture). Covered: Steepling's kit in en and ko (scripts/demo/steepling/
// banner/kit.ts) draws every scene and size; new words give a new picture and only the words given change; the words go
// into typst as strings (markup and code in them stay words); the scene follows the words ("두 잔" → two glasses); end
// to end on a demo server, the Higgsfield connection's make_banner answers with the picture and save_connector_file
// saves it into the team folder; and the AI's demo note says the fakes are practice copies. typst is needed to draw
// (the server's PDF converter); without it the drawing tests are skipped. Fake data only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bannerTypst, BANNER_SIZES, findTypst, loadBannerKit, pickScene, renderBanner, sizeOf, typstString, type BannerKit } from '../../server/src/demo/fakes/banner'
import { FakeHiggsfield, MEDIA_HOST } from '../../server/src/demo/fakes/higgsfield'
import { FakeState } from '../../server/src/demo/fakes/state'
import { demoFakesOf } from '../../server/src/demo/fakes'
import { DEMO_FAKES_NOTE, demoRule } from '../../server/src/chat/prompt'
import { writeSteepling } from '../../scripts/demo/steepling/make'
import { makeCApp, type CApp } from '../lib/c-app'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
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

  drawing('make_banner draws new words into a new picture (en and ko); the rest stay the launch banner\'s', async () => {
    for (const [l, headline, want] of [['ko', '흐린 아침에,\\n작은 햇살 두 잔.', '흐린 아침에,\n작은 햇살 두 잔.'], ['en', 'A little sun\\nfor *two cups.*', 'A little sun\nfor *two cups.*']] as const) {
      const data = fs.mkdtempSync(path.join(tmp, 'data-'))
      const hf = new FakeHiggsfield([], new FakeState(data), kits[l], typst)
      const call = (a: Record<string, unknown>) => hf.tools.find((t) => t.name === 'make_banner')!.call(a)
      const before = await call({})
      const after = await call({ headline })
      for (const r of [before, after]) expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy()
      const view = JSON.parse((after.content[0] as { text: string }).text)
      expect(view.banner.words.headline).toBe(want)
      expect(view.banner.words.badge).toBe(kits[l].words.badge)
      expect(view.banner.words.button).toBe(kits[l].words.cta)
      expect(view.banner.scene).toBe('two-cups')
      expect(view.results[0].url).toContain(MEDIA_HOST)
      const img = (r: typeof after) => Buffer.from((r.content.find((c) => c.type === 'image') as { data: string }).data, 'base64')
      expect(isPng(img(after))).toBe(true)
      expect(img(after).equals(img(before))).toBe(false)
      // the download address gives the same picture (tools/download.ts → the fake)
      const d = hf.download(view.results[0].url)!
      expect(d.contentType).toBe('image/png')
      expect(d.bytes.equals(img(after))).toBe(true)
      // the same words again: the same picture (only the words changed it)
      const again = await call({ headline })
      expect(img(again).equals(img(after))).toBe(true)
    }
  })

  test('without a kit, make_banner says so (the built-in data)', async () => {
    const hf = new FakeHiggsfield([], new FakeState(fs.mkdtempSync(path.join(tmp, 'none-'))), null)
    const r = await hf.tools.find((t) => t.name === 'make_banner')!.call({ headline: 'x' })
    expect(r.isError).toBe(true)
  })
})

describe('the AI knows the demo\'s services are practice copies', () => {
  test('the demo rule carries the note when the demo has fakes, and only then', () => {
    expect(demoRule('Steepling', true)).toContain(DEMO_FAKES_NOTE)
    expect(demoRule('Steepling')).not.toContain(DEMO_FAKES_NOTE)
    expect(DEMO_FAKES_NOTE).toContain('prepared set of photos')
    expect(DEMO_FAKES_NOTE).toContain('make_banner')
    expect(DEMO_FAKES_NOTE).toContain('never really sent')
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

  drawing('"change the headline to … two cups": make_banner answers with the new banner and it is saved into the team folder', async () => {
    const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mcp', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } }) })
    expect(r.body.status).toBe('connected')
    const chat = A.chat('alice'), turnId = A.turn('alice', chat)
    const built = integrationToolProvider(A.ctx).build({ userId: 'alice', chatId: chat, turnId, browser: false, scheduled: false })
    const files = { user: A.ctx.files.principal('alice'), turnId, files: new TurnFiles() } as TurnToolContext['files']
    // the visitor answers the product's card for a change at Higgsfield (as for generate_image)
    files.person = { locale: 'ko', async confirm() { return true }, async choose(_q, options) { return options.some((x) => x.value === 'allow') ? 'allow' : options[0]!.value }, *turnUrls() {}, allSitesHere: () => true }
    const tc: TurnToolContext = { turnId, chatId: chat, userId: 'alice', messageId: 'm', locale: 'ko', signal: new AbortController().signal, files }
    const tool = built.tools.find((t) => t.name === 'team_higgsfield__make_banner') as TurnTool
    expect(tool).toBeTruthy()
    const out = await tool.call({ headline: '흐린 아침에,\n작은 햇살 두 잔.' }, tc)
    const text = out.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(out.isError, text).toBeFalsy()
    expect(text).toContain('작은 햇살 두 잔.')
    const handle = /(mcp-file:[A-Za-z0-9_-]{22})/.exec(text)?.[1]
    expect(handle, text).toBeTruthy()
    const saved = await toolRegistry(A.ctx.files).call('save_connector_file', { file: handle, save_as: 'users/alice/campaign-banner-two-cups.png' }, A.toolCtx('alice', turnId))
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    const savedPath = (saved.structured as { path: string }).path
    const bytes = fs.readFileSync(path.join(A.team, ...savedPath.split('/')))
    expect(isPng(bytes)).toBe(true)
    expect(pngSize(bytes)).toEqual({ w: 1200, h: 628 })
  })
})
