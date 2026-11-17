// "Save to team folder" on a room file (components/rooms/RoomMessages.tsx FileChip, components/FileMenu.tsx,
// components/rooms/SaveToTeamSheet.tsx; docs/decisions/20261117-room-file-save-btn.md). On a computer the chip shows a
// small save icon on hover beside the download; it opens "Where should this go?" with the suggested folder picked, the
// folder's audience outside the conversation, Cancel and Save; Save copies the message's files there and the chip
// becomes a quiet "In team folder" link that opens the file. On a phone the icon is not shown: the long-press menu has
// the action. A picture has it in its menu. A guest never sees it. The room and the save routes are answered through
// page.route as the team server sends them (the server's checks: tests/unit/b-rooms-save-to-team.test.ts).
// SHOTS_DIR=<folder>: the screens (team room, DM, thread × 1440 and 390 × light and dark; owner, member, guest).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: 'Sora Kim' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const QUOTE = { id: id(701), name: 'acme-quote-nov.pdf', size: 48_213, mime: 'application/pdf', kind: 'pdf', thumb: false }
const PRICES = { id: id(702), name: 'acme-price-list.xlsx', size: 12_400, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'spreadsheet', thumb: false }
const LOGO = { id: id(703), name: 'acme-logo.png', size: PNG.length, mime: 'image/png', kind: 'image', thumb: true, width: 192, height: 192 }
const FOLDER = 'shared/Acme/Quotes'

type Saves = { saved: Map<string, string>; bodies: unknown[] }

/** The room (team, DM or a group chat) with Sora's message of two files, her picture, and a thread with a file in it;
 * the save routes as the server answers them. `me`: who reads (the owner olga by default). */
async function openRoom(page: Page, o: { kind?: 'team' | 'dm' | 'group'; me?: { id: string; name: string }; saved?: string[]; sensitive?: boolean } = {}): Promise<Saves> {
  const s: Saves = { saved: new Map((o.saved ?? []).map((f) => [f, `${FOLDER}/${f === PRICES.id ? PRICES.name : QUOTE.name}`])), bodies: [] }
  await routeRoom(page, {
    kind: o.kind ?? 'team',
    members: [SORA],
    ...(o.me ? { me: o.me } : {}),
    room: o.kind === 'dm' ? {} : { name: 'acme-deal' },
    messages: [
      { id: id(1), author: SORA, body: 'Acme sent the November quote and their price list', extra: { files: [QUOTE, PRICES], thread: { replyCount: 1, repliers: [SORA], lastReplyAt: '2026-11-05T09:10:00.000Z', newReplies: false } } },
      { id: id(2), author: SORA, body: 'Their logo for the deck', extra: { files: [LOGO] } },
      { id: id(3), author: SORA, body: 'Signed copy', threadRootId: id(1), extra: { files: [{ ...QUOTE, id: id(704), name: 'acme-quote-signed.pdf' }] } },
    ],
  })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.route(/\/api\/rooms\/[^/]+\/saved-files$/, (route) => route.fulfill({ json: { items: [...s.saved].map(([fileId, p]) => ({ fileId, path: p })) } }))
  await page.route(/\/api\/rooms\/[^/]+\/save-plan$/, async (route) => {
    const body = route.request().postDataJSON() as { fileIds: string[]; folder?: string }
    const all = [QUOTE, PRICES, LOGO, { ...QUOTE, id: id(704), name: 'acme-quote-signed.pdf' }]
    const files = body.fileIds.map((fid) => all.find((f) => f.id === fid)!).map((f) => ({ id: f.id, name: f.name, size: f.size, ...(s.saved.has(f.id) ? { savedPath: s.saved.get(f.id) } : {}) }))
    if (body.folder) return route.fulfill({ json: { files, suggestion: null, sensitive: !!o.sensitive, folder: { path: body.folder, outside: 0 } } })
    return route.fulfill({ json: { files, suggestion: o.sensitive ? null : { path: FOLDER, why: 'suggested', outside: 12 }, sensitive: !!o.sensitive } })
  })
  await page.route(/\/api\/rooms\/[^/]+\/save-to-team$/, async (route) => {
    const body = route.request().postDataJSON() as { fileIds: string[]; folder: string }
    s.bodies.push(body)
    const saved = body.fileIds.map((fid) => ({ fileId: fid, path: `${body.folder}/${fid === PRICES.id ? PRICES.name : QUOTE.name}`, existed: false }))
    for (const x of saved) s.saved.set(x.fileId, x.path)
    return route.fulfill({ json: { saved } })
  })
  return s
}

async function asMember(page: Page) {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('bob')
  await page.getByTestId('login-password').fill('bob password 1')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('composer-input').or(page.getByTestId('rooms-page')).first()).toBeVisible()
}

test('computer: the icon on hover, the sheet with the suggestion and its audience, Save, then "In team folder" opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const s = await openRoom(page)
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  const chip = page.getByTestId('room-file').filter({ hasText: QUOTE.name })
  await expect(chip).toBeVisible()
  const save = chip.getByTestId('room-file-save')
  // quiet until the chip is hovered
  await expect(save).toHaveCSS('opacity', '0')
  await chip.hover()
  await expect(save).toHaveCSS('opacity', '1')
  await expect(save).toHaveAccessibleName(`Save ${QUOTE.name} to team folder`)
  await save.click()
  const sheet = page.getByTestId('room-save-sheet')
  await expect(page.getByRole('dialog', { name: 'Where should this go?' })).toBeVisible()
  await expect(sheet.getByTestId('room-save-place')).toContainText('Acme › Quotes')
  await expect(sheet.getByTestId('room-save-place')).toContainText('Suggested')
  await expect(sheet.getByTestId('room-save-audience')).toHaveText('12 people outside this conversation can see this folder.')
  // both files of the message, one sheet
  await expect(sheet.getByTestId('room-save-files').locator('li')).toHaveCount(2)
  await page.getByTestId('room-save-confirm').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(s.bodies).toEqual([{ fileIds: [QUOTE.id, PRICES.id], folder: FOLDER }])
  const link = chip.getByTestId('room-file-in-team')
  await expect(link).toHaveText('Quotes')
  await expect(link).toHaveAccessibleName(/^In team folder · .*Acme › Quotes$/)
  await expect(chip.getByTestId('room-file-save')).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/files/view\\?path=${encodeURIComponent(`${FOLDER}/${QUOTE.name}`).replace(/[.]/g, '\\.')}$`))
})

test('computer: a picture has it in its right-click menu; a personal-looking file gets no suggestion', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await openRoom(page, { sensitive: true })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-image').click({ button: 'right' })
  await page.getByTestId('file-menu-save-team').click()
  await expect(page.getByTestId('room-save-sensitive')).toBeVisible()
  await expect(page.getByTestId('room-save-place')).toHaveCount(0)
  await expect(page.getByTestId('room-save-confirm')).toBeDisabled()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('no icon on the chip; the long-press menu saves; 44px targets', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    const s = await openRoom(page, { saved: [PRICES.id] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    const chip = page.getByTestId('room-file').filter({ hasText: QUOTE.name })
    await expect(chip).toBeVisible()
    await expect(chip.getByTestId('room-file-save')).toBeHidden()
    // the saved one: its link takes taps from 44px
    const inTeam = page.getByTestId('room-file').filter({ hasText: PRICES.name }).getByTestId('room-file-in-team')
    await expect(inTeam).toBeVisible()
    const after = await inTeam.evaluate((e) => { const st = getComputedStyle(e, '::after'); return { w: parseFloat(st.width), h: parseFloat(st.height) } })
    expect(after.w).toBeGreaterThanOrEqual(44)
    expect(after.h).toBeGreaterThanOrEqual(44)
    // a long press on the chip
    await chip.getByTestId('room-file-open').dispatchEvent('contextmenu')
    const item = page.getByTestId('file-menu-save-team')
    await expect(item).toBeVisible()
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await item.click()
    await expect(page.getByTestId('room-save-sheet')).toBeVisible()
    for (const t of ['room-save-choose', 'room-save-confirm']) expect((await page.getByTestId(t).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.getByTestId('room-save-confirm').click()
    await expect(page.getByTestId('room-save-sheet')).toHaveCount(0)
    // the price list was there already: only the quote is copied
    expect(s.bodies).toEqual([{ fileIds: [QUOTE.id], folder: FOLDER }])
  })
})

test('a guest sees no save, in the chip or the menu, and the saved list is never asked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: ROOM_ID }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  let asked = 0
  await openRoom(page, { kind: 'group', me: { id: 'gina', name: 'Gina' } })
  page.on('request', (r) => { if (r.url().endsWith('/saved-files')) asked++ })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await page.goto(`/rooms/${ROOM_ID}`)
  const chip = page.getByTestId('room-file').filter({ hasText: QUOTE.name })
  await chip.hover()
  await expect(chip.getByTestId('room-file-download')).toBeVisible()
  await expect(chip.getByTestId('room-file-save')).toHaveCount(0)
  await chip.getByTestId('room-file-open').click({ button: 'right' })
  await expect(page.getByTestId('file-menu-download')).toBeVisible()
  await expect(page.getByTestId('file-menu-save-team')).toHaveCount(0)
  expect(asked).toBe(0)
})

for (const role of ['owner', 'member', 'guest'] as const) test(`screenshots for review (SHOTS_DIR), ${role}: team room, DM, thread × 1440 and 390 × light and dark`, async ({ browser }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'SHOTS_DIR not set')
  test.setTimeout(600_000)
  fs.mkdirSync(dir!, { recursive: true })
  {
    const places = role === 'guest' ? (['group'] as const) : (['team', 'dm', 'thread'] as const)
    for (const width of [1440, 390]) {
      const phone = width === 390
      const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block' })
      const page = await ctx.newPage()
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      if (role === 'guest') expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: ROOM_ID }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
      for (const place of places) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        const me = role === 'member' ? { id: 'bob', name: 'Bob' } : role === 'guest' ? { id: 'gina', name: 'Gina' } : undefined
        await openRoom(page, { kind: place === 'dm' ? 'dm' : place === 'group' ? 'group' : 'team', saved: [PRICES.id], ...(me ? { me } : {}) })
        if (place === places[0]) {
          if (role === 'owner') await signIn(page)
          else if (role === 'member') await asMember(page)
          else {
            await page.goto('/login')
            await page.getByTestId('login-username').fill('gina')
            await page.getByTestId('login-password').fill('gina password 1')
            await page.getByTestId('login-submit').click()
            await page.waitForURL((u) => !u.pathname.startsWith('/login'))
          }
        }
        await page.goto(place === 'thread' ? `/rooms/${ROOM_ID}/t/${id(1)}` : `/rooms/${ROOM_ID}`)
        const target = page.getByTestId('room-file').filter({ hasText: place === 'thread' ? 'acme-quote-signed.pdf' : QUOTE.name }).last()
        await expect(target).toBeVisible()
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
          const name = `${role}-${place}-${width}-${scheme}`
          const chip = target
          if (!phone) await chip.hover()
          await page.screenshot({ path: path.join(dir!, `${name}-chips.png`) })
          if (role === 'guest') continue
          if (phone) {
            await chip.getByTestId('room-file-open').dispatchEvent('contextmenu')
            await expect(page.getByTestId('file-menu-save-team')).toBeVisible()
            await page.screenshot({ path: path.join(dir!, `${name}-menu.png`) })
            await page.getByTestId('file-menu-save-team').click()
          } else await chip.getByTestId('room-file-save').click()
          await expect(page.getByTestId('room-save-place')).toBeVisible()
          await expect(page.getByTestId('room-save-confirm')).toBeEnabled()
          await page.screenshot({ path: path.join(dir!, `${name}-sheet.png`) })
          await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
          await expect(page.getByTestId('room-save-sheet')).toHaveCount(0)
        }
        await page.emulateMedia({ colorScheme: 'light' })
      }
      await ctx.close()
    }
  }
})
