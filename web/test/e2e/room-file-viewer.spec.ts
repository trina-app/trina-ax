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
// back; the side chat stays across ← →; the bar's toggle hides the column. The side chat there takes a pasted picture,
// and the room page's side chat shows the same one. On a phone the column is a sheet over the viewer: 💬 (with the reply
// count) opens the thread there, ✦ Trina with the file quoted; its handle drags it, Back closes the sheet, then the
// viewer; a finger still steps through the files (CDP touch).
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
  // 패널에서 열기 (⤡, as the side panel's own way back beside the chat) is not a second panel icon beside the column's
  // toggle; a computer's bar has no 💬 (the column is there)
  const icon = (id: string) => page.getByTestId(id).locator('svg').first().getAttribute('class')
  expect(await icon('image-viewer-panel')).toMatch(/minimize/)
  expect(await icon('image-viewer-column')).toMatch(/panel-right/)
  await expect(page.getByTestId('image-viewer-thread')).toHaveCount(0)
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
const sheet = (page: Page) => viewer(page).getByTestId('viewer-sheet')
/** a finger on the screen (CDP touch events, as a phone sends them): pressed on `on`'s middle, moved by `dx`, `dy` in
 * four moves (`gap` ms apart: a slow drag), held still `hold` ms, lifted */
async function touchMove(page: Page, on: Locator, dx: number, dy: number, o: { gap?: number; hold?: number } = {}) {
  const b = (await on.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 4; i++) {
    if (o.gap) await page.waitForTimeout(o.gap)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 4, y: y + (dy * i) / 4 }] })
  }
  if (o.hold) await page.waitForTimeout(o.hold)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
const touchDrag = (page: Page, on: Locator, dy: number) => touchMove(page, on, 0, dy)
const touchSwipe = (page: Page, on: Locator, dx: number) => touchMove(page, on, dx, 0)
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

test("More emoji in the column's thread opens the picker over the viewer, with the keyboard in it; Esc closes only the picker", async ({ page }) => {
  const { room } = await openRoom(page)
  await openChip(timeline(page), 'acme-handbook.pdf')
  const msg = column(page).getByTestId('room-message').first()
  await msg.hover()
  await msg.getByTestId('message-react').click()
  await msg.getByTestId('reaction-more').click()
  // inside the viewer's dialog (its focus trap keeps the keyboard there), over everything at its middle
  const pop = viewer(page).getByTestId('emoji-popover')
  await expect(pop).toBeVisible()
  const b = (await pop.boundingBox())!
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="emoji-popover"]'), [b.x + b.width / 2, b.y + b.height / 2])).toBe(true)
  await expect(pop.getByTestId('emoji-search')).toBeFocused()
  await page.keyboard.type('cry')
  await expect(pop.getByTestId('emoji-search')).toHaveValue('cry')
  // ← → in the picker are not the viewer's steps
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 5')
  await pop.getByTestId('emoji-results').locator('[data-emoji="😭"]').click()
  await expect(pop).toHaveCount(0)
  await expect(viewer(page)).toBeVisible()
  expect(room.reacted).toEqual([{ messageId: id(1), emoji: '😭', on: true }])
  // Esc: the picker goes, the viewer stays
  await msg.hover()
  await msg.getByTestId('message-react').click()
  await msg.getByTestId('reaction-more').click()
  await expect(pop.getByTestId('emoji-search')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await expect(viewer(page)).toBeVisible()
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

  test("💬 opens the file's thread in a sheet over it; a reply from it is in the room's thread; the handle drags it; Back closes the sheet, then the viewer", async ({ page }) => {
    const { room } = await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    // no column beside it, no toggle: the bar's 💬, with the reply count
    await expect(column(page)).toHaveCount(0)
    await expect(page.getByTestId('image-viewer-column')).toHaveCount(0)
    expect((await stageBox(page)).width).toBe(390)
    const talk = page.getByTestId('image-viewer-thread')
    await expect(talk).toHaveAccessibleName('스레드 보기, 답글 1')
    await expect(page.getByTestId('image-viewer-thread-count')).toHaveText('1')
    // the bar keeps the name in view beside ‹ › and the buttons
    expect((await page.getByTestId('image-viewer-name').boundingBox())!.width).toBeGreaterThan(60)
    await talk.tap()
    // the sheet: about 70 % of the screen, the file dimmed above it; the thread with its ✕ (no ‹ in a sheet)
    await expect(sheet(page)).toHaveAttribute('data-size', 'part')
    await expect(column(page)).toHaveAttribute('data-show', 'thread')
    await expect(column(page).getByTestId('room-message')).toHaveCount(2)
    await expect(column(page).getByTestId('thread-count')).toHaveText('답글 1개')
    await expect(column(page).getByTestId('thread-close')).toBeVisible()
    await expect(column(page).getByTestId('thread-back')).toHaveCount(0)
    await expect.poll(async () => Math.round((await sheet(page).boundingBox())!.height)).toBe(Math.round(844 * 0.7))
    // at the bottom, once it has slid up
    await expect.poll(async () => { const b = (await sheet(page).boundingBox())!; return Math.round(b.y + b.height) }).toBe(844)
    // the file behind is out of reach while it is open
    await expect(page.getByTestId('image-viewer-stage')).toHaveAttribute('inert', '')
    await audit(page, 'viewer with the thread sheet on a phone')
    // a reply from the sheet: in the room's thread
    const box = column(page).getByTestId('room-input')
    await box.tap()
    await box.fill('acme 폰에서 답글')
    await column(page).getByTestId('room-send').tap()
    await expect.poll(() => room.sent.length).toBe(1)
    expect(room.sent[0]).toMatchObject({ body: 'acme 폰에서 답글', threadRootId: id(1) })
    await expect(column(page).getByTestId('room-message')).toHaveCount(3)
    // the keyboard up (the window shrinks above it, interactive-widget=resizes-content): the sheet takes the whole height
    // above it, its box in view
    await page.setViewportSize({ width: 390, height: 500 })
    await expect.poll(async () => Math.round((await sheet(page).boundingBox())!.height)).toBe(500)
    const input = (await column(page).getByTestId('room-input').boundingBox())!
    expect(input.y + input.height).toBeLessThanOrEqual(500)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => Math.round((await sheet(page).boundingBox())!.height)).toBe(Math.round(844 * 0.7))
    // the handle: up to the whole height, down to 70 %, down again to close
    const handle = page.getByTestId('viewer-sheet-handle')
    const sheetHeight = async () => Math.round((await sheet(page).boundingBox())!.height)
    await expect(handle).toHaveAccessibleName('위로 펼치기')
    await touchDrag(page, handle, -300)
    await expect(sheet(page)).toHaveAttribute('data-size', 'full')
    await expect(handle).toHaveAccessibleName('아래로 줄이기')
    await expect.poll(sheetHeight).toBe(844)
    await touchDrag(page, handle, 150)
    await expect(sheet(page)).toHaveAttribute('data-size', 'part')
    await expect.poll(sheetHeight).toBe(Math.round(844 * 0.7))
    await touchDrag(page, handle, 300)
    await expect(sheet(page)).toHaveCount(0)
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    await expect(page.getByTestId('image-viewer-stage')).not.toHaveAttribute('inert', '')
    // a tap beside it closes it too
    await talk.tap()
    await expect(sheet(page)).toBeVisible()
    await page.touchscreen.tap(195, 100)
    await expect(sheet(page)).toHaveCount(0)
    // Back (the browser's, Android's): the sheet first, then the viewer, then the page stays
    await talk.tap()
    await expect(sheet(page)).toBeVisible()
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    await page.goBack()
    await expect(viewer(page)).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
    await expect(timeline(page).getByTestId('room-message')).toHaveCount(3)
    // the room's thread has the reply
    await timeline(page).getByTestId('room-thread-line').first().tap()
    await expect(page.getByTestId('room-thread').getByTestId('room-message')).toHaveCount(3)
    await expect(page.getByTestId('room-thread').getByTestId('room-message').last()).toContainText('acme 폰에서 답글')
  })

  test('✦ opens Trina in the same sheet with the file quoted; "스레드로 돌아가기" brings the thread; ✕ and Back close it back to the file', async ({ page }) => {
    await openRoom(page, { at: `/rooms/${ROOM_ID}/t/${id(1)}` })
    // from the thread page over the room: the reply's notes
    await openChip(page.getByTestId('thread-scroller'), 'acme-reply.md')
    await expect(fileDialog(page, 'acme-reply.md')).toBeVisible()
    await page.getByTestId('image-viewer-ask-trina').tap()
    // the viewer stays: Trina in the sheet over it, the file quoted with its quick questions
    await expect(sheet(page)).toBeVisible()
    await expect(column(page)).toHaveAttribute('data-show', 'trina')
    await expect(column(page).getByTestId('side-chat-quote-file')).toHaveText('acme-reply.md')
    await expect(column(page).getByTestId('side-chat-quick-fileSave')).toBeVisible()
    // the box asks about the file, not "this message"
    await expect(column(page).getByTestId('side-chat-input')).toHaveAttribute('placeholder', '이 파일에 대해 트리나에게 묻기…')
    await expect(column(page).getByTestId('side-chat-close')).toBeVisible()
    await expect(column(page).getByTestId('side-chat-back')).toHaveCount(0)
    await audit(page, 'viewer with Trina in the sheet on a phone')
    // the room page under it did not open its own side chat, and the thread is still in the address
    await expect(page.getByTestId('room-side-chat')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}/t/${id(1)}`)
    // back to the file's thread, in the same sheet
    await column(page).getByTestId('viewer-column-back').tap()
    await expect(column(page)).toHaveAttribute('data-show', 'thread')
    await expect(column(page).locator('[data-highlight]')).toContainText('메모 하나 더')
    // its ✕: back to the file
    await column(page).getByTestId('thread-close').tap()
    await expect(sheet(page)).toHaveCount(0)
    await expect(fileDialog(page, 'acme-reply.md')).toBeVisible()
    // ✦ again, then Back: the sheet, then the viewer; the thread page is still there
    await page.getByTestId('image-viewer-ask-trina').tap()
    await expect(column(page)).toHaveAttribute('data-show', 'trina')
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    await expect(fileDialog(page, 'acme-reply.md')).toBeVisible()
    await page.goBack()
    await expect(viewer(page)).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}/t/${id(1)}`)
    await expect(page.getByTestId('room-thread')).toBeVisible()
  })

  test('the sheet keeps the keys and the focus: Tab stays in it, its handle never steps, Esc closes it before the viewer and the focus goes back to 💬; a slow drag and one held before it lifts settle', async ({ page }) => {
    await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    const talk = page.getByTestId('image-viewer-thread')
    await talk.tap()
    await expect(column(page).getByTestId('room-message')).toHaveCount(2)
    const inSheet = () => page.evaluate(() => !!document.activeElement?.closest('[data-viewer-sheet]'))
    expect(await inSheet()).toBe(true)
    // Tab and Shift+Tab go round the sheet, never to the file or the bar under it, nor the room behind
    const handle = page.getByTestId('viewer-sheet-handle')
    await handle.focus()
    // from its first control (the handle) Shift+Tab wraps to its last, and Tab from there back to the handle
    await page.keyboard.press('Shift+Tab')
    expect(await inSheet()).toBe(true)
    await expect(handle).not.toBeFocused()
    await page.keyboard.press('Tab')
    await expect(handle).toBeFocused()
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab')
      expect(await inSheet()).toBe(true)
    }
    // the handle's keys are the sheet's: → does not step to the next file under it
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 5')
    // Enter on the handle: the whole height, and back
    await page.keyboard.press('Enter')
    await expect(sheet(page)).toHaveAttribute('data-size', 'full')
    await page.keyboard.press('Enter')
    await expect(sheet(page)).toHaveAttribute('data-size', 'part')
    const sheetHeight = async () => Math.round((await sheet(page).boundingBox())!.height)
    await expect.poll(sheetHeight).toBe(Math.round(844 * 0.7))
    // a slow drag up 100 px: nearer 70 % than the whole height, so back there
    await touchMove(page, handle, 0, -100, { gap: 120 })
    await expect(sheet(page)).toHaveAttribute('data-size', 'part')
    await expect.poll(sheetHeight).toBe(Math.round(844 * 0.7))
    // a quick drag down 150 px, held before the finger lifts: no flick, it stays
    await touchMove(page, handle, 0, 150, { hold: 250 })
    await expect.poll(sheetHeight).toBe(Math.round(844 * 0.7))
    await expect(sheet(page)).toBeVisible()
    // Esc: the sheet first, the focus back on 💬; Esc again: the viewer
    await handle.focus()
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    await expect(talk).toBeFocused()
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(`/rooms/${ROOM_ID}`)
    // no entry of the viewer's left: Back leaves the room's page as before (it is the first page here: nothing to go to)
    expect(await page.evaluate(() => !!(window.history.state as Record<string, unknown> | null)?.__imageViewer)).toBe(false)
  })

  test('with the sheet closed a finger still steps through the files (CDP touch); the photo keeps its own gestures', async ({ page }) => {
    await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('image-viewer-thread').tap()
    await expect(sheet(page)).toBeVisible()
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    // a swipe left on the PDF: the photo
    const body = viewer(page).getByTestId('file-viewer-body')
    await touchSwipe(page, body, -160)
    await expect(page.getByRole('dialog', { name: '이미지 보기: acme-logo.png' })).toBeVisible()
    // the photo's 💬 opens the same message's thread
    await page.getByTestId('image-viewer-thread').tap()
    await expect(column(page).getByTestId('room-message').first()).toContainText('자료 올려요')
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    // a swipe right on the photo: back to the PDF
    await touchSwipe(page, page.getByTestId('image-viewer-stage'), 160)
    await expect(fileDialog(page, 'acme-handbook.pdf')).toBeVisible()
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
  // the bar's right end: download, 패널에서 열기 (⤡), ✦, the column's toggle, ✕
  await page.screenshot({ path: `${dir}/room-file-viewer-bar-icons-1440-light.png`, clip: { x: 1080, y: 0, width: 360, height: 56 } })
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

test.describe('screenshots on a phone (SHOTS_DIR)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the thread sheet at 390 light, Trina in the sheet at 390 dark, a reply with the keyboard up at 390 light', async ({ page }) => {
    const dir = process.env.SHOTS_DIR
    test.skip(!dir, 'only with SHOTS_DIR')
    await page.emulateMedia({ colorScheme: 'light' })
    await openRoom(page)
    await openChip(timeline(page), 'acme-handbook.pdf')
    await expect(pdfPages(page).first()).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: `${dir}/room-viewer-phone-bar-390-light.png` })
    await page.getByTestId('image-viewer-thread').tap()
    await expect(column(page).getByTestId('thread-count')).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/room-viewer-thread-sheet-390-light.png` })
    // the keyboard up: the window shrinks above it (interactive-widget=resizes-content)
    await column(page).getByTestId('room-input').tap()
    await column(page).getByTestId('room-input').fill('acme 확인했어요. 3쪽 일정만 바꿔 주세요')
    await page.setViewportSize({ width: 390, height: 480 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/room-viewer-thread-keyboard-390-light.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    // Trina in the sheet with the file quoted, dark
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByTestId('image-viewer-ask-trina').tap()
    await expect(column(page).getByTestId('side-chat-quote-file')).toBeVisible()
    await page.locator(':focus').blur()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/room-viewer-trina-sheet-390-dark.png` })
    // the bar on a file in the middle of the list (‹ › both there), light
    await page.goBack()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByTestId('image-viewer-close').tap()
    await openChip(timeline(page), 'acme-notes.md')
    await expect(page.getByTestId('image-viewer-bar-prev')).toBeVisible()
    expect((await page.getByTestId('image-viewer-name').boundingBox())!.width).toBeGreaterThan(55)
    await page.screenshot({ path: `${dir}/room-viewer-phone-bar-middle-390-light.png`, clip: { x: 0, y: 0, width: 390, height: 120 } })
  })
})
