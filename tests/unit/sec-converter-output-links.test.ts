// Security regression (video-read plan review, must-fix 1): converter output was read back by path. The work folder is
// writable inside the converter isolation, so a converter taken over by a hostile input (ffmpeg, whisper, heif-dec,
// pandoc) could leave a symbolic link there in place of its output, pointing at any file the server account can read
// (another person's file). The server followed it: audio.wav went to OpenRouter, out.json became the transcript,
// thumb.jpg the attachment thumbnail, out.jpg the HEIC preview, ast.json / body.typ the new document; and make_file
// wrote doc.typ through a planted link. Here the "converter" is /usr/bin/true and the link is planted the moment it
// exits (Bun.spawn wrapped), which is exactly what the server saw before: a finished run and a link in the folder.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { readOutput, isPlainDir } from '../../server/src/tools/isolate'
import { makeThumbnail } from '../../server/src/uploads/image'
import { heicToJpeg } from '../../server/src/files/heic-preview'
import { which } from '../../server/src/config'
import { HwpError, NativeHwpEngine } from '../../server/src/files/hwp-engine'
import { makeCApp, type CApp } from '../lib/c-app'

const TRUE = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true'
const CANARY = 'CANARY-bob-private-' + crypto.randomUUID()
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(CANARY), Buffer.from([0xff, 0xd9])])
// a valid 1x1 PNG with the canary in a text chunk-like tail (the HWP path checks the PNG signature and IHDR only)
const PNG = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64'), Buffer.from(CANARY)])

let A: CApp
const C = () => componentC(A.ctx)
/** bob's own files: what a planted link points at */
let secret: { wav: string; json: string; jpeg: string; png: string; ast: string; text: string; victim: string }

// ---- a fake OpenRouter (never the real one)
const hits: unknown[] = []
const fakeOr = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hits.push(await req.text()); return Response.json({ text: 'never' }) } })

/** Wrap Bun.spawn: when a run of TRUE (or one `match` picks) ends, `plant(workDir, n)` runs (n counts those runs)
 * before the server sees it end. */
let plant: ((dir: string, n: number) => void) | null = null
let match: (argv: string[]) => boolean = (argv) => argv.includes(TRUE)
let runs = 0
const realSpawn = Bun.spawn
const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: any, o: any) => {
  const p = (realSpawn as any)(cmd, o)
  const argv = Array.isArray(cmd) ? cmd.map(String) : []
  if (!plant || !match(argv) || typeof o?.cwd !== 'string') return p
  const n = ++runs
  const f = plant
  const exited = p.exited.then((code: number) => { f(o.cwd, n); return code })
  return new Proxy(p, { get: (t, k) => { if (k === 'exited') return exited; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v } })
}) as typeof Bun.spawn)

beforeAll(async () => {
  A = await makeCApp('sec-converter-output')
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id IN ('alice','bob')").run()
  const dir = path.join(A.team, 'users', 'bob')
  fs.mkdirSync(dir, { recursive: true })
  const put = (name: string, data: string | Buffer) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p }
  secret = {
    wav: put('call.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.from(CANARY)])),
    json: put('notes.json', JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: CANARY }] })),
    jpeg: put('photo.jpg', JPEG),
    png: put('page.png', PNG),
    ast: put('tree.json', JSON.stringify({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [{ t: 'Para', c: [{ t: 'Str', c: CANARY }] }] })),
    text: put('diary.txt', `= ${CANARY}\n`),
    victim: put('keep.txt', 'unchanged'),
  }
})
afterEach(() => { plant = null; match = (argv) => argv.includes(TRUE); runs = 0; hits.length = 0 })
afterAll(async () => { spawnSpy.mockRestore(); fakeOr.stop(true); await A.close() })

const noCanary = (v: unknown) => expect(JSON.stringify(v ?? null)).not.toContain(CANARY)
const link = (target: string, dir: string, name: string) => fs.symlinkSync(target, path.join(dir, name))

describe('readOutput: only a plain file the converter wrote', () => {
  test('regular file; links, hard links, FIFOs, folders and oversize files are refused', () => {
    const dir = fs.mkdtempSync(path.join(A.data, 'ro-'))
    fs.writeFileSync(path.join(dir, 'ok.bin'), 'hello')
    link(secret.jpeg, dir, 'link.jpg')
    link('/nonexistent-' + crypto.randomUUID(), dir, 'dangling.jpg')
    fs.writeFileSync(path.join(dir, 'a.bin'), 'x')
    fs.linkSync(path.join(dir, 'a.bin'), path.join(dir, 'hard.bin'))
    fs.mkdirSync(path.join(dir, 'sub'))
    const fifo = Bun.spawnSync(['mkfifo', path.join(dir, 'pipe')]).exitCode === 0
    const r = readOutput(dir, 'ok.bin', 100)
    expect(r.ok && r.bytes.toString()).toBe('hello')
    expect(readOutput(dir, 'ok.bin', 4)).toEqual({ ok: false, why: 'too_large' })
    expect(readOutput(dir, 'none', 100)).toEqual({ ok: false, why: 'missing' })
    for (const n of ['link.jpg', 'dangling.jpg', 'hard.bin', 'sub', ...(fifo ? ['pipe'] : [])]) expect(readOutput(dir, n, 1e6)).toEqual({ ok: false, why: 'not_regular' })
    expect(() => readOutput(dir, '../x', 10)).toThrow()
    expect(isPlainDir(path.join(dir, 'sub'))).toBe(true)
    link(path.join(dir, 'sub'), dir, 'sublink')
    expect(isPlainDir(path.join(dir, 'sublink'))).toBe(false)
  })
})

describe('speech: a planted link is never sent or used as the transcript', () => {
  let saved: Record<string, unknown>
  beforeAll(() => {
    const t = C().transcribe
    saved = { ...t }
    t.openRouterUrl = `http://127.0.0.1:${fakeOr.port}/api/v1/audio/transcriptions`
  })
  afterAll(() => { Object.assign(C().transcribe, saved) })
  async function job(name: string) {
    const fd = new FormData()
    fd.set('file', new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], name))
    const r = await A.json('/api/transcribe', { method: 'POST', body: fd, as: 'alice' })
    expect(r.status).toBe(202)
    return (await C().jobs.wait(r.body.jobId))!
  }

  test('OpenRouter: ffmpeg leaves audio.wav as a link to bob\'s recording -> nothing is sent', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
    writeSpeechKey(credentialsOf(A.ctx), 'sk-or-v1-FAKE-TEST-KEY')
    C().transcribe.ffmpegBin = TRUE
    plant = (dir) => link(secret.wav, dir, 'audio.wav')
    const j = await job('voice.webm')
    expect(runs).toBe(1)
    expect(j.status).toBe('failed')
    expect(j.error!.message).toContain('could not be read')
    expect(hits).toEqual([])
    noCanary(j)
  })

  test('local whisper: out.json left as a link to bob\'s JSON -> the job fails, the file is not the transcript', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    const t = C().transcribe
    const modelDir = fs.mkdtempSync(path.join(A.data, 'model-'))
    fs.writeFileSync(path.join(modelDir, 'ggml-fake.bin'), Buffer.alloc(16))
    Object.assign(t, { ffmpegBin: null, whisperBin: TRUE, modelDir, sharedModelDir: null, modelOverride: { file: 'ggml-fake.bin', size: 16, sha256: 'x' } })
    plant = (dir) => link(secret.json, dir, 'out.json')
    const j = await job('voice.wav')
    expect(runs).toBe(1)
    expect(j.status).toBe('failed')
    expect(j.error!.message).toMatch(/failed/i)
    noCanary(j)
  })
})

describe('images: the thumbnail and the HEIC preview come from the converter, never through a link', () => {
  test('attachment thumbnail: a thumb.jpg link to bob\'s photo is not copied (the JPEG comes on stdout)', async () => {
    const src = path.join(A.data, 'thumb-src.png')
    fs.writeFileSync(src, 'not really a png')
    const dst = path.join(A.data, 'thumbs', `${crypto.randomUUID()}.jpg`)
    plant = (dir) => link(secret.jpeg, dir, 'thumb.jpg')
    expect(await makeThumbnail(src, dst, 320, path.join(A.data, 'work'), TRUE)).toBe(false)
    expect(runs).toBe(1)
    expect(fs.existsSync(dst)).toBe(false)
  })
  test('attachment thumbnail with the real ffmpeg still works', async () => {
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) { console.log('ffmpeg missing: real thumbnail not tested here'); return }
    const src = path.join(A.data, 'thumb-real.png')
    if (Bun.spawnSync([ffmpeg, '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', src]).exitCode !== 0) return
    const dst = path.join(A.data, 'thumbs', 'real.jpg')
    expect(await makeThumbnail(src, dst, 320, path.join(A.data, 'work'))).toBe(true)
    const b = fs.readFileSync(dst)
    expect([b[0], b[1], b[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })
  test('HEIC preview: heif-dec leaving out.jpg as a link to bob\'s photo is refused', async () => {
    plant = (dir) => link(secret.jpeg, dir, 'out.jpg')
    const r = await heicToJpeg(new Uint8Array(64), { heifDec: TRUE, imageIo: null }).catch((e) => e)
    expect(runs).toBe(1)
    expect(Buffer.isBuffer(r)).toBe(false)
    noCanary(String(r))
  })
})

describe('make_file: pandoc output read without links; no write through a planted name', () => {
  let conv: { pandoc: string | null; typst: string | null }
  beforeAll(() => { const mf = C().makeFile as any; conv = mf.conv; mf.conv = { pandoc: TRUE, typst: TRUE } })
  afterAll(() => { (C().makeFile as any).conv = conv })
  const run = (format: 'docx' | 'pdf', output: string) => C().makeFile.run(A.toolCtx('alice'), { format, content: '# Hello\n', output } as any)
  const exists = (rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))

  test('ast.json left as a link to bob\'s document tree: refused, nothing written', async () => {
    plant = (dir, n) => { if (n === 1) link(secret.ast, dir, 'ast.json') }
    const e = await run('docx', 'users/alice/a.docx').catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(String(e.message)).toContain('produced no file')
    expect(runs).toBe(1)
    expect(exists('users/alice/a.docx')).toBe(false)
  })
  test('body.typ left as a link to bob\'s text: refused before typst runs', async () => {
    plant = (dir, n) => {
      if (n === 1) fs.writeFileSync(path.join(dir, 'ast.json'), JSON.stringify({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [] }))
      if (n === 2) link(secret.text, dir, 'body.typ')
    }
    const e = await run('pdf', 'users/alice/b.pdf').catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(String(e.message)).toContain('produced no file')
    expect(runs).toBe(2)
    expect(exists('users/alice/b.pdf')).toBe(false)
  })
  test('links planted under the names the server writes next (doc.typ, tree.json) are not written through', async () => {
    plant = (dir, n) => {
      if (n === 1) {
        fs.writeFileSync(path.join(dir, 'ast.json'), JSON.stringify({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [] }))
        for (const name of ['doc.typ', 'tree.json', 'ast2.json']) link(secret.victim, dir, name)
      }
      if (n === 2) fs.writeFileSync(path.join(dir, 'body.typ'), 'Hello\n')
    }
    const e = await run('pdf', 'users/alice/c.pdf').catch((x) => x)
    // typst is /usr/bin/true: it writes no PDF, so the call ends with "no file"; the point is bob's file
    expect(String(e?.message)).toContain('produced no file')
    expect(runs).toBe(3)
    expect(fs.readFileSync(secret.victim, 'utf8')).toBe('unchanged')
  })
})

describe('HWP preview: the rendered page is read without links', () => {
  const engine = new NativeHwpEngine()
  const hwp = fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwp'))
  const ready = () => engine.render(hwp, 'hwp', 1).then(() => true, (e) => { if (e instanceof HwpError && e.reason === 'engine') return false; throw e })
  for (const how of ['the PNG', 'the pages folder'] as const) test(`the renderer swapping ${how} for a link to bob's file is refused`, async () => {
    if (!(await ready())) { console.log('rhwp not prepared (bun run prepare:hwp): HWP link test skipped'); return }
    match = (argv) => argv.includes('export-png')
    plant = (dir) => {
      const pages = path.join(dir, 'pages')
      if (how === 'the PNG') {
        const f = fs.readdirSync(pages)[0]!
        fs.rmSync(path.join(pages, f)); link(secret.png, pages, f)
      } else {
        const other = fs.mkdtempSync(path.join(A.data, 'other-'))
        fs.copyFileSync(secret.png, path.join(other, 'page-1.png'))
        fs.rmSync(pages, { recursive: true }); fs.symlinkSync(other, pages)
      }
    }
    const r = await engine.render(hwp, 'hwp', 1).catch((e) => e)
    expect(runs).toBe(1)
    expect(r).toBeInstanceOf(HwpError)
    noCanary(String(r))
  })
})
