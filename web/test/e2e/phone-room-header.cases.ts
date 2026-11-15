// QA TC-257 on a phone (390×844, touch): a room's header and the file viewer's bars. The steps are the QA row's:
// 1. a room with a long name: ‹, the name with the member count under it, ✦ and ⋯ only; the bell's choices inside ⋯
//    (알림 설정, the level after it), the threads with new replies as ⋯'s first entry, no 이름 바꾸기 there (the name
//    opens the room's info, where it is changed), no entry twice;
// 2. an image, then a PDF from the room: the name (whole, two lines where long) and who sent it on top, the actions in a
//    bar at the bottom with 44 px targets; no zoom buttons and no arrows where a pinch or a swipe works (an HTML file,
//    whose frame keeps the finger, keeps its ‹ ›); Back closes the viewer and the room stays.
// Computers are unchanged (the bell, the thread button, 이름 바꾸기 in ⋯; the viewer's one bar on top). Each test runs in
// Chromium (Android's engine: phone-room-header.spec.ts) and WebKit (the iPhone app's: phone-room-header.webkit.spec.ts).
// SHOTS_DIR=<folder>: screenshots of each step.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const BEN = { id: 'ben', name: '벤' }
const SORA = { id: 'sora', name: '김소라' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const LONG_NAME = '2026 하반기 신규 고객사 온보딩 준비 태스크포스 디자인 리뷰'
const PDF_NAME = '트리나_2026년_11월_에이크미_견적서_최종본_v3.pdf'
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const HTML = '<!doctype html><html><body><h1>견적서</h1><p>합계 12,000,000원</p></body></html>'

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}-${test.info().project.name}-${page.context().browser()?.browserType().name()}.png` })
}
const file = (n: number, name: string, kind: string, mime: string, size: number, o: Record<string, unknown> = {}) => ({ id: id(n), name, size, mime, kind, thumb: false, ...o })

/** The group chat LONG_NAME (me, 벤, 김소라): 벤's photo (its thread has a reply, unread), his PDF, and an HTML quote;
 * the room says two threads have new replies. */
async function openRoom(page: Page) {
  await reset(page)
  await signIn(page)
  const pdf = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fhandbook.pdf&disposition=attachment&preview=true')).body())
  const bytes = new Map<string, { mime: string; body: Buffer }>([
    [id(501), { mime: 'image/png', body: PNG }],
    [id(502), { mime: 'application/pdf', body: pdf }],
    [id(503), { mime: 'text/html', body: Buffer.from(HTML) }],
  ])
  await routeRoom(page, {
    members: [BEN, SORA],
    room: { name: LONG_NAME, threadsUnread: 2, nextThreadId: id(1) },
    messages: [
      { id: id(1), author: BEN, body: '시안 사진이에요', extra: { files: [file(501, 'acme-시안.png', 'image', 'image/png', PNG.length, { width: 192, height: 192, thumb: true })], thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:05:00.000Z', repliers: [BEN], newReplies: true } } },
      { id: id(2), author: BEN, body: '견적서 보내요', extra: { files: [file(502, PDF_NAME, 'pdf', 'application/pdf', pdf.length)] } },
      { id: id(3), author: BEN, body: '웹 견적서도요', extra: { files: [file(503, 'acme-quote.html', 'text', 'text/html', HTML.length)] } },
      { id: id(4), author: SORA, body: '확인했어요', threadRootId: id(1) },
    ],
  })
  // the room's files, as the team server sends them (team-files/download.ts streamFile): a page as text, in a sandbox
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, async (route) => {
    const u = new URL(route.request().url())
    const f = bytes.get(u.pathname.split('/').pop()!)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found","message":"x"}}' })
    const download = u.searchParams.get('download') === '1'
    return route.fulfill({
      status: 200,
      body: f.body,
      headers: {
        'content-type': !download && f.mime === 'text/html' ? 'text/plain; charset=utf-8' : f.mime,
        'content-disposition': `${download ? 'attachment' : 'inline'}`,
        'x-content-type-options': 'nosniff',
        ...(f.mime === 'text/html' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      },
    })
  })
  // into the room from the 대화 tab, as a person goes: there is a page under it for Back
  await page.goto('/rooms')
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-scroller').getByTestId('room-message')).toHaveCount(3)
}

/** the test ids of the controls a finger can reach in `where` (drawn, not hidden) */
const visibleControls = (where: Locator) =>
  where.evaluate((el) => [...el.querySelectorAll<HTMLElement>('button, a[href]')]
    // seen on screen: a screen-reader-only button (sr-only, 1×1 px) is left out
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(b).visibility !== 'hidden' })
    .map((b) => b.dataset.testid ?? b.getAttribute('aria-label') ?? '?'))
const box = async (l: Locator) => (await l.boundingBox())!
/** not on screen, yet there for a screen reader (VoiceOver and TalkBack take the swipe, so they step with these) */
const forScreenReaders = async (l: Locator) => {
  await expect(l).toBeAttached()
  const b = await l.boundingBox()
  expect(b === null || (b.width <= 1 && b.height <= 1)).toBe(true)
  await expect(l).toHaveAccessibleName(/.+/)
}
const viewer = (page: Page) => page.getByTestId('image-viewer')
/** Back as the phone does it (the swipe, Android's Back): the history's own */
const back = (page: Page) => page.goBack({ waitUntil: 'commit' })

export function roomHeaderCases() {
  test('TC-257 step 1: a long-named room shows ‹, the name with the count under it, ✦ and ⋯; the bell is ⋯ › 알림 설정; no entry twice', async ({ page }) => {
    await openRoom(page)
    const header = page.getByTestId('room-header')
    await expect(page.getByTestId('room-title')).toHaveText(LONG_NAME)
    await shot(page, 'tc257-1-header')
    // ‹, the name, ✦ and ⋯ only: no bell, no thread button
    expect(await visibleControls(header)).toEqual(['room-back', 'room-members-button', 'room-side-chat-button', 'room-menu'])
    await expect(page.getByTestId('room-notify')).toHaveCount(0)
    await expect(page.getByTestId('room-next-thread')).toHaveCount(0)
    // the name has the width: everything between ‹ and ✦; the count under it, in the 48 px header
    const title = await box(page.getByTestId('room-title'))
    const count = await box(page.getByTestId('room-member-count'))
    const ask = await box(page.getByTestId('room-side-chat-button'))
    const backBox = await box(page.getByTestId('room-back'))
    expect(title.width).toBeGreaterThan(200)
    expect(ask.x - (title.x + title.width)).toBeLessThan(16)
    expect(title.x - (backBox.x + backBox.width)).toBeLessThan(12)
    await expect(page.getByTestId('room-member-count')).toHaveText('멤버 3명')
    expect(count.y).toBeGreaterThanOrEqual(title.y + title.height - 2)
    expect(Math.abs(count.x - title.x)).toBeLessThanOrEqual(1)
    const head = await box(header)
    expect(count.y + count.height).toBeLessThanOrEqual(head.y + head.height)
    // 44 px targets
    for (const b of [backBox, ask, await box(page.getByTestId('room-menu'))]) {
      expect(b.width).toBeGreaterThanOrEqual(44)
      expect(b.height).toBeGreaterThanOrEqual(44)
    }
    // ⋯ says there is something new inside: the threads with new replies, its first entry
    await expect(page.getByTestId('room-menu-dot')).toBeVisible()
    await expect(page.getByTestId('room-menu')).toHaveAccessibleName('더 보기, 새 답글이 있는 스레드 2개')
    await page.getByTestId('room-menu').tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await shot(page, 'tc257-1-menu')
    const items = menu.getByRole('menuitem')
    const ids = await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid))
    expect(ids).toEqual(['room-menu-next-thread', 'room-menu-pin', 'room-menu-notify', 'room-menu-apps', 'room-menu-link', 'room-menu-leave'])
    const labels = await items.allInnerTexts()
    expect(new Set(labels).size).toBe(labels.length)
    await expect(page.getByTestId('room-menu-rename')).toHaveCount(0)
    // 알림 설정 says the level now; it opens the four choices (the bell's), one sheet in place of the other
    await expect(page.getByTestId('room-menu-notify')).toHaveText(/알림 설정\s*· 모든 메시지/)
    await page.getByTestId('room-menu-notify').tap()
    await expect(page.getByRole('menuitemradio')).toHaveCount(4)
    await expect(page.getByRole('menu')).toHaveCount(1)
    await shot(page, 'tc257-1-notify')
    await page.getByTestId('room-notify-off').tap()
    await expect(page.getByRole('menu')).toHaveCount(0)
    // off: a crossed-out bell after the name, and ⋯ says so
    await expect(page.getByTestId('room-muted')).toBeVisible()
    await expect(page.getByTestId('room-muted')).toHaveAccessibleName('알림: 끄기')
    await page.getByTestId('room-menu').tap()
    await expect(page.getByTestId('room-menu-notify')).toHaveText(/알림 설정\s*· 끄기/)
    // Back closes the sheet, the room stays
    const roomUrl = page.url()
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)
    // the thread entry opens the newest thread with new replies
    await page.getByTestId('room-menu').tap()
    await page.getByTestId('room-menu-next-thread').tap()
    await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${id(1)}$`))
    await expect(page.getByTestId('room-thread').getByTestId('room-message')).toHaveCount(2)
    await back(page)
    await expect(page.getByTestId('room-thread')).toHaveCount(0)
    // the name opens the room's info, where the name is changed: the one 이름 바꾸기
    await page.getByTestId('room-members-button').tap()
    await expect(page.getByTestId('room-name')).toBeVisible()
    await expect(page.getByTestId('room-name')).toHaveAccessibleName(`이름 바꾸기: ${LONG_NAME}`)
  })

  test('TC-257 step 2: an image, then a PDF: the name and who on top, the actions in a bottom bar; no zoom or arrow buttons; Back closes', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    // the image
    await page.getByTestId('room-image').first().tap()
    await expect(viewer(page)).toHaveAttribute('data-mode', 'image')
    await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
    await shot(page, 'tc257-2-image')
    const top = page.getByTestId('image-viewer-bar')
    const bottom = page.getByTestId('image-viewer-actions')
    await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-시안.png')
    await expect(page.getByTestId('image-viewer-sent')).toContainText('벤')
    // on top: no buttons, only the name and the line under it
    expect(await visibleControls(top)).toEqual([])
    // at the bottom: "1 / 3", download, ✦, 💬 and ✕, each 44 px; nothing else anywhere (no zoom, no arrows, no 복사)
    await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 3')
    expect(await visibleControls(bottom)).toEqual(['image-viewer-download', 'image-viewer-ask-trina', 'image-viewer-thread', 'image-viewer-close'])
    expect(await visibleControls(viewer(page))).toEqual(['image-viewer-download', 'image-viewer-ask-trina', 'image-viewer-thread', 'image-viewer-close'])
    await targets(bottom)
    const b = await box(bottom)
    expect(Math.round(b.y + b.height)).toBe(844)
    expect((await box(page.getByTestId('image-viewer-count'))).y).toBeGreaterThan(844 - 80)
    // Back closes the viewer; the room stays
    await back(page)
    await expect(viewer(page)).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // the PDF
    await page.getByTestId('room-file').filter({ hasText: PDF_NAME }).getByTestId('room-file-open').tap()
    await expect(viewer(page)).toHaveAttribute('data-mode', 'file')
    await expect(viewer(page).locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
    await shot(page, 'tc257-2-pdf')
    // the whole name, on two lines at most, readable (not "트리나_…")
    const name = page.getByTestId('image-viewer-name')
    await expect(name).toHaveText(PDF_NAME)
    const lines = await name.evaluate((el) => ({ cut: el.scrollHeight > el.clientHeight + 1, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)) }))
    expect(lines.cut).toBe(false)
    expect(lines.lines).toBeLessThanOrEqual(2)
    expect((await box(name)).width).toBeGreaterThan(300)
    await expect(page.getByTestId('image-viewer-sent')).toContainText('벤')
    expect(await visibleControls(top)).toEqual([])
    await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 3')
    // a PDF pinches and swipes: no zoom toolbar, no arrows
    await expect(viewer(page).getByTestId('pdf-toolbar')).toBeHidden()
    expect(await visibleControls(viewer(page).getByTestId('image-viewer-actions'))).toEqual(['image-viewer-download', 'image-viewer-ask-trina', 'image-viewer-thread', 'image-viewer-close'])
    for (const t of ['image-viewer-prev', 'image-viewer-next']) await expect(page.getByTestId(t)).toBeHidden()
    // the bottom bar's step buttons stay for screen readers only
    for (const t of ['image-viewer-bar-prev', 'image-viewer-bar-next']) await forScreenReaders(page.getByTestId(t))
    await targets(bottom)
    // the document sits between the bars
    const body = await box(viewer(page).getByTestId('file-viewer-body'))
    const topBox = await box(top), bottomBox = await box(bottom)
    expect(body.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 1)
    expect(body.y + body.height).toBeLessThanOrEqual(bottomBox.y + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    // Back closes it; the room stays
    await back(page)
    await expect(viewer(page)).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // an HTML file: its frame keeps the finger, so its ‹ stays beside "3 / 3"
    await page.getByTestId('room-file').filter({ hasText: 'acme-quote.html' }).getByTestId('room-file-open').tap()
    await expect(viewer(page)).toHaveAttribute('data-mode', 'file')
    await expect(page.getByTestId('image-viewer-count')).toHaveText('3 / 3')
    await expect(page.getByTestId('image-viewer-bar-prev')).toBeVisible()
    await expect(page.getByTestId('image-viewer-prev')).toBeHidden()
    await targets(bottom)
    await page.getByTestId('image-viewer-bar-prev').tap()
    await expect(page.getByTestId('image-viewer-name')).toHaveText(PDF_NAME)
    await forScreenReaders(page.getByTestId('image-viewer-bar-prev'))
    // ✕ in the bottom bar closes it too
    await page.getByTestId('image-viewer-close').tap()
    await expect(viewer(page)).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)
  })

  test('TC-257, computers unchanged: the bell and the thread button in the header, 이름 바꾸기 in ⋯, the viewer\'s one bar on top', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openRoom(page)
    await expect(page.getByTestId('room-notify')).toBeVisible()
    await expect(page.getByTestId('room-next-thread')).toBeVisible()
    await expect(page.getByTestId('room-menu-dot')).toHaveCount(0)
    const title = await box(page.getByTestId('room-title'))
    const count = await box(page.getByTestId('room-member-count'))
    expect(Math.abs(count.y + count.height - (title.y + title.height))).toBeLessThan(6)
    expect(count.x).toBeGreaterThan(title.x + title.width)
    await page.getByTestId('room-menu').click()
    await expect(page.getByTestId('room-menu-rename')).toBeVisible()
    await expect(page.getByTestId('room-menu-notify')).toHaveText('알림 설정')
    await expect(page.getByTestId('room-menu-next-thread')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByTestId('room-file').filter({ hasText: PDF_NAME }).getByTestId('room-file-open').click()
    await expect(viewer(page)).toHaveAttribute('data-mode', 'file')
    await expect(page.getByTestId('image-viewer-actions')).toHaveCount(0)
    const top = page.getByTestId('image-viewer-bar')
    for (const t of ['image-viewer-count', 'image-viewer-download', 'image-viewer-panel', 'image-viewer-ask-trina', 'image-viewer-column', 'image-viewer-close']) await expect(top.getByTestId(t)).toBeVisible()
    await expect(page.getByTestId('image-viewer-prev')).toBeVisible()
    await expect(viewer(page).getByTestId('pdf-toolbar')).toBeVisible({ timeout: 15_000 })
  })
}

/** every control on screen in the bar is a 44 px target (a screen-reader-only one, 1×1 px, is not on screen) */
async function targets(bar: Locator) {
  const sizes = await bar.evaluate((el) => [...el.querySelectorAll<HTMLElement>('button')]
    .filter((b) => b.getBoundingClientRect().width > 1)
    .map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.testid, w: Math.round(r.width), h: Math.round(r.height) } }))
  expect(sizes.length).toBeGreaterThan(0)
  for (const s of sizes) {
    expect(s.w, `${s.id} width`).toBeGreaterThanOrEqual(44)
    expect(s.h, `${s.id} height`).toBeGreaterThanOrEqual(44)
  }
}
