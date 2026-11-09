// Room files open on click (components/rooms/RoomMessages.tsx FileChip, FilePanel's room source): a chip opens its file
// in the side panel (a full-screen sheet on phones), drawn by the app's own viewers: an HTML page only in the sandbox
// frame (opaque origin: its script cannot reach the app), a PDF, a photo, Markdown; the panel and the chip both download.
// In an answer someone shared with its files attached, a link to a file I cannot open opens the attached copy (no lock);
// a member who can open the team file gets the team file itself. A right-click on a photo (the thumbnail, the panel's
// original) is left to the browser's own menu, for Copy Image. The room and its files are answered through page.route
// as the team server sends them (rooms-mock.ts; a page inline as text with the sandbox CSP). Every view passes axe.
// SHOTS_DIR=<folder>: the screenshots (the chips, the panel, the phone sheet; light and dark) go there.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Download, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
// the page tries to read the app around it: in the sandbox frame it cannot
const PAGE = '<!doctype html><html><body><h1>acme 덱</h1><p id="out">…</p><script>let r; try { r = "reached " + parent.document.title } catch (e) { r = "blocked" } document.getElementById("out").textContent = r</script></body></html>'
const MD = '# acme 회의 메모\n\n- 첫째\n- 둘째\n'
// a 192 x 192 picture (the app's own icon)
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const DECK = 'users/ben/acme-deck.html'
const BUDGET = 'finance/acme-budget.xlsx'

type Bytes = { name: string; mime: string; body: Buffer }
const file = (n: number, name: string, kind: string, mime: string, size: number, o: Record<string, unknown> = {}) => ({ id: id(n), name, size, mime, kind, thumb: false, ...o })

/** The room: Ben's files (a page, a PDF, a photo, notes, a zip) and his shared answer whose deck went with it as a copy
 * (`openable`: whether I may open the team file myself). */
async function openRoom(page: Page, o: { openable?: boolean } = {}) {
  await reset(page)
  await signIn(page)
  // the mock's own PDF, served as a room file
  const pdf = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fhandbook.pdf&disposition=attachment&preview=true')).body())
  const bytes = new Map<string, Bytes>([
    [id(501), { name: 'acme-deck.html', mime: 'text/html', body: Buffer.from(PAGE) }],
    [id(502), { name: 'acme-handbook.pdf', mime: 'application/pdf', body: pdf }],
    [id(503), { name: 'acme-logo.png', mime: 'image/png', body: PNG }],
    [id(504), { name: 'acme-notes.md', mime: 'text/markdown', body: Buffer.from(MD) }],
    [id(505), { name: 'acme-assets.zip', mime: 'application/zip', body: Buffer.from('PK\x03\x04 zip') }],
    [id(506), { name: 'acme-deck.html', mime: 'text/html', body: Buffer.from(PAGE.replace('acme 덱', 'acme 덱 (첨부본)')) }],
  ])
  const files = [
    file(501, 'acme-deck.html', 'text', 'text/html', PAGE.length),
    file(502, 'acme-handbook.pdf', 'pdf', 'application/pdf', pdf.length),
    file(503, 'acme-logo.png', 'image', 'image/png', PNG.length, { width: 192, height: 192, thumb: true }),
    file(504, 'acme-notes.md', 'text', 'text/markdown', MD.length),
    file(505, 'acme-assets.zip', 'other', 'application/zip', 10),
  ]
  const note = '회의 전에 봐 주세요'
  const answer = `덱은 [acme 덱](/files/view?path=${DECK})이고, 예산은 [예산표](/files/view?path=${BUDGET})에 있어요.`
  const room = await routeRoom(page, {
    members: [BEN],
    kind: 'team',
    messages: [
      { id: id(1), author: BEN, body: '자료 올려요', extra: { files } },
      { id: id(2), author: BEN, body: `${note}\n\n${answer}`, extra: {
        sharedAnswer: { at: note.length + 2, cut: false },
        files: [file(506, 'acme-deck.html', 'text', 'text/html', PAGE.length + 6)],
        openable: o.openable ? [DECK] : [],
        attachedLinks: [{ path: DECK, fileId: id(506) }],
      } },
    ],
  })
  // the room's files, as the team server sends them (team-files/download.ts streamFile): inline a page is text with the
  // sandbox CSP, download=1 an attachment; the room's member check is the server's (tests/unit/b-rooms.test.ts)
  const served: string[] = []
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, async (route) => {
    const u = new URL(route.request().url())
    const f = bytes.get(u.pathname.split('/').pop()!)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found","message":"x"}}' })
    const download = u.searchParams.get('download') === '1'
    served.push(`${f.name}${u.search}`)
    const active = /html|svg|xml|javascript/.test(f.mime)
    return route.fulfill({
      status: 200,
      body: f.body,
      headers: {
        'content-type': !download && active ? 'text/plain; charset=utf-8' : f.mime,
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${f.name}"`,
        'x-content-type-options': 'nosniff',
        ...(f.mime === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
      },
    })
  })
  // the team file itself, for a member who may open it
  await page.route((u) => u.pathname === '/api/files/download' && u.searchParams.get('path') === DECK, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-disposition': 'attachment; filename="acme-deck.html"' }, body: PAGE.replace('acme 덱', 'acme 덱 (팀 파일)') }))
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(2)
  return { room, served }
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

const chip = (page: Page, name: string) => page.getByTestId('room-message').first().getByTestId('room-file').filter({ hasText: name })
/** a download of the room file `n` as an attachment (the room's address, download=1) */
const isRoomDownload = (d: Download, n: number) => {
  const u = new URL(d.url())
  return u.pathname === `/api/rooms/${ROOM_ID}/files/${id(n)}` && u.searchParams.get('download') === '1'
}
const panel = (page: Page) => page.getByTestId('file-panel')

test('a chip opens its file in the panel: the page only in the sandbox frame, a PDF, a photo, Markdown; a zip downloads', async ({ page }) => {
  const { served } = await openRoom(page)
  await audit(page, 'room with files')
  // the page: in the sandbox frame (opaque origin, the receiver's address), never srcdoc or a page of this origin; its
  // script cannot read the app around it
  await chip(page, 'acme-deck.html').getByTestId('room-file-open').click()
  await expect(panel(page).getByTestId('file-panel-title')).toHaveText('acme-deck.html')
  const frame = panel(page).getByTestId('sandbox-frame')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame).toHaveAttribute('src', /^\/sandbox\/frame\?/)
  expect(await frame.getAttribute('srcdoc')).toBeNull()
  const inner = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
  await expect(inner.locator('h1')).toHaveText('acme 덱')
  await expect(inner.locator('#out')).toHaveText('blocked')
  // a room file has only the download: no "ask AI", "open in Files" or edit (not a team file)
  await expect(panel(page).getByTestId('file-ask-ai')).toHaveCount(0)
  await expect(panel(page).getByTestId('file-edit')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: '파일 화면에서 열기' })).toHaveCount(0)
  await audit(page, 'panel with a page')
  // the PDF
  await chip(page, 'acme-handbook.pdf').getByTestId('room-file-open').click()
  await expect(panel(page).getByTestId('file-panel-title')).toHaveText('acme-handbook.pdf')
  await expect(panel(page).locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  // the photo, from its thumbnail
  await page.getByTestId('room-image').click()
  await expect(panel(page).getByTestId('file-panel-title')).toHaveText('acme-logo.png')
  await expect(panel(page).getByRole('img', { name: 'acme-logo.png' })).toBeVisible()
  // Markdown
  await chip(page, 'acme-notes.md').getByTestId('room-file-open').click()
  await expect(panel(page).getByRole('heading', { name: 'acme 회의 메모' })).toBeVisible()
  await audit(page, 'panel with Markdown')
  // the zip: no viewer, so its chip is one download button, as before
  await expect(chip(page, 'acme-assets.zip').getByTestId('room-file-open')).toHaveCount(0)
  const [zip] = await Promise.all([page.waitForEvent('download'), chip(page, 'acme-assets.zip').click()])
  expect(zip.suggestedFilename()).toBe('acme-assets.zip')
  expect(isRoomDownload(zip, 505)).toBe(true)
  // the bytes the panel drew were read through the room, inline
  expect(served).toEqual(expect.arrayContaining(['acme-deck.html', 'acme-handbook.pdf', 'acme-logo.png?thumb=1', 'acme-logo.png', 'acme-notes.md']))
})

test("a right-click on a photo reaches the browser's own menu (Copy Image): on the message and on the panel's original", async ({ page }) => {
  await openRoom(page)
  // registered last on the window: what the app did with the right-click by the time it got there (then no menu here)
  await page.evaluate(() => {
    const w = window as unknown as { __menus: { tag: string; src: string; prevented: boolean }[] }
    w.__menus = []
    window.addEventListener('contextmenu', (e) => {
      const el = e.target as HTMLImageElement
      w.__menus.push({ tag: el.tagName, src: el.src ?? '', prevented: e.defaultPrevented })
      e.preventDefault()
    })
  })
  const menus = () => page.evaluate(() => (window as unknown as { __menus: { tag: string; src: string; prevented: boolean }[] }).__menus)
  // the thumbnail: the picture itself under the pointer (nothing covers it), the menu not taken
  await page.getByTestId('room-image').locator('img').click({ button: 'right' })
  await expect.poll(menus).toHaveLength(1)
  expect((await menus())[0]).toMatchObject({ tag: 'IMG', prevented: false, src: expect.stringContaining(`/files/${id(503)}?thumb=1`) })
  // the panel shows the original, drawn from its own bytes: copying there copies the original
  await page.getByTestId('room-image').click()
  const original = panel(page).getByRole('img', { name: 'acme-logo.png' })
  await expect(original).toBeVisible()
  await original.click({ button: 'right' })
  await expect.poll(menus).toHaveLength(2)
  expect((await menus())[1]).toMatchObject({ tag: 'IMG', prevented: false, src: expect.stringMatching(/^blob:/) })
})

test('download from the chip and from the panel', async ({ page }) => {
  await openRoom(page)
  const dl = chip(page, 'acme-handbook.pdf').getByTestId('room-file-download')
  await expect(dl).toHaveAccessibleName('acme-handbook.pdf 내려받기')
  await dl.hover()
  await expect(page.getByRole('tooltip')).toHaveText('내려받기')
  const [fromChip] = await Promise.all([page.waitForEvent('download'), dl.click()])
  expect(fromChip.suggestedFilename()).toBe('acme-handbook.pdf')
  expect(isRoomDownload(fromChip, 502)).toBe(true)
  // the download icon did not open the panel
  await expect(panel(page)).toHaveCount(0)
  await chip(page, 'acme-notes.md').getByTestId('room-file-open').click()
  const [fromPanel] = await Promise.all([page.waitForEvent('download'), panel(page).getByRole('button', { name: '내려받기', exact: true }).click()])
  expect(fromPanel.suggestedFilename()).toBe('acme-notes.md')
  expect(isRoomDownload(fromPanel, 504)).toBe(true)
})

test('a shared answer: a link to a file I cannot open opens the attached copy, no lock; the other file keeps its lock', async ({ page }) => {
  const { served } = await openRoom(page)
  const quote = page.getByTestId('room-shared-answer')
  const link = quote.getByTestId('team-file-chip')
  await expect(link).toHaveText('acme 덱')
  await expect(link).toHaveAttribute('data-copy', '')
  await expect(link).toHaveAttribute('title', '첨부된 파일을 열어요')
  await expect(quote.getByTestId('team-file-text')).toHaveText(/예산표/)
  await expect(quote.getByTestId('team-file-lock')).toHaveCount(1)
  await audit(page, 'shared answer with a copy')
  const asked: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/files/download')) asked.push(r.url()) })
  await link.click()
  await expect(panel(page).getByTestId('file-panel-title')).toHaveText('acme-deck.html')
  await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('h1')).toHaveText('acme 덱 (첨부본)')
  // the copy came through the room; the team file was never asked for
  expect(served).toContain('acme-deck.html')
  expect(asked).toEqual([])
})

test('a member who can open the team file gets the team file itself', async ({ page }) => {
  await openRoom(page, { openable: true })
  const link = page.getByTestId('room-shared-answer').getByTestId('team-file-chip')
  await expect(link).not.toHaveAttribute('data-copy', '')
  const [req] = await Promise.all([page.waitForRequest((r) => new URL(r.url()).pathname === '/api/files/download' && new URL(r.url()).searchParams.get('path') === DECK), link.click()])
  expect(req).toBeTruthy()
  await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('h1')).toHaveText('acme 덱 (팀 파일)')
  // a team file: "open in Files" is there
  await expect(panel(page).getByRole('button', { name: '파일 화면에서 열기' })).toBeVisible()
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the chips fit, a tap opens the full-screen sheet, the sheet downloads from its menu and closes', async ({ page }) => {
    await openRoom(page)
    for (const c of await page.getByTestId('room-file').all()) {
      const b = (await c.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(390)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await audit(page, 'room on a phone')
    await chip(page, 'acme-deck.html').getByTestId('room-file-open').click()
    const sheet = panel(page)
    await expect(sheet).toBeVisible()
    const box = (await sheet.boundingBox())!
    expect(box.width).toBe(390)
    expect(Math.round(box.x)).toBe(0)
    await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('#out')).toHaveText('blocked')
    await audit(page, 'sheet on a phone')
    await sheet.getByTestId('file-panel-more').click()
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-more-download').click()])
    expect(d.suggestedFilename()).toBe('acme-deck.html')
    expect(isRoomDownload(d, 501)).toBe(true)
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(page.getByTestId('room-message')).toHaveCount(2)
  })
})

test('screenshots of room files (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width, height })
      await openRoom(page)
      await page.mouse.move(0, height - 1)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/room-files-${width}-${scheme}.png` })
      await chip(page, 'acme-handbook.pdf').hover()
      await page.screenshot({ path: `${dir}/room-files-hover-${width}-${scheme}.png`, clip: width > 400 ? undefined : undefined })
      await chip(page, 'acme-deck.html').getByTestId('room-file-open').click()
      await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('h1')).toBeVisible()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/room-files-panel-${width}-${scheme}.png` })
      await page.getByTestId('file-panel').getByRole('button', { name: '닫기' }).click()
    }
  }
})
