// photo-pick-v1 (QA TC-251): the phone app's own photo picker for the page's 사진 보관함. The protocol, the app's pick
// (mobile/src/photos.ts: one at a time, chunks in order and exactly as long as the file, limits, cancel, fences, idle
// expiry, the copies deleted) and the receiver's routing. The page's side is in web/test/unit/mobile.test.ts.
import { expect, test } from 'bun:test'
import { FileTransfers, MobileReceiver, replyScript, type TransferIO } from '../../mobile/src/bridge'
import { SHEET_COOLDOWN_MS, SheetGate } from '../../mobile/src/sheet'
import { base64Bytes, PhotoPicks as Picks, PhotoRefused, pickedName, pickedType, type PickedAsset, type PickIO } from '../../mobile/src/photos'
/** the app's picks without the cooldown between sheets (tested on its own below) */
class PhotoPicks extends Picks { constructor(io: PickIO, timeout?: number) { super(io, timeout, new SheetGate(0)) } }
import { MAX_FILE_BYTES, MAX_PICK_BYTES, MAX_PICK_FILES, MOBILE_CAPABILITIES, parseMessage, PHOTO_PICK_CAPABILITY, PICK_CHUNK_BYTES, pickChunkLength, validConfig, validPicks, type MobileConfig } from '../../mobile/src/protocol'

const owner = { id: 'pick-request-1', generation: 1, nonce: 'a'.repeat(64) }
const msg = (over: object) => JSON.stringify({ v: 1, ...owner, ...over })

/** The phone's picker and its cache, in memory: `launch` waits until the test answers it. */
function phone() {
  const disk = new Map<string, Buffer>()
  const removed: string[] = []
  let answer: (assets: PickedAsset[]) => void = () => {}, fail: (e: unknown) => void = () => {}
  let launches = 0, limits: number[] = [], short = false
  const io: PickIO = {
    launch(limit) { launches++; limits.push(limit); return new Promise((resolve, reject) => { answer = resolve; fail = reject }) },
    async read(uri, offset, length) {
      const b = disk.get(uri); if (!b) throw new Error('gone')
      return base64Bytes(b.subarray(offset, offset + length - (short ? 1 : 0)))
    },
    async remove(uri) { removed.push(uri); disk.delete(uri) },
  }
  /** the person picked these files (name, type, bytes): copies in the app's cache */
  const pick = (files: { name?: string | null; mime?: string | null; bytes?: Buffer; size?: number; uri?: string }[]) => {
    answer(files.map((f, i) => {
      const uri = f.uri ?? `file:///cache/ImagePicker/${i}-${f.name ?? 'x'}`
      if (f.bytes) disk.set(uri, f.bytes)
      return { uri, name: f.name, mime: f.mime, size: f.size ?? f.bytes?.length ?? 0 }
    }))
  }
  return { io, disk, removed, pick, cancel: () => answer([]), fail: (e: unknown) => fail(e), launches: () => launches, limits, shortReads: () => { short = true } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const bytes = (n: number, seed = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b }

test('protocol: photo-pick asks for 1 to 20 files, chunks are bounded and on chunk boundaries; the capability is optional', () => {
  expect(parseMessage(msg({ type: 'photo-pick', limit: 3 }))).toMatchObject({ type: 'photo-pick', limit: 3 })
  expect(parseMessage(msg({ type: 'photo-pick', limit: MAX_PICK_FILES }))).not.toBeNull()
  for (const limit of [0, MAX_PICK_FILES + 1, 1.5, '3', null, undefined]) expect(parseMessage(msg({ type: 'photo-pick', limit }))).toBeNull()
  expect(parseMessage(msg({ type: 'photo-chunk', seq: 2, index: 1, offset: PICK_CHUNK_BYTES }))).toMatchObject({ seq: 2, index: 1, offset: PICK_CHUNK_BYTES })
  for (const over of [{ seq: -1 }, { index: MAX_PICK_FILES }, { index: -1 }, { offset: 5 }, { offset: MAX_FILE_BYTES }, { offset: -PICK_CHUNK_BYTES }, { index: '0' }, { uri: undefined, offset: undefined }])
    expect(parseMessage(msg({ type: 'photo-chunk', seq: 0, index: 0, offset: 0, ...over }))).toBeNull()
  expect(parseMessage(msg({ type: 'photo-done' }))?.type).toBe('photo-done')
  // a page or an app without it keeps working: protocol 1 still asks only for the two it always did
  expect(MOBILE_CAPABILITIES).not.toContain(PHOTO_PICK_CAPABILITY as never)
  expect(validConfig({ protocol: 1, platform: 'ios', appVersion: '1.0.4', generation: 1, nonce: 'a'.repeat(64), capabilities: [...MOBILE_CAPABILITIES] })).toBe(true)
  expect(pickChunkLength(PICK_CHUNK_BYTES + 5, 0)).toBe(PICK_CHUNK_BYTES)
  expect(pickChunkLength(PICK_CHUNK_BYTES + 5, PICK_CHUNK_BYTES)).toBe(5)
  expect(pickChunkLength(5, 5)).toBe(0)
})

test('protocol: a pick answer is safe names, picture or video types, 1 byte to 50 MiB each, 200 MiB together, within the limit', () => {
  const ok = { name: 'IMG_0001.jpg', mime: 'image/jpeg', size: 1200 }
  expect(validPicks([ok, { name: 'clip.mov', mime: 'video/quicktime', size: MAX_FILE_BYTES }], ['huge.mov'], 2)).toBe(true)
  expect(validPicks([], [], 1)).toBe(true)
  for (const bad of [{ ...ok, name: '../x.jpg' }, { ...ok, name: '' }, { ...ok, mime: 'text/html' }, { ...ok, mime: 'image/svg+xml' }, { ...ok, mime: 'image/svg+xml;x' }, { ...ok, size: 0 }, { ...ok, size: MAX_FILE_BYTES + 1 }, { ...ok, size: 1.5 }, { ...ok, uri: undefined, name: 7 }])
    expect(validPicks([bad], [], 1)).toBe(false)
  expect(validPicks([ok, ok], [], 1)).toBe(false)
  expect(validPicks(Array(5).fill({ ...ok, size: MAX_FILE_BYTES }), [], 5)).toBe(false)
  expect(validPicks([ok], ['a/b'], 1)).toBe(false)
  expect(validPicks([ok], 'x', 1)).toBe(false)
})

test('names and types: HEIC turned into JPEG gets .jpg, no name gets one, the original type wins on Android, nothing else is taken', () => {
  expect(pickedType({ uri: 'file:///c/ImagePicker/A.jpg', name: 'IMG_0001.jpg', mime: 'image/jpeg' })).toBe('image/jpeg')
  // Android copies a HEIC's bytes to a .jpeg file and says image/heic: the bytes are HEIC
  expect(pickedType({ uri: 'file:///c/ImagePicker/A.jpeg', name: 'PXL.heic', mime: 'image/heic' })).toBe('image/heic')
  expect(pickedType({ uri: 'file:///c/ImagePicker/A.mov', name: null, mime: null })).toBe('video/quicktime')
  expect(pickedType({ uri: 'file:///c/ImagePicker/A.html', name: 'a.html', mime: 'text/html' })).toBeNull()
  expect(pickedType({ uri: 'file:///c/ImagePicker/A.svg', name: 'a.svg', mime: 'image/svg+xml' })).toBeNull()
  expect(pickedType({ uri: 'file:///c/ImagePicker/A', name: null, mime: 'application/octet-stream' })).toBeNull()
  expect(pickedName('IMG_0001.HEIC', 'image/jpeg', 0)).toBe('IMG_0001.jpg')
  expect(pickedName('IMG_0001.jpeg', 'image/jpeg', 0)).toBe('IMG_0001.jpeg')
  expect(pickedName(null, 'image/jpeg', 0)).toBe('photo-1.jpg')
  expect(pickedName('  ', 'video/quicktime', 2)).toBe('video-3.mov')
  expect(pickedName('../../etc/passwd', 'image/png', 0)).not.toContain('/')
  expect(pickedName('a'.repeat(200) + '.heic', 'image/jpeg', 0)).toMatch(/^a+\.jpg$/)
})

test('base64 without btoa matches the platform encoder at every length, across its block boundary', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 0x3000 - 1, 0x3000, 0x3000 + 1, 0x3000 + 2, 100_003]) {
    const b = bytes(n, n)
    expect(base64Bytes(new Uint8Array(b))).toBe(b.toString('base64'))
  }
})

test('a pick: names, types and sizes first, then the bytes in order, exactly; done deletes the copies', async () => {
  const p = phone(), picks = new PhotoPicks(p.io)
  const big = bytes(PICK_CHUNK_BYTES + 7, 3), small = bytes(10, 9)
  const asked = picks.pick({ ...owner, limit: 4 })
  await tick()
  expect(p.limits).toEqual([4])
  p.pick([{ name: 'IMG_0001.HEIC', mime: 'image/jpeg', bytes: big }, { name: null, mime: 'video/quicktime', bytes: small }])
  const { files, tooBig } = await asked
  expect(files).toEqual([{ name: 'IMG_0001.jpg', mime: 'image/jpeg', size: big.length }, { name: 'video-2.mov', mime: 'video/quicktime', size: 10 }])
  expect(tooBig).toEqual([])
  expect(JSON.stringify(files)).not.toContain('file://')
  const got: Buffer[] = []
  let seq = 0
  for (const [index, f] of files.entries()) for (let offset = 0; offset < f.size; offset += PICK_CHUNK_BYTES)
    got.push(Buffer.from(await picks.chunk({ ...owner, seq: seq++, index, offset }), 'base64'))
  expect(got.map(b => b.length)).toEqual([PICK_CHUNK_BYTES, 7, 10])
  expect(Buffer.concat(got.slice(0, 2)).equals(big)).toBe(true)
  expect(got[2]!.equals(small)).toBe(true)
  expect(p.removed).toEqual([])
  await picks.done(owner)
  expect(p.disk.size).toBe(0)
  expect(picks.busy).toBe(false)
})

test('cancelled is an empty answer, not an error; another pick may follow', async () => {
  const p = phone(), picks = new PhotoPicks(p.io)
  const asked = picks.pick({ ...owner, limit: 1 })
  await tick(); p.cancel()
  expect(await asked).toEqual({ files: [], tooBig: [] })
  expect(picks.busy).toBe(false)
  const again = picks.pick({ ...owner, id: 'pick-request-2', limit: 1 })
  await tick(); p.cancel()
  expect((await again).files).toEqual([])
  // the same request id twice is refused (a replayed message)
  await expect(picks.pick({ ...owner, limit: 1 })).rejects.toThrow('photo_busy')
})

test('limits: a file over 50 MiB or past 200 MiB together is left out by name, other types and extras are dropped, and their copies go', async () => {
  const p = phone(), picks = new PhotoPicks(p.io)
  const asked = picks.pick({ ...owner, limit: 6 })
  await tick()
  const mib = 1024 * 1024
  p.pick([
    { name: 'a.jpg', mime: 'image/jpeg', size: 40 * mib }, { name: 'huge.mov', mime: 'video/quicktime', size: MAX_FILE_BYTES + 1 },
    { name: 'b.mov', mime: 'video/quicktime', size: 50 * mib }, { name: 'c.mov', mime: 'video/quicktime', size: 50 * mib },
    { name: 'page.html', mime: 'text/html', size: 10 }, { name: 'd.mov', mime: 'video/quicktime', size: 50 * mib },
    { name: 'e.jpg', mime: 'image/jpeg', size: 30 * mib }, { name: 'empty.jpg', mime: 'image/jpeg', size: 0 },
  ])
  const { files, tooBig } = await asked
  // 40 + 50 + 50 + 50 = 190 MiB; e.jpg would make it 220
  expect(files.map(f => f.name)).toEqual(['a.jpg', 'b.mov', 'c.mov', 'd.mov'])
  expect(files.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(MAX_PICK_BYTES)
  expect(tooBig).toEqual(['huge.mov', 'e.jpg'])
  expect(p.removed.map(u => u.split('-').slice(1).join('-')).sort()).toEqual(['e.jpg', 'empty.jpg', 'huge.mov', 'page.html'])
  expect(validPicks(files, tooBig, 6)).toBe(true)
  // more than asked for: the extras are dropped
  await picks.clear()
  const one = picks.pick({ ...owner, id: 'pick-request-3', limit: 1 })
  await tick()
  p.pick([{ name: 'x.jpg', mime: 'image/jpeg', size: 5 }, { name: 'y.jpg', mime: 'image/jpeg', size: 5 }])
  expect((await one).files.map(f => f.name)).toEqual(['x.jpg'])
})

test('a chunk out of order, from another document, or of the wrong length ends the pick and deletes the copies', async () => {
  for (const wrong of ['seq', 'index', 'offset', 'nonce', 'short'] as const) {
    const p = phone(), picks = new PhotoPicks(p.io)
    const asked = picks.pick({ ...owner, limit: 2 })
    await tick()
    p.pick([{ name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(20) }, { name: 'b.jpg', mime: 'image/jpeg', bytes: bytes(20) }])
    await asked
    const m = { ...owner, seq: 0, index: 0, offset: 0 }
    if (wrong === 'nonce') {
      // another document's request is no one's: the pick stays for its own
      await expect(picks.chunk({ ...m, nonce: 'b'.repeat(64) })).rejects.toThrow('photo_missing')
      await expect(picks.chunk({ ...m, generation: 2 })).rejects.toThrow('photo_missing')
      expect(Buffer.from(await picks.chunk(m), 'base64').length).toBe(20)
      continue
    }
    if (wrong === 'short') p.shortReads()
    const bad = wrong === 'seq' ? { ...m, seq: 1 } : wrong === 'index' ? { ...m, index: 1 } : wrong === 'offset' ? { ...m, offset: PICK_CHUNK_BYTES } : m
    await expect(picks.chunk(bad)).rejects.toThrow()
    expect(p.disk.size).toBe(0)
    await expect(picks.chunk(m)).rejects.toThrow('photo_missing')
  }
})

test('a fence while the picker is up: its answer is no one\'s and its copies go; no second picker until the first one closed', async () => {
  const p = phone(), picks = new PhotoPicks(p.io)
  const asked = picks.pick({ ...owner, limit: 1 })
  const failed = asked.then(() => null, e => (e as Error).message)
  await tick()
  await picks.clear()
  // the page's next document asks while the first picker is still on screen
  await expect(picks.pick({ ...owner, id: 'pick-request-2', generation: 2, limit: 1 })).rejects.toThrow('photo_busy')
  expect(p.launches()).toBe(1)
  p.pick([{ name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(5) }])
  expect(await failed).toBe('photo_cancelled')
  expect(p.disk.size).toBe(0)
  const next = picks.pick({ ...owner, id: 'pick-request-2', generation: 2, limit: 1 })
  await tick(); p.cancel()
  expect((await next).files).toEqual([])
})

test('60 seconds without a chunk end the pick (shortened here) and delete the copies', async () => {
  const p = phone(), picks = new PhotoPicks(p.io, 50)
  const asked = picks.pick({ ...owner, limit: 1 })
  await tick()
  p.pick([{ name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(5) }])
  await asked
  await Bun.sleep(90)
  expect(p.disk.size).toBe(0)
  await expect(picks.chunk({ ...owner, seq: 0, index: 0, offset: 0 })).rejects.toThrow('photo_missing')
})

const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.5', nonce: 'a'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PHOTO_PICK_CAPABILITY] }
function receiver(capabilities = config.capabilities) {
  const p = phone(), picks = new PhotoPicks(p.io)
  const io: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
  const r = new MobileReceiver('https://team.example', { ...config, capabilities }, new FileTransfers(io), async () => {}, undefined, undefined, undefined, undefined, picks)
  return { p, r, picks }
}

test('the receiver: only the team\'s current document on an app that offers photo-pick-v1 opens the picker; replies carry names and bytes', async () => {
  const off = receiver([...MOBILE_CAPABILITIES])
  expect(await off.r.receive(msg({ type: 'photo-pick', limit: 1 }), 'https://team.example/rooms/x')).toMatchObject({ ok: false, error: 'mobile_operation_failed' })
  expect(off.p.launches()).toBe(0)
  const { p, r } = receiver()
  for (const source of ['https://evil.example/', 'blob:https://team.example/x']) expect(await r.receive(msg({ type: 'photo-pick', limit: 1 }), source)).toBeNull()
  expect(await r.receive(msg({ type: 'photo-pick', limit: 1, nonce: 'b'.repeat(64) }), 'https://team.example/')).toBeNull()
  expect(p.launches()).toBe(0)
  const asked = r.receive(msg({ type: 'photo-pick', limit: 2 }), 'https://team.example/')
  await tick()
  p.pick([{ name: 'IMG_1.jpg', mime: 'image/jpeg', bytes: bytes(12) }])
  const reply = await asked
  expect(reply).toMatchObject({ ok: true, for: 'photo-pick', id: owner.id, files: [{ name: 'IMG_1.jpg', mime: 'image/jpeg', size: 12 }], tooBig: [] })
  const chunk = await r.receive(msg({ type: 'photo-chunk', seq: 0, index: 0, offset: 0 }), 'https://team.example/')
  expect(chunk).toMatchObject({ ok: true, for: 'photo-chunk', seq: 0 })
  expect(Buffer.from(chunk!.b64!, 'base64').equals(bytes(12))).toBe(true)
  expect(await r.receive(msg({ type: 'photo-done' }), 'https://team.example/')).toMatchObject({ ok: true })
  expect(p.disk.size).toBe(0)
})

test('the receiver: a session reset or a page change during the picker drops the answer and the copies; a refusal is named', async () => {
  const { p, r } = receiver()
  const asked = r.receive(msg({ type: 'photo-pick', limit: 1 }), 'https://team.example/')
  await tick()
  const reset = await r.receive(msg({ id: 'reset-request-1', type: 'session-reset' }), 'https://team.example/')
  expect(reset?.nextGeneration).toBe(2)
  p.pick([{ name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(5) }])
  expect(await asked).toBeNull()
  expect(p.disk.size).toBe(0)
  // a pick waiting for its chunks when the page goes away
  const second = receiver()
  const pending = second.r.receive(msg({ type: 'photo-pick', limit: 1 }), 'https://team.example/')
  await tick()
  second.p.pick([{ name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(5) }])
  expect((await pending)?.ok).toBe(true)
  await second.r.disable()
  expect(second.p.disk.size).toBe(0)
  // Android's older picker said no: the page hears photo_denied (a short message), nothing else about the phone
  const third = receiver()
  const denied = third.r.receive(msg({ type: 'photo-pick', limit: 1 }), 'https://team.example/')
  await tick()
  third.p.fail(new PhotoRefused('photo_denied'))
  expect(await denied).toMatchObject({ ok: false, error: 'photo_denied' })
  const fourth = receiver()
  const broken = fourth.r.receive(msg({ type: 'photo-pick', limit: 1 }), 'https://team.example/')
  await tick()
  fourth.p.fail(new Error('/private/var/mobile/secret path'))
  expect(await broken).toMatchObject({ ok: false, error: 'mobile_operation_failed' })
})

test('long names: shortened before the extension, never failing the pick; a type the list does not know keeps its own', () => {
  const cases: [string, string][] = [
    ['a'.repeat(200) + '.dng', 'image/x-adobe-dng'], ['b'.repeat(200) + '.HEIC', 'image/jpeg'], ['c'.repeat(300), 'image/x-adobe-dng'],
    ['x'.repeat(114) + '.  tail.dng', 'image/x-adobe-dng'], ['d' + '😀'.repeat(80) + '.dng', 'image/x-adobe-dng'], ['사진'.repeat(90) + '.mov', 'video/quicktime'],
    ['..' + 'e'.repeat(130) + '. .jpg', 'image/jpeg'], ['f'.repeat(119) + ' ', 'image/x-canon-cr3'],
  ]
  for (const [name, mime] of cases) {
    const out = pickedName(name, mime, 0)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(validPicks([{ name: out, mime, size: 1 }], [out], 1)).toBe(true)
  }
  expect(pickedName('a'.repeat(200) + '.dng', 'image/x-adobe-dng', 0)).toBe('a'.repeat(116) + '.dng')
  expect(pickedName('b'.repeat(200) + '.HEIC', 'image/jpeg', 0)).toBe('b'.repeat(116) + '.jpg')
  expect(pickedName('IMG_7.DNG', 'image/x-adobe-dng', 0)).toBe('IMG_7.dng')
  expect(pickedName('d' + '😀'.repeat(80) + '.dng', 'image/x-adobe-dng', 0)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
})

test('a long DNG name from Android goes through the receiver\'s check instead of failing the whole pick', async () => {
  const { p, r } = receiver()
  const asked = r.receive(msg({ type: 'photo-pick', limit: 2 }), 'https://team.example/')
  await tick()
  p.pick([{ name: 'RAW_' + 'z'.repeat(190) + '.dng', mime: 'image/x-adobe-dng', bytes: bytes(8) }, { name: 'ok.jpg', mime: 'image/jpeg', bytes: bytes(4) }])
  const reply = await asked
  expect(reply?.ok).toBe(true)
  expect(reply?.files?.map((f) => f.name)).toEqual(['RAW_' + 'z'.repeat(112) + '.dng', 'ok.jpg'])
})

test('one system sheet at a time, and none within 1.5 s after one closed: a page cannot reopen the picker or the share sheet without a tap', async () => {
  let now = 1000
  const gate = new SheetGate(SHEET_COOLDOWN_MS, () => now)
  const p = phone(), picks = new Picks(p.io, undefined, gate)
  const first = picks.pick({ ...owner, limit: 1 })
  await tick()
  // the share sheet waits for the picker
  await expect(gate.run(async () => 'shared')).rejects.toThrow('sheet_busy')
  p.cancel()
  expect((await first).files).toEqual([])
  // right after it closed: refused, and the picker does not open again
  now += SHEET_COOLDOWN_MS - 1
  await expect(picks.pick({ ...owner, id: 'pick-request-2', limit: 1 })).rejects.toThrow('photo_busy')
  await expect(gate.run(async () => 'shared')).rejects.toThrow('sheet_busy')
  expect(p.launches()).toBe(1)
  now += 1
  const again = picks.pick({ ...owner, id: 'pick-request-3', limit: 1 })
  await tick(); p.cancel()
  expect((await again).files).toEqual([])
  expect(p.launches()).toBe(2)
  // a share sheet closing starts the wait too
  now += SHEET_COOLDOWN_MS
  expect(await gate.run(async () => 'shared')).toBe('shared')
  await expect(picks.pick({ ...owner, id: 'pick-request-4', limit: 1 })).rejects.toThrow('photo_busy')
  // a picker that failed to open counts as closed as well
  now += SHEET_COOLDOWN_MS
  const failing = picks.pick({ ...owner, id: 'pick-request-5', limit: 1 })
  await tick(); p.fail(new Error('no view controller'))
  await expect(failing).rejects.toThrow('no view controller')
  expect(gate.ready).toBe(false)
})

test('a reply reaches only the document that asked: a page that came meanwhile (no bridge yet, or its own) drops it', () => {
  const reply = { v: 1 as const, type: 'mobile-result' as const, id: 'pick-request-1', nonce: 'a'.repeat(64), generation: 1, for: 'photo-chunk' as const, ok: true, seq: 0, b64: 'AAAA' }
  const run = (script: string, bridge: { nonce: string } | undefined) => {
    const heard: unknown[] = []
    const win = Object.assign(new EventTarget(), { mycelMobile: bridge, booted: 0 }) as EventTarget & { mycelMobile?: { nonce: string }; booted: number; top?: unknown; self?: unknown }
    win.top = win; win.self = win
    win.addEventListener('mycel:mobile', (e) => heard.push((e as CustomEvent).detail))
    expect(script.endsWith('true;')).toBe(true)
    new Function('window', 'CustomEvent', script)(win, CustomEvent)
    return { heard, booted: win.booted }
  }
  expect(run(replyScript(reply), { nonce: 'a'.repeat(64) }).heard).toEqual([reply])
  expect(run(replyScript(reply), undefined).heard).toEqual([])
  expect(run(replyScript(reply), { nonce: 'b'.repeat(64) }).heard).toEqual([])
  // a session reset's next config goes in only with its reply, on the same document
  const boot = 'window.booted++;'
  expect(run(replyScript({ ...reply, for: 'session-reset', nextGeneration: 2 }, boot), { nonce: 'a'.repeat(64) }).booted).toBe(1)
  expect(run(replyScript({ ...reply, for: 'session-reset', nextGeneration: 2 }, boot), { nonce: 'c'.repeat(64) }).booted).toBe(0)
  // the reply is data, never code
  const odd = { ...reply, error: "x'});alert(1);//</script>" }
  expect(run(replyScript(odd), { nonce: 'a'.repeat(64) }).heard).toEqual([odd])
})
