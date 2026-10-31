// What the AI's image and PDF-page reads say when a converter replaced its work folder (runIsolated killed 'workdir',
// tools/isolate.ts): the file "is damaged / cannot be read" (vision_damaged), like the HWP renderer and the other
// converters, not "too heavy" (vision_heavy), which stays for the time, memory, output and disk limits.
// The "converter" is /usr/bin/true; the work folder is swapped for a link the moment it exits (Bun.spawn wrapped), which
// is what the server sees when a converter taken over by a hostile file does it (tests/unit/sec-converter-output-links).
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelImage, normalizeForModel, pdfPagePng, type VisionTools } from '../../server/src/files/vision'

const TRUE = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true'
/** prints its arguments without end: stopped by the output limit */
const YES = fs.existsSync('/usr/bin/yes') ? '/usr/bin/yes' : '/bin/yes'
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-vision-other-'))

let swaps = 0
let swap = false
const realSpawn = Bun.spawn
const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: any, o: any) => {
  const p = (realSpawn as any)(cmd, o)
  const argv = Array.isArray(cmd) ? cmd.map(String) : []
  if (!swap || !argv.includes(TRUE) || typeof o?.cwd !== 'string') return p
  const dir: string = o.cwd
  const exited = p.exited.then((code: number) => { swaps++; fs.rmSync(dir, { recursive: true, force: true }); fs.symlinkSync(other, dir); return code })
  return new Proxy(p, { get: (t, k) => { if (k === 'exited') return exited; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v } })
}) as typeof Bun.spawn)
afterEach(() => { swap = false; swaps = 0 })
afterAll(() => { spawnSpy.mockRestore(); fs.rmSync(other, { recursive: true, force: true }) })

const tools = (o: Partial<VisionTools>): VisionTools => ({ normalizer: TRUE, heic: { heifDec: null, imageIo: null }, pdftotext: null, pdftoppm: null, pdfkit: null, ...o })
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e as { code?: string }).code)

describe('a converter that replaced its work folder: the read says damaged, not too heavy', () => {
  test('the image normalizer', async () => {
    swap = true
    expect(await codeOf(normalizeForModel(new Uint8Array(64), tools({})))).toBe('vision_damaged')
    expect(swaps).toBe(1)
  })
  test('the PDF page renderer (pdftoppm)', async () => {
    swap = true
    expect(await codeOf(pdfPagePng(new Uint8Array(64), 1, tools({ pdftoppm: TRUE })))).toBe('vision_damaged')
    expect(swaps).toBe(1)
  })
  test('the HEIC decoder (heif-dec)', async () => {
    swap = true
    expect(await codeOf(modelImage('photo.heic', new Uint8Array(64), tools({ heic: { heifDec: TRUE, imageIo: null } })))).toBe('vision_damaged')
    expect(swaps).toBe(1)
  })
  test('a limit still says too heavy: the normalizer writing more than one image block is stopped (output)', async () => {
    expect(await codeOf(normalizeForModel(new Uint8Array(64), tools({ normalizer: YES })))).toBe('vision_heavy')
  })
})
