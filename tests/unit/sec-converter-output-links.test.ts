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
import { readOutput, isPlainDir, makeWorkDir, runIsolated } from '../../server/src/tools/isolate'
import { makeThumbnail } from '../../server/src/uploads/image'
import { heicToJpeg } from '../../server/src/files/heic-preview'
import { which } from '../../server/src/config'
import { HwpError, NativeHwpEngine } from '../../server/src/files/hwp-engine'
import * as media from '../../server/src/files/media'
import { ToolError } from '../../server/src/policy/errors'
import { openRouterAudio } from '../../server/src/jobs/openrouter-stt'
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
/** What a converter can do on macOS (its work folder is inside the sandbox's writable subpath): empty the folder,
 * remove it and leave a link in its place. Every path the server then opens under the folder goes through the link. */
const swapWork = (target: string) => (dir: string) => { fs.rmSync(dir, { recursive: true, force: true }); fs.symlinkSync(target, dir) }
/** a folder of bob's holding files under the names converters write */
function otherFolder(): string {
  const d = fs.mkdtempSync(path.join(A.team, 'users', 'bob', 'f-'))
  fs.writeFileSync(path.join(d, 'out.jpg'), JPEG)
  fs.copyFileSync(secret.json, path.join(d, 'out.json'))
  fs.copyFileSync(secret.ast, path.join(d, 'ast.json'))
  return d
}

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

describe('the work folder itself left as a link: the run fails', () => {
  test('runIsolated reports it (killed: workdir); removing the folder removes the link, not what it points at', async () => {
    const other = otherFolder()
    const work = makeWorkDir(path.join(A.data, 'work'))
    plant = swapWork(other)
    const r = await runIsolated({ cmd: TRUE, args: [], workDir: work })
    expect(runs).toBe(1)
    expect(r.killed).toBe('workdir')
    expect(r.code).toBeNull()
    fs.rmSync(work, { recursive: true, force: true })
    expect(() => fs.lstatSync(work)).toThrow()
    expect(fs.readdirSync(other).sort()).toEqual(['ast.json', 'out.jpg', 'out.json'])
  })
  test('a link given as the work folder is refused before anything runs', async () => {
    const l = path.join(A.data, 'work-link-' + crypto.randomUUID())
    fs.symlinkSync(otherFolder(), l)
    await expect(runIsolated({ cmd: TRUE, args: [], workDir: l })).rejects.toThrow('not a plain folder')
    expect(runs).toBe(0)
  })
  test('HEIC preview: heif-dec leaving its work folder as a link to bob\'s folder is refused', async () => {
    plant = swapWork(otherFolder())
    const r = await heicToJpeg(new Uint8Array(64), { heifDec: TRUE, imageIo: null }).catch((e) => e)
    expect(runs).toBe(1)
    expect(Buffer.isBuffer(r)).toBe(false)
    noCanary(String(r))
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

  test('OpenRouter: the FLAC run leaves its output as a link to bob\'s recording -> nothing is sent', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
    writeSpeechKey(credentialsOf(A.ctx), 'sk-or-v1-FAKE-TEST-KEY')
    C().transcribe.ffmpegBin = TRUE
    // run 1 (to WAV) leaves a real WAV; run 2 (to FLAC) leaves a link under the name it was given
    let last: string[] = []
    match = (argv) => { if (!argv.includes(TRUE)) return false; last = argv; return true }
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEdata'), Buffer.from([0, 0, 0, 0])])
    plant = (dir, n) => { if (n === 1) fs.writeFileSync(path.join(dir, 'audio.wav'), wav); else link(secret.wav, dir, last[last.length - 1]!) }
    const j = await job('voice.webm')
    expect(runs).toBe(2)
    expect(last[last.length - 1]).toMatch(/^send-[0-9a-f-]{36}\.flac$/)
    expect(j.status).toBe('failed')
    expect(j.error!.message).toContain('could not be read')
    expect(hits).toEqual([])
    noCanary(j)
  })

  test('local whisper: the work folder left as a link to a folder of bob\'s -> the job fails, nothing is read there', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    const t = C().transcribe
    const modelDir = fs.mkdtempSync(path.join(A.data, 'model-'))
    fs.writeFileSync(path.join(modelDir, 'ggml-fake.bin'), Buffer.alloc(16))
    Object.assign(t, { ffmpegBin: null, whisperBin: TRUE, modelDir, sharedModelDir: null, modelOverride: { file: 'ggml-fake.bin', size: 16, sha256: 'x' } })
    const other = otherFolder()
    plant = swapWork(other)
    const j = await job('voice.wav')
    expect(runs).toBe(1)
    expect(j.status).toBe('failed')
    noCanary(j)
    expect(fs.readdirSync(other).sort()).toEqual(['ast.json', 'out.jpg', 'out.json'])
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

describe('video and audio reads: a converter that replaces its work folder ends the read as a damaged file', () => {
  const tools = { ffmpeg: TRUE, ffprobe: TRUE }
  const F = () => A.ctx.files
  let saved: Record<string, unknown>
  const spies: { mockRestore(): void }[] = []
  beforeAll(() => {
    C()
    saved = { ...F().speech }
    fs.mkdirSync(path.join(A.team, 'users', 'alice'), { recursive: true })
  })
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })
  afterAll(() => { Object.assign(F().speech, saved); updateTeamSettings(A.ctx.db, { speechProvider: 'off', aiMediaTranscripts: null }) })
  /** bob's folder (otherFolder) plus a WAV under the name a transcript piece is written as */
  function bobsFolder(): string {
    const d = otherFolder()
    fs.copyFileSync(secret.wav, path.join(d, 'audio-0.wav'))
    return d
  }
  const untouched = (d: string) => expect(fs.readdirSync(d).sort()).toEqual(['ast.json', 'audio-0.wav', 'out.jpg', 'out.json'])
  const vidFolders = () => fs.readdirSync(path.join(A.data, 'work')).filter((f) => f.startsWith('vid-'))
  /** a read of a new 18 s video in alice's folder (a chat turn, so frames may go); ffprobe's answer given */
  async function readVideo(args: Record<string, unknown>) {
    const rel = `users/alice/clip-${crypto.randomUUID()}.mp4`
    fs.writeFileSync(path.join(A.team, rel), `fake video ${rel}`)
    spies.push(
      spyOn(F(), 'mediaTools').mockReturnValue(tools),
      spyOn(F(), 'mediaProbe').mockResolvedValue({ durationSec: 18, format: 'mov', video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30 },
        audio: { index: 1, codec: 'aac', channels: 2, sampleRate: 48000 }, cover: false }),
    )
    const turnId = A.turn('alice', A.chat('alice'))
    A.ctx.db.query("UPDATE turns SET engine = 'claude-code' WHERE id = ?").run(turnId)
    return F().call('read', { file_path: rel, ...args }, A.toolCtx('alice', turnId))
  }

  test('probe, length scan, frame and sound runs: media_damaged ("damaged or unreadable"), never media_heavy; nothing read in bob\'s folder', async () => {
    const runsOf: [string, (w: string) => Promise<unknown>][] = [
      ['probe', (w) => media.probeMedia(tools, w, 'in.mp4')],
      ['length scan', (w) => media.scanDuration(tools, w, 'in.mp4')],
      ['frame', (w) => media.framePng(tools, w, 'in.mp4', 0, 1, 768)],
      ['sound', (w) => media.audioWav(tools, w, 'in.mp4', 1, 0, 60, 'audio-0.wav', { inputBytes: 16 })],
      // the FLAC for OpenRouter: 'damaged' is what makes a read or a voice job end without sending anything
      ['flac', (w) => openRouterAudio(TRUE, w, 'in.mp4', Buffer.alloc(64), { workBytes: 16 }).then((r) => { if (!r.ok && r.why === 'damaged') throw new ToolError('damaged', 'media_damaged'); return r })],
    ]
    for (const [what, run] of runsOf) {
      const other = bobsFolder()
      const w = media.mediaWork(path.join(A.data, 'work'))
      fs.writeFileSync(path.join(w, 'in.mp4'), 'not really a video')
      runs = 0
      plant = swapWork(other)
      const e = await run(w).catch((x) => x)
      expect(runs, what).toBe(1)
      expect(e, what).toBeInstanceOf(ToolError)
      expect((e as ToolError).code, what).toBe('media_damaged')
      expect(media.workIntact(w), what).toBe(false)
      media.dropWork(w)
      expect(() => fs.lstatSync(w)).toThrow()
      untouched(other)
    }
  })

  test('a read whose first frame run replaced the folder: the damaged note, no further frame, nothing of bob\'s', async () => {
    const other = bobsFolder()
    const before = vidFolders()
    plant = swapWork(other)
    const out = await readVideo({ frames: 3, transcript: false })
    expect(runs).toBe(1)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('The file is damaged or unreadable.')
    expect(out.content).toBeUndefined()
    noCanary(out)
    untouched(other)
    expect(vidFolders()).toEqual(before)
  })

  test('an OpenRouter read whose FLAC run left a link to bob\'s recording: the transcript fails as damaged, nothing is sent', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter', aiMediaTranscripts: true })
    writeSpeechKey(credentialsOf(A.ctx), 'sk-or-v1-FAKE-TEST-KEY')
    F().speech.openRouterUrl = `http://127.0.0.1:${fakeOr.port}/api/v1/audio/transcriptions`
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)])
    spies.push(spyOn(F(), 'mediaAudio').mockImplementation(async (_t, work: string, _n, _s, _st, _sec, out: string) => { fs.writeFileSync(path.join(work, out), wav); return wav }))
    let last: string[] = []
    match = (argv) => { if (!argv.includes(TRUE)) return false; last = argv; return true }
    plant = (dir) => link(secret.wav, dir, last[last.length - 1]!)
    const out = await readVideo({ frames: 0 })
    expect(runs).toBe(1)
    expect(out.text).toContain('The transcript failed (The file is damaged or unreadable')
    expect(hits).toEqual([])
    noCanary(out)
  })

  test('a read whose whisper.cpp run replaced the folder: the damaged note, no frames after it, the piece\'s WAV not removed through the link', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local', aiMediaTranscripts: null })
    const modelDir = fs.mkdtempSync(path.join(A.data, 'model-'))
    fs.writeFileSync(path.join(modelDir, 'ggml-fake.bin'), Buffer.alloc(16))
    Object.assign(F().speech, { whisperBin: TRUE, modelDir, sharedModelDir: null, modelOverride: { file: 'ggml-fake.bin', size: 16, sha256: 'x' } })
    // the piece's sound as ffmpeg would leave it (no converter run): only whisper.cpp runs, and swaps the folder
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)])
    spies.push(spyOn(F(), 'mediaAudio').mockImplementation(async (_t, work: string, _n, _s, _st, _sec, out: string) => { fs.writeFileSync(path.join(work, out), wav); return wav }))
    const other = bobsFolder()
    plant = swapWork(other)
    const out = await readVideo({ frames: 3 })
    expect(runs).toBe(1)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('The file is damaged or unreadable.')
    expect(out.text).not.toContain('Transcription failed')
    expect(out.content).toBeUndefined()
    noCanary(out)
    untouched(other)
  })
})

describe('images: the thumbnail and the HEIC preview come from the converter, never through a link', () => {
  test('attachment thumbnail: a thumb.jpg link to bob\'s photo is not copied (the JPEG comes on stdout)', async () => {
    const src = path.join(A.data, 'thumb-src.png')
    fs.writeFileSync(src, 'not really a png')
    const dst = path.join(A.data, 'thumbs', crypto.randomUUID())
    plant = (dir) => link(secret.jpeg, dir, 'thumb.jpg')
    expect(await makeThumbnail(src, dst, 320, path.join(A.data, 'work'), TRUE)).toBeNull()
    expect(runs).toBe(1)
    expect(fs.existsSync(`${dst}.jpg`)).toBe(false)
    expect(fs.existsSync(`${dst}.png`)).toBe(false)
  })
  test('a picture that may have alpha: neither run (the alpha look, then the thumbnail) takes a planted thumb.png or thumb.jpg', async () => {
    // a PNG's signature and an RGBA header, then nothing ffmpeg can read
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0])
    const src = path.join(A.data, 'thumb-src-alpha.png')
    fs.writeFileSync(src, head)
    const dst = path.join(A.data, 'thumbs', crypto.randomUUID())
    // planted after the first run; both runs share the work folder, so the second finds them there too
    plant = (dir, n) => { if (n === 1) { link(secret.png, dir, 'thumb.png'); link(secret.jpeg, dir, 'thumb.jpg') } }
    expect(await makeThumbnail(src, dst, 320, path.join(A.data, 'work'), TRUE)).toBeNull()
    expect(runs).toBe(2)
    expect(fs.existsSync(`${dst}.jpg`) || fs.existsSync(`${dst}.png`)).toBe(false)
  })
  test('attachment thumbnail with the real ffmpeg still works', async () => {
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) { console.log('ffmpeg missing: real thumbnail not tested here'); return }
    const src = path.join(A.data, 'thumb-real.png')
    if (Bun.spawnSync([ffmpeg, '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', src]).exitCode !== 0) return
    const dst = path.join(A.data, 'thumbs', 'real')
    expect(await makeThumbnail(src, dst, 320, path.join(A.data, 'work'))).toBe('jpg')
    const b = fs.readFileSync(`${dst}.jpg`)
    expect([b[0], b[1], b[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(fs.statSync(`${dst}.jpg`).mode & 0o777).toBe(0o600)
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
  test('the work folder left as a link to bob\'s folder after pandoc: nothing read or written there', async () => {
    const other = otherFolder()
    plant = (dir, n) => { if (n === 1) swapWork(other)(dir) }
    const e = await run('docx', 'users/alice/d.docx').catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(runs).toBe(1)
    noCanary(String(e?.message))
    expect(fs.readdirSync(other).sort()).toEqual(['ast.json', 'out.jpg', 'out.json'])
    expect(exists('users/alice/d.docx')).toBe(false)
  })
  test('the finished document left as a link to bob\'s file: refused, nothing placed, bob\'s file kept', async () => {
    plant = (dir, n) => {
      if (n === 1) fs.writeFileSync(path.join(dir, 'ast.json'), JSON.stringify({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [] }))
      if (n === 2) link(secret.victim, dir, 'out.docx')
    }
    const e = await run('docx', 'users/alice/e.docx').catch((x) => x)
    expect(String(e?.message)).toContain('symbolic links are not followed')
    expect(runs).toBe(2)
    expect(exists('users/alice/e.docx')).toBe(false)
    expect(fs.readFileSync(secret.victim, 'utf8')).toBe('unchanged')
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
