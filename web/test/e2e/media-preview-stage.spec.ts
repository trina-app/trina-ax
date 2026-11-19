// A video, a sound or a picture in a file view is on a dark stage of its own, as in Slack, Google Drive or Quick Look
// (QA TC-5367): in the room file viewer (from a room message, from a thread with the column open, on a phone) the
// stage fills the space left of the column, with no reading column (the paper a document is drawn on) and no grey and
// black bands beside it; the video is centred both ways and as large as fits, keeping its shape (landscape and
// portrait). The side panel (Files, the AI chat) draws the same stage in its body. A PDF keeps its paper column.
// The room is answered through page.route as the team server sends it (rooms-mock.ts), its files as streamFile does.
// SHOTS_DIR=<folder>: the screenshots (each context at 1440 and 390, light and dark) go there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openRail, reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const FIXTURES = path.resolve(import.meta.dirname, '../../../tests/fixtures/video')
// 640 x 360 and 360 x 640, two seconds (VP8: the browser Playwright ships plays no H.264), and two seconds of a tone
const WIDE = fs.readFileSync(path.join(FIXTURES, 'landscape.webm'))
const TALL = fs.readFileSync(path.join(FIXTURES, 'portrait.webm'))
const TONE = fs.readFileSync(path.join(FIXTURES, 'tone.ogg'))
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const at = (n: number) => new Date(Date.parse('2026-11-05T09:00:00.000Z') + n * 60_000).toISOString()
const file = (n: number, name: string, kind: string, mime: string, size: number) => ({ id: id(n), name, size, mime, kind, thumb: false })

/** The room "디자인 리뷰": Ben's landscape and portrait videos (with a thread whose reply has the tone), and a PDF. */
async function openRoom(page: Page, o: { at?: string } = {}) {
  await reset(page)
  await signIn(page)
  const pdf = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fhandbook.pdf&disposition=attachment&preview=true')).body())
  const bytes = new Map([
    [id(801), { mime: 'video/webm', body: WIDE }],
    [id(802), { mime: 'video/webm', body: TALL }],
    [id(803), { mime: 'audio/ogg', body: TONE }],
    [id(804), { mime: 'application/pdf', body: pdf }],
  ])
  await routeRoom(page, {
    members: [BEN],
    kind: 'team',
    messages: [
      { id: id(1), author: BEN, body: '촬영본 올려요', extra: { files: [
        file(801, 'acme-launch-wide.webm', 'video', 'video/webm', WIDE.length),
        file(802, 'acme-launch-phone.webm', 'video', 'video/webm', TALL.length),
      ], thread: { replyCount: 1, lastReplyAt: at(5), repliers: [BEN], newReplies: false } } },
      { id: id(2), author: BEN, body: '자료예요', extra: { files: [file(804, 'acme-handbook.pdf', 'pdf', 'application/pdf', pdf.length)] } },
      { id: id(3), author: BEN, body: '배경음이에요', threadRootId: id(1), extra: { files: [file(803, 'acme-jingle.ogg', 'audio', 'audio/ogg', TONE.length)] } },
    ],
  })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+$/, async (route) => {
    const f = bytes.get(new URL(route.request().url()).pathname.split('/').pop()!)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found","message":"x"}}' })
    return route.fulfill({ status: 200, body: f.body, headers: { 'content-type': f.mime, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' } })
  })
  await page.goto(o.at ?? `/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-scroller').getByTestId('room-message')).toHaveCount(2)
}

const timeline = (page: Page) => page.getByTestId('room-scroller')
const openChip = (where: Locator, name: string) => where.getByTestId('room-file').filter({ hasText: name }).getByTestId('room-file-open').click()
const viewer = (page: Page) => page.getByTestId('image-viewer')
const stage = (page: Page) => viewer(page).getByTestId('image-viewer-stage')
const playing = (video: Locator) => expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1)

/** Every box from `el` up to `until` is see-through or dark: no paper column, no light band behind the media. */
async function darkUpTo(el: Locator, until: string) {
  return el.evaluate((node, stop) => {
    const light: string[] = []
    for (let e: Element | null = node.parentElement; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor
      const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(bg)
      if (m && Number(m[4] ?? 1) > 0) {
        const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
        if (lum > 0.15) light.push(`${e.getAttribute('data-testid') ?? e.tagName}: ${bg}`)
      }
      if (e.matches(stop)) break
    }
    return light
  }, until)
}

/** The video is centred in `box` both ways and as large as fits, keeping its shape. */
async function centredAndFits(video: Locator, box: Locator, shape: number) {
  await playing(video)
  const v = (await video.boundingBox())!
  const b = (await box.boundingBox())!
  expect(Math.abs(v.x + v.width / 2 - (b.x + b.width / 2))).toBeLessThanOrEqual(1.5)
  expect(Math.abs(v.y + v.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(1.5)
  // its shape is the file's
  expect(Math.abs(v.width / v.height - shape)).toBeLessThan(0.02)
  // as large as fits: it reaches the stage's sides or its top and bottom, less the stage's own padding (≤ 32 px each)
  const gapX = b.width - v.width
  const gapY = b.height - v.height
  expect(Math.min(gapX, gapY)).toBeLessThanOrEqual(65)
  expect(gapX).toBeGreaterThanOrEqual(0)
  expect(gapY).toBeGreaterThanOrEqual(0)
}

test('a video from a room message is on a dark stage, centred and as large as fits; a portrait one too; a PDF keeps its column', async ({ page }) => {
  await openRoom(page)
  await openChip(timeline(page), 'acme-launch-wide.webm')
  await expect(viewer(page)).toHaveAttribute('data-mode', 'file')
  const video = viewer(page).getByTestId('preview-video')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('controls', '')
  // no reading column: the body is as wide as the stage (left of the 400 px column), nothing light behind the video
  const body = viewer(page).getByTestId('file-viewer-body')
  await expect(body).toHaveAttribute('data-renderer', 'media')
  expect((await body.boundingBox())!.width).toBe((await stage(page).boundingBox())!.width)
  expect(await darkUpTo(video, '[data-viewer-stage]')).toEqual([])
  await centredAndFits(video, viewer(page).getByTestId('media-stage'), 640 / 360)
  // → the portrait one: as tall as fits, centred
  await stage(page).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-launch-phone.webm')
  await centredAndFits(viewer(page).getByTestId('preview-video'), viewer(page).getByTestId('media-stage'), 360 / 640)
  expect(await darkUpTo(viewer(page).getByTestId('preview-video'), '[data-viewer-stage]')).toEqual([])
  // a smaller window: still centred and whole
  await page.setViewportSize({ width: 900, height: 560 })
  await centredAndFits(viewer(page).getByTestId('preview-video'), viewer(page).getByTestId('media-stage'), 360 / 640)
  await page.setViewportSize({ width: 1440, height: 900 })
  // → the PDF: its pages on the 960 px reading column, as before
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-handbook.pdf')
  await expect(viewer(page).locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  expect((await viewer(page).getByTestId('file-viewer-body').boundingBox())!.width).toBe(960)
})

test('from a thread with the column open: the video and the sound are centred on the dark stage beside it', async ({ page }) => {
  await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
  const thread = page.getByTestId('thread-scroller')
  await openChip(thread, 'acme-launch-wide.webm')
  await expect(viewer(page).getByTestId('viewer-column')).toBeVisible()
  const video = viewer(page).getByTestId('preview-video')
  await centredAndFits(video, viewer(page).getByTestId('media-stage'), 640 / 360)
  expect(await darkUpTo(video, '[data-viewer-stage]')).toEqual([])
  // the stage stops at the column: the video is left of it
  const col = (await viewer(page).getByTestId('viewer-column').boundingBox())!
  const v = (await video.boundingBox())!
  expect(v.x + v.width).toBeLessThanOrEqual(col.x)
  // the reply's sound: its player centred on the same stage
  await stage(page).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-jingle.ogg')
  const audio = viewer(page).getByTestId('preview-audio')
  await expect(audio).toBeVisible()
  const a = (await audio.boundingBox())!
  const s = (await viewer(page).getByTestId('media-stage').boundingBox())!
  expect(Math.abs(a.x + a.width / 2 - (s.x + s.width / 2))).toBeLessThanOrEqual(1.5)
  expect(Math.abs(a.y + a.height / 2 - (s.y + s.height / 2))).toBeLessThanOrEqual(1.5)
  expect(await darkUpTo(audio, '[data-viewer-stage]')).toEqual([])
})

test('in the side panel (Files, the AI chat) the video is on the same dark stage, centred in the panel body', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const up = await page.request.post('/api/files/upload', { multipart: { folder: 'marketing', file: { name: 'acme-launch-wide.webm', mimeType: 'video/webm', buffer: WIDE } }, headers: { 'x-mycel-csrf': '1' } })
  expect(up.status()).toBe(201)
  await page.goto('/files/view?path=marketing%2Facme-launch-wide.webm')
  const panel = page.getByTestId('file-panel')
  const video = panel.getByTestId('preview-video')
  await centredAndFits(video, panel.getByTestId('media-stage'), 640 / 360)
  // the stage fills the panel's body (under its header): nothing light around the video in it
  expect(await darkUpTo(video, '[data-testid="media-stage"]')).toEqual([])
  const fills = await panel.getByTestId('media-stage').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const p = el.parentElement!.getBoundingClientRect()
    return [r.width - p.width, r.height - p.height].map((n) => Math.round(Math.abs(n)))
  })
  expect(fills).toEqual([0, 0])
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a portrait video fills the screen between the bars, centred; a landscape one sits in the middle', async ({ page }) => {
    await openRoom(page)
    await page.getByTestId('room-scroller').getByTestId('room-file').filter({ hasText: 'acme-launch-phone.webm' }).getByTestId('room-file-open').tap()
    await centredAndFits(viewer(page).getByTestId('preview-video'), viewer(page).getByTestId('media-stage'), 360 / 640)
    expect(await darkUpTo(viewer(page).getByTestId('preview-video'), '[data-viewer-stage]')).toEqual([])
    await page.getByTestId('image-viewer-close').tap()
    await page.getByTestId('room-scroller').getByTestId('room-file').filter({ hasText: 'acme-launch-wide.webm' }).getByTestId('room-file-open').tap()
    await centredAndFits(viewer(page).getByTestId('preview-video'), viewer(page).getByTestId('media-stage'), 640 / 360)
  })
})

/** a picture of the page, once the media has its first frame and the pointer is off the bar */
async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR!
  const m = page.locator('[data-testid="preview-video"]:visible').first()
  if (await m.count()) await playing(m)
  await page.mouse.move(5, 450).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${dir}/${name}.png` })
}

for (const scheme of ['light', 'dark'] as const)
  test(`screenshots of media previews, ${scheme} (SHOTS_DIR)`, async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'only with SHOTS_DIR')
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: scheme })
    // from a room message
    await openRoom(page)
    await openChip(timeline(page), 'acme-launch-wide.webm')
    await shot(page, `room-video-wide-1440-${scheme}`)
    await stage(page).focus()
    await page.keyboard.press('ArrowRight')
    await shot(page, `room-video-tall-1440-${scheme}`)
    await page.keyboard.press('ArrowRight')
    await expect(viewer(page).locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
    await shot(page, `room-pdf-1440-${scheme}`)
    await page.keyboard.press('Escape')
    // from a thread, the column open
    await page.goto(`/rooms/${ROOM_ID}/t/${id(1)}`)
    await openChip(page.getByTestId('thread-scroller'), 'acme-launch-wide.webm')
    await shot(page, `thread-video-wide-1440-${scheme}`)
    await stage(page).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await shot(page, `thread-audio-1440-${scheme}`)
    await page.keyboard.press('Escape')
    // a small window
    await page.setViewportSize({ width: 820, height: 520 })
    await openChip(page.getByTestId('thread-scroller'), 'acme-launch-phone.webm')
    await shot(page, `thread-video-tall-820x520-${scheme}`)
    await page.keyboard.press('Escape')
    // a phone width
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/rooms/${ROOM_ID}`)
    await openChip(timeline(page), 'acme-launch-phone.webm')
    await shot(page, `room-video-tall-390-${scheme}`)
    await page.getByTestId('image-viewer-close').click()
    await openChip(timeline(page), 'acme-launch-wide.webm')
    await shot(page, `room-video-wide-390-${scheme}`)
    await page.getByTestId('image-viewer-close').click()
    // Files' side panel, and the AI chat's
    await page.setViewportSize({ width: 1440, height: 900 })
    const up = await page.request.post('/api/files/upload', { multipart: { folder: 'marketing', file: { name: 'acme-launch-wide.webm', mimeType: 'video/webm', buffer: WIDE } }, headers: { 'x-mycel-csrf': '1' } })
    expect([201, 409]).toContain(up.status())
    await page.request.post('/api/files/upload', { multipart: { folder: 'marketing', file: { name: 'acme-launch-pic.png', mimeType: 'image/png', buffer: PNG } }, headers: { 'x-mycel-csrf': '1' } })
    await page.goto('/files/view?path=marketing%2Facme-launch-wide.webm')
    await expect(page.getByTestId('file-panel').getByTestId('preview-video')).toBeVisible()
    await shot(page, `files-video-1440-${scheme}`)
    await page.goto('/files/view?path=marketing%2Facme-launch-pic.png')
    await expect(page.getByTestId('file-panel-image')).toBeVisible()
    await shot(page, `files-image-1440-${scheme}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/files/view?path=marketing%2Facme-launch-wide.webm')
    await expect(page.getByTestId('preview-video').first()).toBeVisible()
    await shot(page, `files-video-390-${scheme}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openRail(page, 'ai')
    await page.getByTestId('file-input').setInputFiles({ name: 'acme-launch-phone.webm', mimeType: 'video/webm', buffer: TALL })
    const chip = page.getByTestId('attachment-chip').first()
    await expect(chip).toHaveAttribute('data-status', 'done')
    await chip.getByRole('button').first().click()
    await expect(page.getByTestId('file-panel').getByTestId('preview-video')).toBeVisible()
    await shot(page, `chat-video-tall-1440-${scheme}`)
  })
