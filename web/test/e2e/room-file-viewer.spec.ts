// The room file viewer (components/ImageViewer.tsx's document mode, components/ViewerDocument.tsx): a file chip's name
// in a room, DM, group chat or thread opens the file over the whole window, like Slack, in the same list as the pane's
// pictures. A PDF shows its pages (FileBody, the side panel's body, read through the room), ← → walk the pictures and
// files together in message order ("1 / 5"), the bar says who sent it, when and where ("#디자인 리뷰에서"), and has the
// download, 패널에서 열기 and ✕. A file with no preview here (a ZIP, a Hangul file while the HWP preview is off) is its
// card at once, with nothing read; a download-only file is the card too, never drawn. A file whose message is deleted
// while open says it is no longer available. Esc, ✕ and Back close it and focus goes back to the chip; the chip's own
// icon still downloads. A thread's files are its own list. A sheet keeps its tabs in view; a team file named in a
// document opens the side panel and the viewer gives way. On a phone it is the whole screen. The room is answered
// through page.route as the team server sends it (rooms-mock.ts), its files as streamFile does. Every view passes axe.
// On computers the file's conversation is beside it (components/rooms/ViewerColumn.tsx, step c): its message's thread,
// where a reply goes to the room's thread; ✦ switches to my Trina side chat with the file quoted, "스레드로 돌아가기"
// back; the side chat stays across ← →; the bar's toggle hides the column. On a phone ✦ opens the room page's side chat.
// The side chat there takes a pasted picture, and the room page's side chat shows the same one.
// SHOTS_DIR=<folder>: the screenshots (a PDF with its thread at 1440 light, the Trina side chat at 1440 dark, the column
// hidden at 1440 light, a PDF at 390 light, a Hangul file at 1440 dark) go there.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Download, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
// the notes name a team file: a link that opens the side panel
const MD = '# acme 회의 메모\n\n- 첫째\n- 둘째\n\n[핸드북](/files/view?path=docs/handbook.pdf)\n'
const REPLY_MD = '# acme 답장 메모\n\n스레드에 붙인 메모예요.\n'
// a 192 x 192 picture (the app's own icon)
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const HWP = fs.readFileSync(path.resolve(import.meta.dirname, '../../../tests/fixtures/hwp/two-pages.hwp'))
const HELD = '이 파일은 안전 검사 때문에 내려받기만 할 수 있어요.'

type Bytes = { name: string; mime: string; body: Buffer; held?: boolean }
const file = (n: number, name: string, kind: string, mime: string, size: number, o: Record<string, unknown> = {}) => ({ id: id(n), name, size, mime, kind, thumb: false, ...o })
const at = (n: number) => new Date(Date.parse('2026-11-05T09:00:00.000Z') + n * 60_000).toISOString()

/** The room "디자인 리뷰" (a team room): Ben's PDF and photo, then a ZIP and notes, then a file held by the safety check
 * (download only), and a reply in the first message's thread with its own notes; with `hwp`, a Hangul form as well, and
 * with `sheet` a workbook of two sheets, one of 80 rows. */
async function openRoom(page: Page, o: { at?: string; hwp?: boolean; sheet?: boolean; link?: boolean } = {}) {
  await reset(page)
  await signIn(page)
  // the mock's own PDF, served as a room file
  const pdf = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fhandbook.pdf&disposition=attachment&preview=true')).body())
  // the mock's own workbook (요약, and 매출 with 80 rows)
  const xlsx = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fsources%2Fbudget.xlsx&disposition=attachment&preview=true')).body())
  if (o.hwp) {
    // the mock draws a team file's pages with the repo's pinned renderer (prepare:hwp); the room's address answers with
    // those pages, as the team server answers it from the same renderer
    const up = await page.request.post('/api/files/upload', { multipart: { folder: 'marketing', file: { name: 'room-form.hwp', mimeType: 'application/octet-stream', buffer: HWP } }, headers: { 'x-mycel-csrf': '1' } })
    expect(up.status()).toBe(201)
  }
  const bytes = new Map<string, Bytes>([
    [id(502), { name: 'acme-handbook.pdf', mime: 'application/pdf', body: pdf }],
    [id(503), { name: 'acme-logo.png', mime: 'image/png', body: PNG }],
    [id(504), { name: 'acme-notes.md', mime: 'text/markdown', body: Buffer.from(MD) }],
    [id(505), { name: 'acme-assets.zip', mime: 'application/zip', body: Buffer.from('PK\x03\x04 zip') }],
    [id(507), { name: 'acme-held.pdf', mime: 'application/pdf', body: pdf, held: true }],
    [id(508), { name: 'acme-reply.md', mime: 'text/markdown', body: Buffer.from(REPLY_MD) }],
    [id(601), { name: 'acme-신청서.hwp', mime: 'application/x-hwp', body: HWP }],
    [id(701), { name: 'acme-budget.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: xlsx }],
  ])
  const room = await routeRoom(page, {
    members: [BEN],
    kind: 'team',
    messages: [
      { id: id(1), author: BEN, body: '자료 올려요', extra: { files: [
        file(502, 'acme-handbook.pdf', 'pdf', 'application/pdf', pdf.length),
        file(503, 'acme-logo.png', 'image', 'image/png', PNG.length, { width: 192, height: 192, thumb: true }),
      ], thread: { replyCount: 1, lastReplyAt: at(5), repliers: [BEN], newReplies: false } } },
      { id: id(2), author: BEN, body: '압축 파일이랑 메모예요', extra: { files: [
        file(505, 'acme-assets.zip', 'other', 'application/zip', 10),
        file(504, 'acme-notes.md', 'text', 'text/markdown', MD.length),
      ] } },
      { id: id(3), author: BEN, body: '검사 중인 파일', extra: { files: [file(507, 'acme-held.pdf', 'pdf', 'application/pdf', pdf.length)] } },
      ...(o.hwp ? [{ id: id(6), author: BEN, body: '신청서 양식이에요', extra: { files: [file(601, 'acme-신청서.hwp', 'other', 'application/x-hwp', HWP.length)] } }] : []),
      ...(o.sheet ? [{ id: id(7), author: BEN, body: '예산표예요', extra: { files: [file(701, 'acme-budget.xlsx', 'spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx.length)] } }] : []),
      { id: id(4), author: BEN, body: '메모 하나 더', threadRootId: id(1), extra: { files: [file(508, 'acme-reply.md', 'text', 'text/markdown', REPLY_MD.length)] } },
      // a reply naming a team file (a link that opens the side panel)
      ...(o.link ? [{ id: id(8), author: BEN, body: `원본은 여기 있어요: ${new URL(test.info().project.use.baseURL!).origin}/files/view?path=docs%2Fhandbook.pdf`, threadRootId: id(1) }] : []),
    ],
  })
  // the room's files, as the team server sends them (team-files/download.ts streamFile): inline a page is text with the
  // sandbox CSP, download=1 an attachment; a held file is download only (the inline read answers 503 quarantined, as
  // RoomFiles.open does); the room's member check is the server's (tests/unit/b-rooms.test.ts)
  const served: string[] = []
  const pages: string[] = []
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, async (route) => {
    const u = new URL(route.request().url())
    const hwpPage = /\/files\/([^/]+)\/hwp-preview$/.exec(u.pathname)
    if (hwpPage) {
      pages.push(u.search)
      const r = await route.fetch({ url: `/api/files/hwp-preview?path=${encodeURIComponent('marketing/room-form.hwp')}&page=${u.searchParams.get('page')}` })
      return route.fulfill({ response: r })
    }
    const f = bytes.get(u.pathname.split('/').pop()!)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found","message":"x"}}' })
    const download = u.searchParams.get('download') === '1'
    served.push(`${f.name}${u.search}`)
    if (f.held && !download) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: HELD, params: { reason: 'quarantined' } } }) })
    const active = /html|svg|xml|javascript/.test(f.mime)
    return route.fulfill({
      status: 200,
      body: f.body,
      headers: {
        'content-type': !download && active ? 'text/plain; charset=utf-8' : f.mime,
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.name)}"`,
        'x-content-type-options': 'nosniff',
        ...(f.mime === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
      },
    })
  })
  await page.goto(o.at ?? `/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-scroller').getByTestId('room-message')).toHaveCount(3 + (o.hwp ? 1 : 0) + (o.sheet ? 1 : 0))
  return { served, pages, room }
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

const timeline = (page: Page) => page.getByTestId('room-scroller')
const chip = (where: Locator, name: string) => where.getByTestId('room-file').filter({ hasText: name })
const openChip = (where: Locator, name: string) => chip(where, name).getByTestId('room-file-open').click()
const viewer = (page: Page) => page.getByTestId('image-viewer')
const fileDialog = (page: Page, name: string) => page.getByRole('dialog', { name: `파일 보기: ${name}` })
const pdfPages = (page: Page) => viewer(page).locator('.react-pdf__Page canvas')
const card = (page: Page) => viewer(page).getByTestId('file-viewer-card')
/** a download of the room file `n` as an attachment (the room's address, download=1) */
const isRoomDownload = (d: Download, n: number) => {
  const u = new URL(d.url())
  return u.pathname === `/api/rooms/${ROOM_ID}/files/${id(n)}` && u.searchParams.get('download') === '1'
}

test('a PDF from a room message opens in the viewer: its pages, who, when and where; ← → to the photo and back', async ({ page }) => {
  const { served } = await openRoom(page)
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
  await expect(viewer(page)).toHaveAttribute('aria-modal', 'true')
  await expect(viewer(page)).toHaveAttribute('data-mode', 'file')
  // not the side panel: the viewer draws the pages itself, with the PDF's own toolbar (zoom, fit to width)
  await expect(page.getByTestId('file-panel')).toHaveCount(0)
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  await expect(viewer(page).getByTestId('pdf-toolbar')).toBeVisible()
  // in the reading column, under the bar: as wide as 960 px at most, centred in the stage left of the 400 px column
  const body = (await viewer(page).getByTestId('file-viewer-body').boundingBox())!
  expect(body.width).toBe(960)
  expect(body.x).toBe(40)
  expect(body.y).toBe(56)
  expect(await viewer(page).getByTestId('viewer-column').boundingBox()).toEqual({ x: 1040, y: 56, width: 400, height: 844 })
  // the bar: the name, who sent it, when and where, where it is in the room's list (pictures and files together)
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-handbook.pdf')
  await expect(page.getByTestId('image-viewer-sent')).toContainText('벤')
  await expect(page.getByTestId('image-viewer-sent').locator('time')).toHaveCount(1)
  await expect(page.getByTestId('image-viewer-where')).toHaveText('#디자인 리뷰에서')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 5')
  // its actions: download, 패널에서 열기, ✕; no picture zoom, 복사 or new tab
  await expect(page.getByTestId('image-viewer-download')).toBeVisible()
  await expect(page.getByTestId('image-viewer-panel')).toHaveAccessibleName('패널에서 열기')
  for (const t of ['image-viewer-zoom', 'image-viewer-copy', 'image-viewer-open']) await expect(page.getByTestId(t)).toHaveCount(0)
  await expect(page.getByTestId('image-viewer-next')).toHaveAccessibleName('다음 이미지')
  await audit(page, 'viewer with a PDF')
  // the bytes were read through the room, inline
  expect(served).toContain('acme-handbook.pdf')
  // the bar's download is the room's, as an attachment
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('image-viewer-download').click()])
  expect(isRoomDownload(d, 502)).toBe(true)
  // → the photo of the same message, on the picture stage; ← back to the PDF
  await viewer(page).getByTestId('image-viewer-stage').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
  await expect(viewer(page)).toHaveAttribute('data-mode', 'image')
  await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 5')
  await expect(page.getByTestId('image-viewer-zoom')).toBeVisible()
  await expect(page.getByTestId('image-viewer-where')).toHaveText('#디자인 리뷰에서')
  await expect(page.getByTestId('image-viewer-panel')).toHaveCount(0)
  await expect(page.getByTestId('image-viewer-prev')).toHaveAccessibleName('이전 파일')
  await page.keyboard.press('ArrowLeft')
  await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 5')
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  // the keys go on working after the step (the focus is in the viewer, on the document)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(fileDialog(page, 'acme-assets.zip')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(fileDialog(page, 'acme-notes.md')).toBeVisible()
  await expect(viewer(page).getByRole('heading', { name: 'acme 회의 메모' })).toBeVisible()
  await audit(page, 'viewer with Markdown')
})

test('Esc and Back close it, and focus goes back to the chip; 패널에서 열기 opens the side panel instead', async ({ page }) => {
  await openRoom(page)
  const open = chip(timeline(page), 'acme-handbook.pdf').getByTestId('room-file-open')
  await open.click()
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await expect(open).toBeFocused()
  // Back closes it and stays on the room
  await open.click()
  await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
  await page.goBack()
  await expect(viewer(page)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
  await expect(timeline(page).getByTestId('room-message')).toHaveCount(3)
  // ✕
  await open.click()
  await page.getByTestId('image-viewer-close').click()
  await expect(viewer(page)).toHaveCount(0)
  // 패널에서 열기: the viewer closes and the side panel shows the same file beside the room, where it stays
  await open.click()
  await page.getByTestId('image-viewer-panel').click()
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByTestId('file-panel').getByTestId('file-panel-title')).toHaveText('acme-handbook.pdf')
  await expect(page.getByTestId('file-panel').locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('file-panel')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
})

test("the chip's download icon still downloads, without opening anything", async ({ page }) => {
  await openRoom(page)
  for (const [name, n] of [['acme-handbook.pdf', 502], ['acme-assets.zip', 505]] as const) {
    const dl = chip(timeline(page), name).getByTestId('room-file-download')
    await expect(dl).toHaveAccessibleName(`${name} 내려받기`)
    const [d] = await Promise.all([page.waitForEvent('download'), dl.click()])
    expect(d.suggestedFilename()).toBe(name)
    expect(isRoomDownload(d, n)).toBe(true)
  }
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByTestId('file-panel')).toHaveCount(0)
})

test('a ZIP shows its card at once, nothing read; a download-only file shows the card with the reason, no preview', async ({ page }) => {
  const { served } = await openRoom(page)
  await openChip(timeline(page), 'acme-assets.zip')
  await expect(fileDialog(page, 'acme-assets.zip')).toBeVisible()
  await expect(card(page)).toBeVisible()
  await expect(card(page).getByTestId('file-viewer-card-name')).toHaveText('acme-assets.zip')
  await expect(card(page)).toContainText('ZIP · ')
  await expect(card(page).getByTestId('file-viewer-card-note')).toHaveText('이 형식은 미리 볼 수 없어요. 내려받아서 열어 주세요.')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('3 / 5')
  await audit(page, 'a file with no preview')
  const [zip] = await Promise.all([page.waitForEvent('download'), card(page).getByTestId('file-viewer-card-download').click()])
  expect(isRoomDownload(zip, 505)).toBe(true)
  // nothing of it was read inline
  expect(served.filter((s) => s === 'acme-assets.zip')).toEqual([])
  // the held PDF: the inline read is refused (503 quarantined), so no page is drawn; the card says why; download stays
  await page.keyboard.press('Escape')
  await openChip(timeline(page), 'acme-held.pdf')
  await expect(fileDialog(page, 'acme-held.pdf')).toBeVisible()
  await expect(card(page).getByTestId('file-viewer-card-note')).toHaveText(HELD)
  await expect(viewer(page).locator('.react-pdf__Document')).toHaveCount(0)
  await expect(viewer(page).getByTestId('file-viewer-body')).toHaveAttribute('data-renderer', 'card')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('5 / 5')
  // the AI is refused its bytes too: no 트리나에게 묻기
  await expect(page.getByTestId('image-viewer-ask-trina')).toHaveCount(0)
  const [held] = await Promise.all([page.waitForEvent('download'), card(page).getByTestId('file-viewer-card-download').click()])
  expect(isRoomDownload(held, 507)).toBe(true)
  // the keys still step from the card (the focus stayed in the viewer)
  await page.keyboard.press('ArrowLeft')
  await expect(fileDialog(page, 'acme-notes.md')).toBeVisible()
})

test("a thread's files are its own list: its root's and its replies', not the timeline's", async ({ page }) => {
  await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
  const thread = page.getByTestId('thread-scroller')
  await expect(chip(thread, 'acme-reply.md')).toBeVisible()
  await openChip(thread, 'acme-reply.md')
  await expect(fileDialog(page, 'acme-reply.md')).toBeVisible()
  await expect(viewer(page).getByRole('heading', { name: 'acme 답장 메모' })).toBeVisible()
  // the root's PDF and photo, then the reply's notes
  await expect(page.getByTestId('image-viewer-count')).toHaveText('3 / 3')
  await expect(page.getByTestId('image-viewer-next')).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 3')
  await page.keyboard.press('ArrowLeft')
  await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(chip(thread, 'acme-reply.md').getByTestId('room-file-open')).toBeFocused()
})

test('a sheet keeps its tabs in view below its rows, as in the side panel', async ({ page }) => {
  await openRoom(page, { sheet: true })
  await openChip(timeline(page), 'acme-budget.xlsx')
  await expect(fileDialog(page, 'acme-budget.xlsx')).toBeVisible()
  const tabs = viewer(page).getByRole('tablist')
  await expect(tabs).toBeVisible()
  await viewer(page).getByRole('tab', { name: '매출' }).click()
  await expect(viewer(page).locator('[data-sheet="매출"]')).toContainText('m80')
  // 80 rows: the rows scroll inside, the tabs stay at the column's foot, inside the window
  const bar = (await tabs.boundingBox())!
  const body = (await viewer(page).getByTestId('file-viewer-body').boundingBox())!
  expect(bar.y + bar.height).toBeLessThanOrEqual(body.y + body.height + 1)
  expect(bar.y + bar.height).toBeLessThanOrEqual(900)
  await audit(page, 'viewer with a sheet')
})

test('a team file named in a room document opens in the side panel: the viewer gives way to it', async ({ page }) => {
  await openRoom(page)
  await openChip(timeline(page), 'acme-notes.md')
  await expect(viewer(page).getByRole('heading', { name: 'acme 회의 메모' })).toBeVisible()
  await viewer(page).getByTestId('team-file-chip').click()
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByTestId('file-panel').getByTestId('file-panel-title')).toHaveText('handbook.pdf')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('file-panel')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
})

test('a file whose message is deleted while it is open says it is no longer available; ← → still step', async ({ page }) => {
  const { served } = await openRoom(page)
  await openChip(timeline(page), 'acme-notes.md')
  await expect(viewer(page).getByRole('heading', { name: 'acme 회의 메모' })).toBeVisible()
  expect(served).toContain('acme-notes.md')
  // the message goes (the server's live event, as a delete by its sender sends it)
  const gone = { id: id(2), roomId: ROOM_ID, seq: 2, authorKind: 'user', author: BEN, askedBy: null, visibility: 'room', body: '', replyTo: null, mentions: [], files: [], createdAt: at(2), editedAt: null, deletedAt: at(30) }
  const r = await page.request.post('/__test/publish', { data: { event: { type: 'room.message.updated', data: { roomId: ROOM_ID, message: gone } } } })
  expect(r.ok()).toBeTruthy()
  await expect(card(page).getByTestId('file-viewer-card-note')).toHaveText('메시지가 삭제되어 이 파일은 더 이상 볼 수 없어요.')
  await expect(viewer(page).getByRole('heading', { name: 'acme 회의 메모' })).toHaveCount(0)
  // nothing more of it: no download, no side panel
  await expect(card(page).getByTestId('file-viewer-card-download')).toHaveCount(0)
  await expect(page.getByTestId('image-viewer-download')).toHaveCount(0)
  await expect(page.getByTestId('image-viewer-panel')).toHaveCount(0)
  // the photo before it and the held PDF after it are still a step away (the ZIP went with the message)
  await page.keyboard.press('ArrowRight')
  await expect(fileDialog(page, 'acme-held.pdf')).toBeVisible()
  await expect(page.getByTestId('image-viewer-count')).toHaveText('3 / 3')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
})

test('a Hangul file shows its pages while the HWP preview is on; off, its card, with no page asked for', async ({ page }) => {
  const { pages } = await openRoom(page, { hwp: true })
  const hwpChip = chip(timeline(page), 'acme-신청서.hwp')
  await expect(hwpChip).toHaveAttribute('data-opens', '')
  await openChip(timeline(page), 'acme-신청서.hwp')
  await expect(fileDialog(page, 'acme-신청서.hwp')).toBeVisible()
  const img = viewer(page).getByTestId('hwp-page')
  await expect(img).toBeVisible({ timeout: 20_000 })
  await expect(img).toHaveJSProperty('naturalWidth', 794)
  await expect(viewer(page).getByTestId('hwp-view')).toContainText('1 / 2쪽')
  await viewer(page).getByTestId('hwp-next').click()
  await expect(viewer(page).getByTestId('hwp-view')).toContainText('2 / 2쪽')
  expect(pages).toEqual(['?page=1', '?page=2'])
  await audit(page, 'viewer with a room HWP')
  await page.keyboard.press('Escape')
  // the plugin off (Me without hwpPreview): the name opens the card, and no page is asked for
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch()
    const me = await res.json()
    delete me.server.hwpPreview
    return route.fulfill({ response: res, json: me })
  })
  await page.reload()
  await expect(timeline(page).getByTestId('room-message')).toHaveCount(4)
  await expect(hwpChip).not.toHaveAttribute('data-opens', '')
  await openChip(timeline(page), 'acme-신청서.hwp')
  await expect(card(page).getByTestId('file-viewer-card-note')).toHaveText('이 형식은 미리 볼 수 없어요. 내려받아서 열어 주세요.')
  await expect(viewer(page).getByTestId('hwp-view')).toHaveCount(0)
  const [d] = await Promise.all([page.waitForEvent('download'), card(page).getByTestId('file-viewer-card-download').click()])
  expect(isRoomDownload(d, 601)).toBe(true)
  expect(pages).toHaveLength(2)
})

// ---- the column beside the file (step c) ----

const column = (page: Page) => viewer(page).getByTestId('viewer-column')
const stageBox = async (page: Page) => (await viewer(page).getByTestId('image-viewer-stage').boundingBox())!
/** the POST of a question to a side chat (the mock team server's /api/chats/:id/messages) */
const sideQuestion = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))

test("the file's thread is beside it; a reply from the viewer is in the room's thread, which the viewer leaves whole", async ({ page }) => {
  const { room } = await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
  const pageThread = page.getByTestId('room-thread')
  await expect(pageThread.getByTestId('room-message')).toHaveCount(2)
  // the PDF from the timeline: its message is the thread's root, the thread the page shows too
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(column(page)).toHaveAttribute('data-show', 'thread')
  await expect(column(page)).toHaveAccessibleName('스레드')
  await expect(column(page).getByTestId('room-message')).toHaveCount(2)
  await expect(column(page).getByTestId('thread-count')).toHaveText('답글 1개')
  await expect(column(page).getByTestId('thread-room')).toHaveText('디자인 리뷰')
  // the focus stays on the file (the column's box does not take it)
  await expect(column(page).getByTestId('room-input')).not.toBeFocused()
  await audit(page, 'viewer with its thread')
  // ← → typed in the column's box are the box's: no step
  const box = column(page).getByTestId('room-input')
  await box.click()
  await page.keyboard.type('acme 확인했어요')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 5')
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: 'acme 확인했어요', threadRootId: id(1) })
  await expect(column(page).getByTestId('room-message')).toHaveCount(3)
  const mine = column(page).getByTestId('room-message').last()
  await expect(mine).toContainText('acme 확인했어요')
  // a click on the column's text keeps the focus in the viewer (not on the page behind)
  await column(page).getByTestId('room-message').first().locator('p').first().click()
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="image-viewer"]'))).toBe(true)
  // a delete's confirm opens over the viewer, and its buttons take the click
  await mine.hover()
  await mine.getByTestId('message-more').click()
  await page.getByRole('menuitem', { name: '삭제' }).click()
  const confirm = page.getByRole('dialog', { name: '메시지를 삭제할까요?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '취소' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(viewer(page)).toBeVisible()
  // a draft typed in the viewer's box is the page's box's once the viewer goes
  await column(page).getByTestId('room-input').fill('acme 초안 답글')
  // closed: the page's thread has the reply too, and is still there
  await page.getByTestId('image-viewer-close').click()
  await expect(viewer(page)).toHaveCount(0)
  await expect(pageThread.getByTestId('room-message')).toHaveCount(3)
  await expect(pageThread.getByTestId('room-message').last()).toContainText('acme 확인했어요')
  await expect(pageThread.getByTestId('thread-count')).toBeVisible()
  await expect(pageThread.getByTestId('room-input')).toHaveValue('acme 초안 답글')
})

test('a step to another message moves the thread with it: a reply marked in its thread, a message without replies alone with the box', async ({ page }) => {
  await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
  // the reply's notes, from the page's thread: its root's thread, the reply marked
  await openChip(page.getByTestId('thread-scroller'), 'acme-reply.md')
  await expect(column(page).getByTestId('room-message')).toHaveCount(2)
  await expect(column(page).locator('[data-highlight]')).toContainText('메모 하나 더')
  await page.keyboard.press('Escape')
  // the timeline's ZIP: its message has no replies, shown alone with the reply box
  await openChip(timeline(page), 'acme-assets.zip')
  await expect(column(page).getByTestId('room-message')).toHaveCount(1)
  await expect(column(page).getByTestId('room-message')).toContainText('압축 파일이랑 메모예요')
  await expect(column(page).getByTestId('thread-count')).toHaveText('아직 답글이 없어요')
  await expect(column(page).getByTestId('room-input')).toBeVisible()
  // ← to the photo: the first message's thread again
  await viewer(page).getByTestId('image-viewer-prev').click()
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
  await expect(column(page).getByTestId('room-message')).toHaveCount(2)
  await expect(column(page).getByTestId('room-message').first()).toContainText('자료 올려요')
})

test('✦ switches the column to Trina with the file quoted; "팀 폴더에 저장" asks for it; "스레드로 돌아가기" brings the thread back', async ({ page }) => {
  await openRoom(page)
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(column(page)).toHaveAttribute('data-show', 'thread')
  const ask = page.getByTestId('image-viewer-ask-trina')
  await expect(ask).toHaveAccessibleName('트리나에게 이 파일 묻기')
  await ask.click()
  await expect(column(page)).toHaveAttribute('data-show', 'trina')
  await expect(column(page).getByTestId('side-chat-quote-file')).toHaveText('acme-handbook.pdf')
  await expect(column(page).getByTestId('side-chat-input')).toBeFocused()
  // the file's quick questions, with 팀 폴더에 저장 (the AI saves it with save_room_file and shows its card)
  await expect(column(page).getByTestId('side-chat-quick-fileSave')).toHaveText('팀 폴더에 저장')
  await audit(page, 'viewer with the Trina side chat')
  const [q] = await Promise.all([sideQuestion(page), column(page).getByTestId('side-chat-quick-fileSave').click()])
  const content = (q.postDataJSON() as { content: string }).content
  expect(content).toBe(`> 📎 acme-handbook.pdf (file_id ${id(502)} in this room)\n\n이 파일을 팀 폴더에 저장해 줘.`)
  await expect(column(page).getByTestId('side-chat-quote')).toHaveCount(0)
  await expect(column(page).getByTestId('user-message')).toHaveCount(1)
  // back to the file's thread, from the link at the side chat's top
  await column(page).getByTestId('viewer-column-back').click()
  await expect(column(page)).toHaveAttribute('data-show', 'thread')
  await expect(column(page).getByTestId('thread-count')).toHaveText('답글 1개')
})

test('the Trina side chat stays across ← →, quoting nothing new; the toggle hides the column and the stage takes the room', async ({ page }) => {
  await openRoom(page)
  await openChip(timeline(page), 'acme-handbook.pdf')
  await page.getByTestId('image-viewer-ask-trina').click()
  await expect(column(page).getByTestId('side-chat-quote-file')).toHaveText('acme-handbook.pdf')
  await column(page).getByTestId('side-chat-input').fill('acme 일정 알려 줘')
  // → the photo, → the ZIP (by the edge arrow: the focus is in the side chat's box)
  await viewer(page).getByTestId('image-viewer-next').click()
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
  await viewer(page).getByTestId('image-viewer-next').click()
  await expect(fileDialog(page, 'acme-assets.zip')).toBeVisible()
  await expect(column(page)).toHaveAttribute('data-show', 'trina')
  await expect(column(page).getByTestId('side-chat-quote-file')).toHaveText('acme-handbook.pdf')
  await expect(column(page).getByTestId('side-chat-input')).toHaveValue('acme 일정 알려 줘')
  // the right arrow keeps clear of the column
  const next = (await viewer(page).getByTestId('image-viewer-next').boundingBox())!
  expect(next.x + next.width).toBeLessThanOrEqual(1040 - 12 + 1)
  // hidden: the stage is the whole width; shown again: the side chat as it was
  const toggle = page.getByTestId('image-viewer-column')
  await expect(toggle).toHaveAccessibleName('스레드·채팅 숨기기')
  await toggle.click()
  await expect(column(page)).toHaveCount(0)
  await expect(toggle).toHaveAccessibleName('스레드·채팅 보기')
  // the focus is still in the viewer: the keys step
  await viewer(page).getByTestId('image-viewer-stage').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(fileDialog(page, 'acme-assets.zip')).toBeVisible()
  await expect.poll(async () => (await stageBox(page)).width).toBe(1440)
  await toggle.click()
  await expect(column(page)).toHaveAttribute('data-show', 'trina')
  await expect(column(page).getByTestId('side-chat-input')).toHaveValue('acme 일정 알려 줘')
  expect((await stageBox(page)).width).toBe(1040)
})

test("a team file named in the column's thread opens in the side panel: the viewer gives way to it", async ({ page }) => {
  await openRoom(page, { link: true })
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(column(page).getByTestId('room-message')).toHaveCount(3)
  await column(page).getByTestId('room-link').click()
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByTestId('file-panel').getByTestId('file-panel-title')).toHaveText('handbook.pdf')
  expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
})

test("the column starts on Trina when the room page's side chat was open: the same chat and draft", async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-side-chat-button').click()
  const pageSide = page.getByTestId('room-side-chat')
  await expect(pageSide.getByTestId('side-chat-empty')).toBeVisible()
  await pageSide.getByTestId('side-chat-input').fill('acme 초안')
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(column(page)).toHaveAttribute('data-show', 'trina')
  await expect(column(page).getByTestId('side-chat-input')).toHaveValue('acme 초안')
  // opened on it: the focus stays on the file
  await expect(column(page).getByTestId('side-chat-input')).not.toBeFocused()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await expect(pageSide.getByTestId('side-chat-input')).toHaveValue('acme 초안')
})

test('the side chat beside a file takes a pasted picture, and the room page\'s side chat has the same one', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'pastes through the page clipboard (Chromium)')
  await openRoom(page)
  await openChip(timeline(page), 'acme-handbook.pdf')
  await page.getByTestId('image-viewer-ask-trina').click()
  await expect(column(page).getByTestId('side-chat-input')).toBeFocused()
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, PNG.toString('base64'))
  await page.keyboard.press('ControlOrMeta+V')
  const chips = column(page).getByTestId('attachment-chip')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await expect(chips.first().getByTestId('chip-thumb')).toBeVisible()
  await expect(column(page).getByTestId('side-chat-attach')).toBeVisible()
  // the viewer stays open (the paste was the box's), and the room page's side chat shows the same picture
  await expect(viewer(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-side-chat').getByTestId('attachment-chip')).toHaveCount(1)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a PDF opens over the whole screen with the bar above it; a swipe steps; ✕ closes', async ({ page }) => {
    await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    const box = (await viewer(page).boundingBox())!
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
    await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
    // the document sits under the bar, which stays (a tap does not hide it here), full width
    const bar = (await page.getByTestId('image-viewer-bar').boundingBox())!
    const body = (await viewer(page).getByTestId('file-viewer-body').boundingBox())!
    expect(body.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
    expect(body.width).toBe(390)
    // the edge arrows would sit on the text: the bar's ‹ › step instead (and a swipe)
    await expect(page.getByTestId('image-viewer-next')).toBeHidden()
    await expect(page.getByTestId('image-viewer-bar-next')).toBeVisible()
    await expect(page.getByTestId('image-viewer-panel')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await audit(page, 'viewer on a phone')
    // a swipe left on the page steps to the next one (the photo), a swipe right back
    const swipe = (dx: number) => viewer(page).getByTestId('file-viewer-body').evaluate((el, dx) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const touch = (cx: number) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y })
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)], changedTouches: [touch(x)] }))
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x + dx)] }))
    }, dx)
    await swipe(-150)
    await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
    await page.getByTestId('image-viewer-prev').click()
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    await page.getByTestId('image-viewer-bar-next').click()
    await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
    await page.getByTestId('image-viewer-close').click()
    await expect(viewer(page)).toHaveCount(0)
    await expect(timeline(page).getByTestId('room-message')).toHaveCount(3)
    // the notes (no sideways scroll there): a swipe right steps back to the ZIP's card
    await openChip(timeline(page), 'acme-notes.md')
    await expect(viewer(page).getByRole('heading', { name: 'acme 회의 메모' })).toBeVisible()
    await swipe(150)
    await expect(fileDialog(page, 'acme-assets.zip')).toBeVisible()
    await page.getByTestId('image-viewer-close').click()
    await expect(viewer(page)).toHaveCount(0)
  })
})

test.describe('a phone (390 px), the conversation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("no column; ✦ closes the viewer and opens the room page's side chat with the file quoted", async ({ page }) => {
    await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    await expect(column(page)).toHaveCount(0)
    await expect(page.getByTestId('image-viewer-column')).toHaveCount(0)
    expect((await stageBox(page)).width).toBe(390)
    await page.getByTestId('image-viewer-ask-trina').click()
    await expect(viewer(page)).toHaveCount(0)
    const side = page.getByTestId('room-side-chat')
    await expect(side).toBeVisible()
    await expect(side.getByTestId('side-chat-quote-file')).toHaveText('acme-handbook.pdf')
    expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
  })

  test("from a thread over the room: ✦ closes the viewer and the thread, and the room's side chat opens with the file", async ({ page }) => {
    await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
    await openChip(page.getByTestId('thread-scroller'), 'acme-reply.md')
    await expect(fileDialog(page, 'acme-reply.md')).toBeVisible()
    await page.getByTestId('image-viewer-ask-trina').click()
    await expect(viewer(page)).toHaveCount(0)
    await expect(page.getByTestId('room-thread')).toHaveCount(0)
    await expect(page.getByTestId('room-side-chat').getByTestId('side-chat-quote-file')).toHaveText('acme-reply.md')
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
  })
})

test('screenshots of the room file viewer (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  // a PDF with its thread at 1440 light
  await page.emulateMedia({ colorScheme: 'light' })
  await openRoom(page, { hwp: true })
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  await expect(column(page).getByTestId('thread-count')).toBeVisible()
  await page.mouse.move(520, 500)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/room-file-viewer-pdf-thread-1440-light.png` })
  // the ZIP's card at 1440 light
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(card(page)).toBeVisible()
  await page.screenshot({ path: `${dir}/room-file-viewer-card-1440-light.png` })
  // the column hidden at 1440 light, on the PDF
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('image-viewer-column').click()
  await expect(column(page)).toHaveCount(0)
  await page.mouse.move(720, 500)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/room-file-viewer-column-hidden-1440-light.png` })
  await page.getByTestId('image-viewer-column').click()
  // the Trina side chat with the file quoted at 1440 dark
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByTestId('image-viewer-ask-trina').click()
  await expect(column(page).getByTestId('side-chat-quote-file')).toBeVisible()
  await column(page).getByTestId('side-chat-input').fill('이 파일에서 일정만 뽑아 줘')
  await page.mouse.move(520, 500)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/room-file-viewer-trina-1440-dark.png` })
  await page.keyboard.press('Escape')
  // a Hangul file at 1440 dark
  await page.emulateMedia({ colorScheme: 'dark' })
  await openChip(timeline(page), 'acme-신청서.hwp')
  await expect(viewer(page).getByTestId('hwp-page')).toBeVisible({ timeout: 20_000 })
  await page.mouse.move(720, 500)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/room-file-viewer-hwp-1440-dark.png` })
  await page.keyboard.press('Escape')
  // a PDF at 390 light
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await openChip(timeline(page), 'acme-handbook.pdf')
  await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/room-file-viewer-pdf-390-light.png` })
})
