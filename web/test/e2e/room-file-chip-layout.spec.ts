// A room box's file chip keeps its file name readable (QA TC-4540): at a phone's width a refused file's reason, with
// the owner's and admins' two links ("See what uses the space", "Choose a plan"), took the chip's width and left the
// name three letters ("QA-…"). A failed chip in a narrow box (a phone's, a thread's beside the room on a computer) now
// says its reason on a line of its own under the name.
// Measured in every state of the chip, at a computer's width and a phone's, light and dark: the name is whole, or cut
// with "…" only once it has a readable width; the chip is inside its list and on the screen; nothing scrolls sideways.
// The room is answered through page.route (rooms-mock.ts). SHOTS_DIR=<folder>: the box in each state.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { en } from '../../src/i18n/en'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block' })

const BEN = { id: 'ben', name: 'Ben' }
const BOB = { username: 'bob', password: 'bob password 1' }
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const NAME = 'QA-RF-30MB.bin'
const LONG = 'Quarterly storage report for the whole team, final version 3 (reviewed).pdf'
const small = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(2000, 1) })
/** a file that goes in pieces (over 8 MB): its chip says what happens to it */
const large = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 1) })
const FULL = { error: { code: 'storage_full', message: 'The storage is full.', params: { manageUrl: 'https://example.com/plans' } } }
const TOO_BIG = 'The file is larger than 1 GB.'
/** the least width a cut name keeps: about fifteen letters of the chip's text, enough to tell files apart */
const READABLE = 96

const ROOT = '019a5f00-0000-7000-8000-000000000001'
async function openRoom(page: Page, who?: typeof BOB, at = `/rooms/${ROOM_ID}`) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, who)
  await routeRoom(page, { members: [BEN], messages: [{ id: ROOT, author: BEN, body: 'Please send the report' }], ...(who ? { me: { id: 'bob', name: 'Bob' } } : {}) })
  await page.goto(at)
  // (a phone's thread covers the room: the thread itself is what shows there)
  await expect(at.includes('/t/') ? page.getByTestId('room-thread').getByTestId('thread-count') : page.getByTestId('room-message').first()).toBeVisible()
}
/** every small upload of the room is answered with this */
const answerFiles = (page: Page, status: number, body: unknown) => page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), (route) => route.fulfill(json(body, status)))

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

/** The chip's name as it is drawn: `shown` px of the `whole` px its text needs. */
async function nameWidth(chip: Locator) {
  return chip.getByTestId('room-file-name').evaluate((el) => ({ shown: Math.round(el.getBoundingClientRect().width), whole: el.scrollWidth, cut: el.scrollWidth > el.clientWidth + 1 }))
}
/** The name is whole, or cut only at a readable width; the chip ends on the screen; nothing scrolls sideways. */
async function readable(page: Page, chip: Locator, label: string) {
  const n = await nameWidth(chip)
  // (the numbers of a run, for the QA row: MEASURE=1)
  if (process.env.MEASURE) console.log(`[chip] ${label}: name ${n.shown}px of ${n.whole}px${n.cut ? ' (cut)' : ''}`)
  if (n.cut) expect(n.shown, `${label}: the cut name's width`).toBeGreaterThanOrEqual(READABLE)
  // inside its list (a chip wider than the box would be clipped by it, not by the screen), and on the screen
  const box = (await chip.boundingBox())!
  const list = (await chip.locator('xpath=ancestor::*[@data-testid="room-file-chips"]').boundingBox())!
  expect(box.width, `${label}: the chip is no wider than its list`).toBeLessThanOrEqual(list.width)
  expect(box.x, `${label}: the chip's left edge`).toBeGreaterThanOrEqual(Math.max(0, list.x))
  expect(box.x + box.width, `${label}: the chip's right edge`).toBeLessThanOrEqual(Math.min(page.viewportSize()!.width, list.x + list.width))
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${label}: no sideways scroll`).toBeLessThanOrEqual(0)
  return n
}
/** a failed chip in a narrow box: the reason starts under the name, not beside it; in a wide box it stays one row */
async function reasonPlace(chip: Locator, narrow: boolean) {
  const name = (await chip.getByTestId('room-file-name').boundingBox())!
  const reason = (await chip.getByRole('status').boundingBox())!
  if (narrow) {
    expect(reason.y).toBeGreaterThanOrEqual(name.y + name.height - 1)
    expect(Math.abs(reason.x - name.x)).toBeLessThanOrEqual(1)
  } else expect(reason.x).toBeGreaterThanOrEqual(name.x + name.width)
}

for (const size of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${size.name} px, ${scheme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme })
      const phone = size.width < 768
      const tag = `${size.name}-${scheme}`

      test('a file refused for a full disk, the owner: the name is whole beside or over the reason and its two links', async ({ page }) => {
        await openRoom(page)
        await answerFiles(page, 507, FULL)
        await page.getByTestId('room-file-input').setInputFiles(small(NAME))
        const chip = page.getByTestId('room-file-chip')
        await expect(chip).toHaveAttribute('data-status', 'failed')
        await expect(chip.getByRole('status')).toHaveText(en['rooms.storageFull'])
        await expect(chip.getByTestId('room-storage-full-see')).toBeVisible()
        await expect(chip.getByTestId('storage-plans')).toBeVisible()
        const n = await readable(page, chip, `refused-owner-${tag}`)
        expect(n.cut, 'a short name is not cut').toBe(false)
        await reasonPlace(chip, phone)
        await shot(page, `refused-owner-${tag}.png`)

        // a long name: cut with "…", at a width that still reads
        await chip.getByTestId('chip-remove').click()
        await page.getByTestId('room-file-input').setInputFiles(small(LONG))
        await expect(chip).toHaveAttribute('data-status', 'failed')
        const long = await readable(page, chip, `refused-owner-long-${tag}`)
        expect(long.cut).toBe(true)
        await reasonPlace(chip, phone)
        await shot(page, `refused-owner-long-${tag}.png`)
      })

      test('a file refused for a full disk, a member: the reason and "See the files you sent", the name whole', async ({ page }) => {
        await openRoom(page, BOB)
        await answerFiles(page, 507, FULL)
        await page.getByTestId('room-file-input').setInputFiles(small(NAME))
        const chip = page.getByTestId('room-file-chip')
        await expect(chip).toHaveAttribute('data-status', 'failed')
        await expect(chip.getByRole('status')).toHaveText(en['rooms.storageFullAsk'])
        await expect(chip.getByTestId('room-storage-full-see')).toHaveCount(0)
        await expect(chip.getByTestId('storage-plans')).toHaveCount(0)
        const n = await readable(page, chip, `refused-member-${tag}`)
        expect(n.cut).toBe(false)
        await reasonPlace(chip, phone)
        await shot(page, `refused-member-${tag}.png`)
      })

      test('a file the server finds too big: the name whole with the reason', async ({ page }) => {
        await openRoom(page)
        await answerFiles(page, 413, { error: { code: 'payload_too_large', message: TOO_BIG, params: { reason: 'room_file_too_large' } } })
        await page.getByTestId('room-file-input').setInputFiles(small(NAME))
        const chip = page.getByTestId('room-file-chip')
        await expect(chip).toHaveAttribute('data-status', 'failed')
        const n = await readable(page, chip, `too-big-${tag}`)
        expect(n.cut).toBe(false)
        await reasonPlace(chip, phone)
        await shot(page, `too-big-${tag}.png`)
      })

      test('an upload the reload stopped: the name whole with "Upload stopped…"', async ({ page }) => {
        await openRoom(page)
        // an upload that never ends: the reload cuts it
        await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), () => {})
        await page.getByTestId('room-file-input').setInputFiles(small(NAME))
        const chip = page.getByTestId('room-file-chip')
        await expect(chip).toHaveAttribute('data-status', 'uploading')
        // (the browser asks "leave this page?" while a file is on its way: yes)
        page.on('dialog', (d) => void d.accept())
        await page.reload()
        await expect(chip).toHaveAttribute('data-status', 'failed')
        await expect(chip.getByRole('status')).toHaveText(en['rooms.uploadStopped'])
        const n = await readable(page, chip, `stopped-${tag}`)
        expect(n.cut).toBe(false)
        await reasonPlace(chip, phone)
        await shot(page, `stopped-${tag}.png`)
      })

      test('a thread\'s box: narrow at a computer\'s width too, so the refused file\'s name is whole over the reason there', async ({ page }) => {
        await openRoom(page, undefined, `/rooms/${ROOM_ID}/t/${ROOT}`)
        await answerFiles(page, 507, FULL)
        const thread = page.getByTestId('room-thread')
        await thread.getByTestId('room-file-input').setInputFiles(small(NAME))
        const chip = thread.getByTestId('room-file-chip')
        await expect(chip).toHaveAttribute('data-status', 'failed')
        await expect(chip.getByTestId('room-storage-full-see')).toBeVisible()
        await expect(chip.getByTestId('storage-plans')).toBeVisible()
        const n = await readable(page, chip, `thread-refused-owner-${tag}`)
        expect(n.cut).toBe(false)
        await reasonPlace(chip, true)
        await shot(page, `thread-refused-owner-${tag}.png`)
      })

      test('large files on their way: a percent, and "Waiting for its turn" behind three others, each name whole on one row', async ({ page }) => {
        await openRoom(page)
        // each file's first piece arrives, its second never does: the chip stays at its percent
        await page.route(/\/api\/upload-sessions\/[^/]+\/chunks\/1$/, () => {})
        await page.getByTestId('room-file-input').setInputFiles([large(NAME), large('b.bin'), large('c.bin'), large('d.bin')])
        const chips = page.getByTestId('room-file-chip')
        await expect(chips).toHaveCount(4)
        const first = chips.first()
        await expect(first.getByTestId('room-file-progress')).toContainText(/\d+%/)
        await expect(chips.nth(3).getByTestId('room-file-progress')).toContainText(en['files.waitingTurn'])
        const n = await readable(page, first, `percent-${tag}`)
        expect(n.cut).toBe(false)
        // one row: the words beside the name, as before
        const name = (await first.getByTestId('room-file-name').boundingBox())!
        const words = (await first.getByTestId('room-file-progress').boundingBox())!
        expect(words.x).toBeGreaterThanOrEqual(name.x + name.width)
        await shot(page, `percent-${tag}.png`)

        // the one that waits (a phone's row scrolls sideways to it)
        const waits = chips.nth(3)
        await waits.scrollIntoViewIfNeeded()
        const w = await readable(page, waits, `waiting-${tag}`)
        expect(w.cut).toBe(false)
        const wn = (await waits.getByTestId('room-file-name').boundingBox())!
        const ww = (await waits.getByTestId('room-file-progress').boundingBox())!
        expect(ww.x).toBeGreaterThanOrEqual(wn.x + wn.width)
        await shot(page, `waiting-${tag}.png`)
      })
    })
  }
}
