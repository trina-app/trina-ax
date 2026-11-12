// The phone app's own photo picker for 사진 보관함 (photo-pick-v1, QA TC-251: one picker per row, no second iOS menu).
// On the iPhone an input that takes pictures first shows WebKit's small menu (Photo Library / Take Photo / Choose
// File); the app from 1.0.5 opens PHPicker itself and hands the files over the bridge, and the page puts them through
// the box's usual upload. Playwright cannot drive PHPicker, so a fake app answers the bridge the way mobile/src/photos.ts
// does: the picked files' names, types and sizes, then their bytes in 1 MiB chunks, then done. Without the capability
// (an older app) the row opens its input, as before. The app's own half is in tests/unit/mobile-photos.test.ts.
// QA TC-251: the real picker answers many seconds after the sheet closed. The Android app took a step of the page's
// history meanwhile for a new page (react-native-webview reports it as a load start) and fenced its bridge: the pick
// was dropped and, 10 s later, the bridge came back with a new nonce, which the page took as "moved on": nothing
// attached, no word. `androidPage` makes the fake app do the same; the sheet's back-off now waits for the pick.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, routeRooms } from './rooms-mock'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TrinaAX/1.0.5'
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
/** a "video" over one chunk, so its bytes come in two */
const CLIP = Buffer.from(Array.from({ length: 1024 * 1024 + 4096 }, (_, i) => (i * 13) & 255))
const BEN = { id: 'ben', name: '벤' }

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: IPHONE_UA })

type Picked = { name: string; mime: string; b64: string }
type Win = {
  mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[]; nextPick: { files: Picked[]; tooBig: string[] }
  /** ms the picker takes before it answers (the person picking) */
  pickMs: number
  /** the Android app's load start: a step of the page's history while a pick is on fences the bridge (the answer is
   * dropped) and installs it again with a new nonce a moment later (the app's 10 s, shortened) */
  androidPage: boolean
  /** history steps the app saw while a pick was on, and the answers it dropped for them */
  fenced: number
}

/** The app's bridge as the page sees it. `photos`: it offers photo-pick-v1; the person picks `nextPick` (set per test). */
async function app(page: Page, photos: boolean, o: { iosShim?: boolean } = {}) {
  await page.addInitScript(({ photos, iosShim }) => {
    const w = window as unknown as Win
    w.mycelMobile = { protocol: 1, appVersion: '1.0.5', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', ...(photos ? ['photo-pick-v1'] : [])] }
    w.mobileMessages = []
    w.nextPick = { files: [], tooBig: [] }
    w.pickMs = 150; w.androidPage = false; w.fenced = 0
    let picked: Picked[] = []
    let picking: ReturnType<typeof setTimeout> | null = null
    // iPhone build 9: react-native-webview's history shim (at document start, under the page's own wrappers) reports
    // every pushState, replaceState and popstate as a load end, and the app installed its bridge again for it: a new
    // nonce and mycel:mobile-ready a moment later; an answer to the old nonce is dropped (MobileReceiver)
    if (iosShim) {
      w.fenced = 0
      const loadEnd = () => setTimeout(() => {
        if (picking) w.fenced++
        w.mycelMobile = { ...w.mycelMobile, nonce: String(w.fenced % 10).repeat(32) + 'f'.repeat(32), generation: w.mycelMobile.generation + 1 }
        window.dispatchEvent(new Event('mycel:mobile-ready'))
      }, 15)
      const push = history.pushState, replace = history.replaceState
      history.pushState = function (...a: Parameters<History['pushState']>) { setTimeout(loadEnd, 0); return push.apply(history, a) }
      history.replaceState = function (...a: Parameters<History['replaceState']>) { setTimeout(loadEnd, 0); return replace.apply(history, a) }
      window.addEventListener('popstate', () => setTimeout(loadEnd, 0))
    }
    window.addEventListener('popstate', () => {
      if (!w.androidPage || !picking) return
      clearTimeout(picking); picking = null; w.fenced++
      setTimeout(() => {
        w.mycelMobile = { ...w.mycelMobile, nonce: 'b'.repeat(64), generation: w.mycelMobile.generation + 1 }
        window.dispatchEvent(new Event('mycel:mobile-ready'))
      }, 300)
    })
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.mobileMessages.push(m)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      if (m.type === 'photo-pick') {
        picked = w.nextPick.files
        reply.files = picked.map((f) => ({ name: f.name, mime: f.mime, size: atob(f.b64).length }))
        reply.tooBig = w.nextPick.tooBig
      }
      if (m.type === 'photo-chunk') reply.b64 = btoa(atob(picked[m.index]!.b64).slice(m.offset, m.offset + 1024 * 1024))
      // the picker takes a moment; the page waits for each answer
      const send = () => {
        if (iosShim && (m.nonce !== w.mycelMobile.nonce || m.generation !== w.mycelMobile.generation)) return
        window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply }))
      }
      if (m.type === 'photo-pick') picking = setTimeout(() => { picking = null; send() }, w.pickMs)
      else setTimeout(send, 0)
    } }
  }, { photos, iosShim: !!o.iosShim })
}
const pickNext = (page: Page, files: { name: string; mime: string; bytes: Buffer }[], tooBig: string[] = []) =>
  page.evaluate((next) => { (window as unknown as Win).nextPick = next }, { files: files.map((f) => ({ name: f.name, mime: f.mime, b64: f.bytes.toString('base64') })), tooBig })
const phoneLike = (page: Page, pickMs: number) => page.evaluate((pickMs) => { const w = window as unknown as Win; w.pickMs = pickMs; w.androidPage = true }, pickMs)
const isOverlayEntry = (page: Page) => page.evaluate(() => typeof (history.state as Record<string, unknown> | null)?.mycelOverlay === 'number')
const heard = (page: Page) => page.evaluate(() => (window as unknown as Win).mobileMessages.filter((m) => m.type.startsWith('photo-')))

/** Taps 사진 보관함 in the box's sheet; counts the file choosers that opened meanwhile. */
async function photoLibrary(page: Page, button: string) {
  let choosers = 0
  const count = () => { choosers++ }
  page.on('filechooser', count)
  await page.getByTestId(button).click()
  const sheet = page.getByRole('menu', { name: '파일 첨부' })
  await expect(sheet.getByRole('menuitem')).toHaveText(['사진 보관함', '사진 찍기', '파일', '팀 파일'])
  await page.getByTestId('attach-photos').click()
  await expect(sheet).toHaveCount(0)
  return { choosers: async () => { await page.waitForTimeout(400); page.off('filechooser', count); return choosers } }
}

test("the app's picker in an AI chat: no input, no iOS menu; the picked photo and video land in the attachments", async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }, { name: 'clip.mov', mime: 'video/quicktime', bytes: CLIP }])
  const opened = await photoLibrary(page, 'attach-button')
  const chips = page.getByTestId('attachment-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toContainText('IMG_0001.png')
  await expect(chips.nth(1)).toContainText('clip.mov')
  for (const i of [0, 1]) await expect(chips.nth(i)).toHaveAttribute('data-status', 'done')
  expect(await opened.choosers()).toBe(0)
  // what the page asked the app: as many as a message takes, the bytes in order (the video in two chunks), then done
  const asked = await heard(page)
  expect(asked[0]).toMatchObject({ type: 'photo-pick', limit: 20 })
  expect(asked.slice(1).map((m) => (m.type === 'photo-chunk' ? `${m.index}@${m.offset}` : m.type))).toEqual(['0@0', '1@0', `1@${1024 * 1024}`, 'photo-done'])
  // the button is the box's again once the bytes are in
  await expect(page.getByTestId('attach-button')).toHaveAccessibleName('파일 첨부')

  // cancelled in the picker: nothing added, no message
  await pickNext(page, [])
  await photoLibrary(page, 'attach-button')
  await expect.poll(async () => (await heard(page)).filter((m) => m.type === 'photo-pick').length).toBe(2)
  await page.waitForTimeout(300)
  await expect(chips).toHaveCount(2)
  await expect(page.getByText('사진을 가져오지 못했어요')).toHaveCount(0)

  // a video over the bridge's 50 MB: left out, the other photo comes; an AI chat takes bigger files, so the message
  // offers the input (WebKit's picker reaches the library and has no such limit)
  await pickNext(page, [{ name: 'IMG_0002.png', mime: 'image/png', bytes: PNG }], ['long-video.mov'])
  await photoLibrary(page, 'attach-button')
  const note = page.getByTestId('toast').filter({ hasText: 'long-video.mov은(는) 커서 여기서는 넣을 수 없어요. 다른 방법으로 골라 주세요.' })
  await expect(note).toBeVisible()
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(2)).toHaveAttribute('data-status', 'done')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), note.getByTestId('toast-action').click()])
  expect(await chooser.element().getAttribute('data-testid')).toBe('attach-photos-input')
  await chooser.setFiles([{ name: 'long-video.mov', mimeType: 'video/quicktime', buffer: CLIP }])
  await expect(chips).toHaveCount(4)
  await expect(chips.nth(3)).toContainText('long-video.mov')
  await expect(note).toHaveCount(0)
})

test("the app's picker in a room: the picked photo is uploaded to the room as the input's would be", async ({ page, browserName }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  await routeRoom(page, { members: [BEN] })
  const uploads: Buffer[] = []
  await page.route(`**/api/rooms/${ROOM_ID}/files`, (r) => {
    uploads.push(r.request().postDataBuffer() ?? Buffer.alloc(0))
    return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '019a5f00-0000-7000-8000-000000000701', name: 'IMG_0001.png', size: PNG.length, mime: 'image/png', kind: 'image', thumb: false }) })
  })
  await page.goto(`/rooms/${ROOM_ID}`)
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }])
  const opened = await photoLibrary(page, 'room-attach')
  const chip = page.getByTestId('room-file-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-status', 'done')
  expect(await opened.choosers()).toBe(0)
  // the room's box takes 10 files; the upload carries the photo's name and its exact bytes
  expect((await heard(page))[0]).toMatchObject({ type: 'photo-pick', limit: 10 })
  expect(uploads).toHaveLength(1)
  expect(uploads[0]!.includes(Buffer.from('filename="IMG_0001.png"'))).toBe(true)
  const body = uploads[0]!.toString('latin1')
  expect(body).toContain(`name="size"\r\n\r\n${PNG.length}\r\n`)
  expect(body).toMatch(/filename="IMG_0001\.png"\r\nContent-Type: image\/png/)
  // WebKit's route shows no file part's bytes; Chromium's does
  if (browserName === 'chromium') expect(uploads[0]!.includes(PNG)).toBe(true)
  // a room takes 50 MB a file at most: a bigger one is only named, with no other way offered
  await pickNext(page, [], ['long-video.mov'])
  await photoLibrary(page, 'room-attach')
  const note = page.getByTestId('toast').filter({ hasText: 'long-video.mov은(는) 커서 넣지 못했어요.' })
  await expect(note).toBeVisible()
  await expect(note.getByTestId('toast-action')).toHaveCount(0)
})

test('an older app (no photo-pick-v1): 사진 보관함 opens its input, as before, and the app hears nothing', async ({ page }) => {
  await reset(page)
  await app(page, false)
  await signIn(page)
  await page.getByTestId('attach-button').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('attach-photos').click()])
  expect(await chooser.element().getAttribute('data-testid')).toBe('attach-photos-input')
  expect(chooser.isMultiple()).toBe(true)
  await chooser.setFiles([{ name: 'IMG_0003.png', mimeType: 'image/png', buffer: PNG }])
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
  expect(await heard(page)).toEqual([])
})

test('QA TC-251: the picker answers seconds after the sheet closed; no history step meanwhile, so the Android app keeps the pick and the photo lands', async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  await routeRoom(page, { members: [BEN] })
  await page.route(`**/api/rooms/${ROOM_ID}/files`, (r) => r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '019a5f00-0000-7000-8000-000000000701', name: 'IMG_0001.png', size: PNG.length, mime: 'image/png', kind: 'image', thumb: false }) }))
  await page.goto(`/rooms/${ROOM_ID}`)
  await phoneLike(page, 2500)
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }])
  await photoLibrary(page, 'room-attach')
  // the picker is up: the closed sheet's entry stays, the button spins
  await page.waitForTimeout(1200)
  expect(await isOverlayEntry(page)).toBe(true)
  await expect(page.getByTestId('room-attach')).toHaveAccessibleName('사진을 가져오고 있어요')
  const chip = page.getByTestId('room-file-chip')
  await expect(chip).toHaveCount(1, { timeout: 8000 })
  await expect(chip).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => (window as unknown as Win).fenced)).toBe(0)
  // once the bytes are in, the sheet's entry goes (Back leaves the room again, not a closed sheet)
  await expect.poll(() => isOverlayEntry(page)).toBe(false)
  await expect(page.getByTestId('room-attach')).toHaveAccessibleName('파일 첨부')
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

test('a pick the page lost anyway (the app put its bridge in again) says so instead of nothing; a cancelled one stays quiet', async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }])
  await page.evaluate(() => { (window as unknown as Win).pickMs = 5000 })
  await photoLibrary(page, 'attach-button')
  await page.waitForTimeout(300)
  // the app's bridge again with a new nonce while the picker is up (as after a new page)
  await page.evaluate(() => {
    const w = window as unknown as Win
    w.mycelMobile = { ...w.mycelMobile, nonce: 'c'.repeat(64), generation: w.mycelMobile.generation + 1 }
    window.dispatchEvent(new Event('mycel:mobile-ready'))
  })
  await expect(page.getByTestId('toast').filter({ hasText: '사진을 가져오지 못했어요' })).toBeVisible()
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  await expect(page.getByTestId('attach-button')).toHaveAccessibleName('파일 첨부')
})

test('a pick started in one room does not land in the next room opened before its bytes came', async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  const A = '019a5f00-0000-7000-8000-00000000b001', B = '019a5f00-0000-7000-8000-00000000b002'
  await routeRooms(page, [
    { id: A, kind: 'group', name: '디자인 리뷰', peers: [BEN], ago: 5, last: '안녕하세요' },
    { id: B, kind: 'group', name: '주간 회의', peers: [BEN], ago: 9, last: '내일 봬요' },
  ])
  const uploads: string[] = []
  await page.route('**/api/rooms/*/files', (r) => { uploads.push(r.request().url()); return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '019a5f00-0000-7000-8000-000000000701', name: 'IMG_0001.png', size: PNG.length, mime: 'image/png', kind: 'image', thumb: false }) }) })
  await page.goto(`/rooms/${A}`)
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }])
  await page.evaluate(() => { (window as unknown as Win).pickMs = 1500 })
  await photoLibrary(page, 'room-attach')
  // the other room, opened by the app's router (a notification's tap) while the picker is up
  await page.evaluate((b) => { history.pushState({ idx: 99, key: 'other', usr: null }, '', `/rooms/${b}`); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })) }, B)
  await expect(page).toHaveURL(new RegExp(`/rooms/${B}$`))
  await expect(page.getByTestId('room-attach')).toBeVisible()
  await page.waitForTimeout(2500)
  await expect(page.getByTestId('room-file-chip')).toHaveCount(0)
  expect(uploads).toEqual([])
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

test('QA TC-251 on the iPhone (build 9): its history shim turns the sheet\'s step into a new bridge; held, the pick survives and lands', async ({ page }) => {
  await reset(page)
  await app(page, true, { iosShim: true })
  await signIn(page)
  await routeRoom(page, { members: [BEN] })
  await page.route(`**/api/rooms/${ROOM_ID}/files`, (r) => r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '019a5f00-0000-7000-8000-000000000701', name: 'IMG_0001.png', size: PNG.length, mime: 'image/png', kind: 'image', thumb: false }) }))
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.evaluate(() => { (window as unknown as Win).pickMs = 2500 })
  await pickNext(page, [{ name: 'IMG_0001.png', mime: 'image/png', bytes: PNG }])
  await page.waitForTimeout(500)
  await page.getByTestId('room-attach').click()
  // a person's tap comes after the bridge the sheet's opening brought (the shim's step of its entry)
  await page.waitForTimeout(400)
  await page.getByTestId('attach-photos').click()
  const chip = page.getByTestId('room-file-chip')
  await expect(chip).toHaveCount(1, { timeout: 8000 })
  await expect(chip).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => (window as unknown as Win).fenced)).toBe(0)
  await expect(page.getByTestId('toast')).toHaveCount(0)
})
