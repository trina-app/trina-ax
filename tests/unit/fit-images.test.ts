// The pictures of one model request, fitted before it goes on (server/src/proxy/fit-images.ts, limits audit #4,
// QA TC-4907): newest as sent, older ones smaller, the lines moving in steps, the oldest out past one request's limits.
import { beforeEach, describe, expect, test } from 'bun:test'
import { MESSAGE_ATTACHMENTS_MAX, uuidv7 } from '@mycel/shared/api'
import { SendMessageBody } from '../../shared/src/api/chats'
import { droppedNote, FIT_DROPPED_NOTE, FIT_FULL_NEWEST, FIT_REQUEST_BYTES, FIT_REQUEST_IMAGES, FIT_STEP, FIT_WAIT_MS, fitCacheClear, fitRequestImages, type Shrink } from '../../server/src/proxy/fit-images'

const TAG = 32
/** a picture: its tag first (what the fake converter and the checks read), then filler; `size` raw bytes */
const pictureBytes = (tag: string, size: number, random = false) => {
  const fill = random ? Buffer.from(crypto.getRandomValues(new Uint8Array(Math.max(0, size - TAG)))) : Buffer.alloc(Math.max(0, size - TAG), '.')
  return Buffer.concat([Buffer.from(tag.padEnd(TAG, '.')), fill])
}
const img = (tag: string, size = 300, random = false) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pictureBytes(tag, size, random).toString('base64') } })
/** a request the engine sends after reading `n` photos one per step: each read is a tool_result with the read's own
 * text ("Image <path> (shown below).") and a picture */
function request(n: number, size = 300, random = false) {
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'Look at all the photos.' }] }]
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { file_path: `p${i}.jpg` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: `Image users/a/p${i}.jpg (shown below).` }, img(`photo-${i}`, size, random)] }] })
  }
  return { model: 'claude-sonnet-4-5', messages }
}
const tagOf = (b: Buffer) => b.subarray(0, TAG).toString('latin1').replace(/\.+$/, '')
const isNote = (t?: string) => !!t && (t.startsWith('[The picture of ') || t === FIT_DROPPED_NOTE)
const pictures = (body: { messages: unknown[] }) => body.messages.flatMap((m) => ((m as { content: unknown[] }).content).flatMap((b) => {
  const x = b as { type: string; content?: unknown[]; text?: string }
  const inner = x.type === 'tool_result' ? x.content! : [x]
  return inner.filter((y) => (y as { type: string }).type === 'image' || isNote((y as { text?: string }).text))
    .map((y) => ((y as { type: string }).type === 'image' ? tagOf(Buffer.from((y as { source: { data: string } }).source.data, 'base64')) : 'dropped'))
}))
const bytesOf = (body: { messages: unknown[] }) => JSON.stringify(body).length
/** a fake converter: "small:<tag>", `size` bytes */
const shrinkCalls: string[] = []
const fake = (size = 64): Shrink => async (b) => { const tag = tagOf(b); shrinkCalls.push(tag); return pictureBytes(`small:${tag}`, size) }
const shrink = fake()

beforeEach(() => { fitCacheClear(); shrinkCalls.length = 0 })

describe('fitting the pictures of one request', () => {
  test('no pictures, or few: the request is not touched', async () => {
    expect(await fitRequestImages({ messages: [{ role: 'user', content: 'hi' }] }, shrink)).toBeNull()
    const body = request(FIT_FULL_NEWEST + FIT_STEP - 1)
    const before = JSON.stringify(body)
    expect(await fitRequestImages(body, shrink)).toEqual({ images: FIT_FULL_NEWEST + FIT_STEP - 1, shrunk: 0, dropped: 0, pending: 0 })
    expect(JSON.stringify(body)).toBe(before)
  })

  test('60 photos: the newest go as they are, older ones smaller, nothing left out', async () => {
    const body = request(60)
    const r = await fitRequestImages(body, shrink)
    // the line moves in steps: (60 - 12) / 12 = 4 steps, so 48 smaller, 12 as sent
    expect(r).toEqual({ images: 60, shrunk: 48, dropped: 0, pending: 0 })
    const p = pictures(body)
    expect(p.slice(0, 48)).toEqual(Array.from({ length: 48 }, (_, i) => `small:photo-${i}`))
    expect(p.slice(48)).toEqual(Array.from({ length: 12 }, (_, i) => `photo-${48 + i}`))
    const first = (body.messages[2] as { content: { content: { source?: { media_type: string } }[] }[] }).content[0]!.content[1]!
    expect(first.source!.media_type).toBe('image/jpeg')
  })

  test('60 real-size photos (about 1 MB each, 80 MB of base64): the request goes on within the provider limit', async () => {
    const body = request(60, 1024 ** 2, true)
    expect(bytesOf(body)).toBeGreaterThan(64 * 1024 ** 2)
    const r = await fitRequestImages(body, fake(110_000))
    expect(r!.dropped).toBe(0)
    expect(bytesOf(body)).toBeLessThan(FIT_REQUEST_BYTES + 1024 ** 2)
    // the byte limit took the newest block too, as one block (the line moves in steps of FIT_STEP, never one by one)
    expect(r!.shrunk % FIT_STEP).toBe(0)
  })

  test('byte pressure moves in blocks: one more picture does not change the start of the request', async () => {
    const at = async (n: number) => { const b = request(n, 1024 ** 2); const r = await fitRequestImages(b, fake(110_000)); return { p: pictures(b), r: r! } }
    const a = await at(FIT_FULL_NEWEST + FIT_STEP * 2 + 2)
    const b = await at(FIT_FULL_NEWEST + FIT_STEP * 2 + 3)
    // the byte limit was reached: past the older 24, one more block of 12 went smaller
    expect(a.r.shrunk).toBe(3 * FIT_STEP)
    expect(b.p.slice(0, a.p.length)).toEqual(a.p)
  })

  test('the line between full and smaller moves only every FIT_STEP pictures (the cached start stays the same)', async () => {
    const at = async (n: number) => { fitCacheClear(); const b = request(n); await fitRequestImages(b, shrink); return pictures(b).filter((x) => x.startsWith('small:')).length }
    expect(await at(FIT_FULL_NEWEST + FIT_STEP)).toBe(FIT_STEP)
    expect(await at(FIT_FULL_NEWEST + FIT_STEP + 1)).toBe(FIT_STEP)
    expect(await at(FIT_FULL_NEWEST + 2 * FIT_STEP - 1)).toBe(FIT_STEP)
    expect(await at(FIT_FULL_NEWEST + 2 * FIT_STEP)).toBe(2 * FIT_STEP)
  })

  test('each picture is made smaller once; the next request uses the copy', async () => {
    await fitRequestImages(request(40), shrink)
    expect(shrinkCalls.length).toBe(24)
    await fitRequestImages(request(41), shrink)
    expect(shrinkCalls.length).toBe(24)
  })

  test('"cannot be made smaller" is kept; a conversion that did not finish (busy, a limit) is tried again', async () => {
    let calls = 0
    await fitRequestImages(request(24), async () => { calls++; return null })
    await fitRequestImages(request(24), async () => { calls++; return null })
    expect(calls).toBe(12)
    fitCacheClear()
    let busy = true
    const flaky: Shrink = async (b) => { if (busy) throw new Error('too many image conversions'); return pictureBytes(`small:${tagOf(b)}`, 64) }
    const one = request(24)
    expect((await fitRequestImages(one, flaky))!.shrunk).toBe(0)
    busy = false
    const two = request(24)
    expect((await fitRequestImages(two, flaky))!.shrunk).toBe(12)
  })

  test('a slow converter does not hold the request: pictures still being made go as they are, the next request uses them', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow: Shrink = async (b) => { await gate; return pictureBytes(`small:${tagOf(b)}`, 64) }
    const t0 = Date.now()
    const first = request(24)
    const r = await fitRequestImages(first, slow)
    expect(Date.now() - t0).toBeLessThan(FIT_WAIT_MS + 1000)
    expect(r!.shrunk).toBe(0)
    expect(r!.pending).toBe(12)
    expect(pictures(first)[0]).toBe('photo-0')
    release()
    await Bun.sleep(20)
    const second = request(24)
    expect((await fitRequestImages(second, slow))!.shrunk).toBe(12)
    expect(pictures(second)[0]).toBe('small:photo-0')
  })

  test('past what one request may hold, the oldest give way to a note that names their file; the newest stay', async () => {
    const n = FIT_REQUEST_IMAGES + 10
    const body = request(n)
    const r = await fitRequestImages(body, shrink)
    expect(r!.dropped).toBe(FIT_STEP)
    const p = pictures(body)
    expect(p.slice(0, FIT_STEP).every((x) => x === 'dropped')).toBe(true)
    expect(p.length - FIT_STEP).toBeLessThanOrEqual(FIT_REQUEST_IMAGES)
    expect(p[n - 1]).toBe(`photo-${n - 1}`)
    const note = (body.messages[2] as { content: { content: { text?: string }[] }[] }).content[0]!.content[1]!
    expect(note.text).toBe(droppedNote('users/a/p0.jpg'))
    expect(note.text).toContain('users/a/p0.jpg')
  })

  test('a converter that cannot help lets the oldest go until it fits; the newest stays', async () => {
    const big = Math.ceil(FIT_REQUEST_BYTES / 10)
    const stuck = request(FIT_FULL_NEWEST, big * 0.75)
    const none = await fitRequestImages(stuck, async () => null)
    expect(none!.shrunk).toBe(0)
    expect(none!.dropped).toBeGreaterThan(0)
    const left = pictures(stuck)
    expect(left[left.length - 1]).toBe(`photo-${FIT_FULL_NEWEST - 1}`)
  })

  test('a converter that fails keeps the picture as it is; a stop is passed on', async () => {
    const body = request(30)
    const r = await fitRequestImages(body, async () => { throw new Error('converter down') })
    expect(r!.shrunk).toBe(0)
    expect(pictures(body)).toEqual(Array.from({ length: 30 }, (_, i) => `photo-${i}`))
    const stop = new AbortController()
    stop.abort(new Error('stopped'))
    await expect(fitRequestImages(request(30), shrink, stop.signal)).rejects.toThrow('stopped')
  })

  test('pictures straight in a user message count too; cache_control stays on a dropped picture', async () => {
    const body = request(FIT_REQUEST_IMAGES + 1)
    const first = img('pasted');
    (first as { cache_control?: unknown }).cache_control = { type: 'ephemeral' }
    ;(body.messages[0] as { content: unknown[] }).content.push(first)
    await fitRequestImages(body, shrink)
    const note = (body.messages[0] as { content: { type: string; text?: string; cache_control?: unknown }[] }).content[1]!
    expect(note).toEqual({ type: 'text', text: FIT_DROPPED_NOTE, cache_control: { type: 'ephemeral' } })
  })
})

test('60 photos fit in one message (attachments per message: what one request may hold in pictures)', () => {
  expect(MESSAGE_ATTACHMENTS_MAX).toBe(100)
  const ids = (n: number) => Array.from({ length: n }, () => uuidv7())
  expect(SendMessageBody.safeParse({ content: 'What is in these photos?', clientMessageId: uuidv7(), attachmentIds: ids(60) }).success).toBe(true)
  expect(SendMessageBody.safeParse({ content: 'x', clientMessageId: uuidv7(), attachmentIds: ids(MESSAGE_ATTACHMENTS_MAX + 1) }).success).toBe(false)
})
