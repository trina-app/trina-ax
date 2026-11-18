// The pictures of one model request, fitted before it goes on (server/src/proxy/fit-images.ts, limits audit #4,
// QA TC-4907): newest as sent, older ones smaller, the line moving in steps, the oldest out past one request's limits.
import { beforeEach, describe, expect, test } from 'bun:test'
import { MESSAGE_ATTACHMENTS_MAX, uuidv7 } from '@mycel/shared/api'
import { SendMessageBody } from '../../shared/src/api/chats'
import { FIT_DROPPED_NOTE, FIT_FULL_NEWEST, FIT_REQUEST_BYTES, FIT_REQUEST_IMAGES, FIT_STEP, fitCacheClear, fitRequestImages, type Shrink } from '../../server/src/proxy/fit-images'

const img = (tag: string, size = 300) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(tag.padEnd(size, '.')).toString('base64') } })
/** a request the engine sends after reading `n` photos one per step: each read is a tool_result with a text and a picture */
function request(n: number, size = 300) {
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'Look at all the photos.' }] }]
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { file_path: `p${i}.jpg` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: `Image p${i}.jpg` }, img(`photo-${i}`, size)] }] })
  }
  return { model: 'claude-sonnet-4-5', messages }
}
const pictures = (body: { messages: unknown[] }) => body.messages.flatMap((m) => ((m as { content: unknown[] }).content).flatMap((b) => {
  const x = b as { type: string; content?: unknown[]; text?: string; source?: { data: string } }
  const inner = x.type === 'tool_result' ? x.content! : [x]
  return inner.filter((y) => (y as { type: string }).type === 'image' || (y as { text?: string }).text === FIT_DROPPED_NOTE)
    .map((y) => ((y as { type: string }).type === 'image' ? Buffer.from((y as { source: { data: string } }).source.data, 'base64').toString().replace(/\.+$/, '') : 'dropped'))
}))
/** a fake converter: "small:<tag>" */
const shrinkCalls: string[] = []
const shrink: Shrink = async (b) => { const tag = b.toString().replace(/\.+$/, ''); shrinkCalls.push(tag); return Buffer.from(`small:${tag}`) }

beforeEach(() => { fitCacheClear(); shrinkCalls.length = 0 })

describe('fitting the pictures of one request', () => {
  test('no pictures, or few: the request is not touched', async () => {
    expect(await fitRequestImages({ messages: [{ role: 'user', content: 'hi' }] }, shrink)).toBeNull()
    const body = request(FIT_FULL_NEWEST + FIT_STEP - 1)
    const before = JSON.stringify(body)
    expect(await fitRequestImages(body, shrink)).toEqual({ images: FIT_FULL_NEWEST + FIT_STEP - 1, shrunk: 0, dropped: 0 })
    expect(JSON.stringify(body)).toBe(before)
  })

  test('60 photos: the newest go as they are, older ones smaller, nothing left out', async () => {
    const body = request(60)
    const r = await fitRequestImages(body, shrink)
    // the line moves in steps: (60 - 12) / 12 = 4 steps, so 48 smaller, 12 as sent
    expect(r).toEqual({ images: 60, shrunk: 48, dropped: 0 })
    const p = pictures(body)
    expect(p.slice(0, 48)).toEqual(Array.from({ length: 48 }, (_, i) => `small:photo-${i}`))
    expect(p.slice(48)).toEqual(Array.from({ length: 12 }, (_, i) => `photo-${48 + i}`))
    // a smaller copy is a JPEG
    const first = (body.messages[2] as { content: { content: { source?: { media_type: string } }[] }[] }).content[0]!.content[1]!
    expect(first.source!.media_type).toBe('image/jpeg')
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
    const calls = shrinkCalls.length
    expect(calls).toBe(24)
    await fitRequestImages(request(41), shrink)
    expect(shrinkCalls.length).toBe(calls)
  })

  test('past what one request may hold, the oldest give way to a note; the newest stay', async () => {
    const n = FIT_REQUEST_IMAGES + 10
    const body = request(n)
    const r = await fitRequestImages(body, shrink)
    expect(r!.dropped).toBe(FIT_STEP)
    const p = pictures(body)
    expect(p.filter((x) => x === 'dropped')).toHaveLength(FIT_STEP)
    expect(p.slice(0, FIT_STEP).every((x) => x === 'dropped')).toBe(true)
    expect(p.length - FIT_STEP).toBeLessThanOrEqual(FIT_REQUEST_IMAGES)
    expect(p[n - 1]).toBe(`photo-${n - 1}`)
  })

  test('too many bytes: more pictures smaller, newest last; a converter that cannot help lets the oldest go', async () => {
    const big = Math.ceil(FIT_REQUEST_BYTES / 10) // ten of these fill a request
    const body = request(FIT_FULL_NEWEST, big * 0.75) // base64 grows by 4/3
    const r = await fitRequestImages(body, shrink)
    expect(r!.dropped).toBe(0)
    expect(r!.shrunk).toBeGreaterThan(0)
    expect(pictures(body)[FIT_FULL_NEWEST - 1]).toBe(`photo-${FIT_FULL_NEWEST - 1}`)
    fitCacheClear()
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
    fitCacheClear()
    await expect(fitRequestImages(request(30), async () => { throw new Error('x') }, stop.signal)).rejects.toThrow('stopped')
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
