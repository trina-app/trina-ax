// "Files you sent" at 390 (QA TC-4729): a file sent in a direct message had the meta line "Direct message · <person> ·
// time …", its size cut off by the line's ellipsis. The list is sorted by size, so the size must always show: where the
// file was sent is shortened first (ListRow `metaKeep`), the time and the size stay whole. Also at 1440, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const SHOTS = process.env.SENT_FILES_SHOTS

const at = new Date(new Date().setHours(17, 41, 0, 0)).toISOString()
const dm = { id: uuidv7(), kind: 'dm', name: null, peers: [{ id: 'peer-1', name: 'Alexandra Montgomery-Whitfield' }], memberCount: 2 }
const team = { id: uuidv7(), kind: 'team', name: 'general', peers: [], memberCount: 5 }
const file = (name: string, size: number) => ({ id: uuidv7(), name, size, mime: 'application/pdf', kind: 'pdf', thumb: false })
const hit = (room: { id: string }, f: ReturnType<typeof file>) => ({ file: f, messageId: uuidv7(), roomId: room.id, threadRootId: null, author: { id: 'olga', name: 'Olga' }, createdAt: at })
const items = [
  hit(dm, file('Quarterly budget review for the operations team.pdf', 1_234_567)),
  hit(team, file('notes.pdf', 48_000)),
  hit(dm, file('a.pdf', 2_048)),
]

async function open(page: Page) {
  await page.route('**/api/room-files/mine*', (r) => r.fulfill({ json: { items, rooms: [dm, team], nextCursor: null, totalBytes: items.reduce((n, x) => n + x.file.size, 0) } }))
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/sent-files')
  await expect(page.getByTestId('sent-file')).toHaveCount(3)
}

/** every row's size is drawn whole, inside the row (not cut by an ellipsis or the screen's edge) */
async function sizesWhole(page: Page) {
  const rows = await page.getByTestId('sent-file').evaluateAll((lis) => lis.map((li) => {
    const kept = li.querySelector('[data-testid="sent-file-meta"]')?.lastElementChild as HTMLElement | null
    const link = li.querySelector('a') as HTMLElement
    const k = kept?.getBoundingClientRect()
    const l = link.getBoundingClientRect()
    return { text: kept?.textContent ?? '', cut: kept ? kept.scrollWidth > kept.clientWidth : true, inside: !!k && k.right <= l.right + 0.5 && k.width > 0 }
  }))
  for (const r of rows) {
    expect(r.text).toMatch(/· \d[\d.,]* ?(B|KB|MB)$/)
    expect(r.cut).toBe(false)
    expect(r.inside).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme })
    test(`390: the DM file's size shows whole; the conversation part is shortened first (${scheme})`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: scheme, baseURL: test.info().project.use.baseURL })
      const page = await ctx.newPage()
      try {
        await open(page)
        await sizesWhole(page)
        const dmMeta = page.getByTestId('sent-file').first()
        await expect(dmMeta).toContainText('Direct message')
        await expect(dmMeta).toContainText('1.2 MB')
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/sent-files-390-${scheme}.png` })
      } finally {
        await ctx.close()
      }
    })
    test(`1440: the meta reads whole on one line (${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await open(page)
      await sizesWhole(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/sent-files-1440-${scheme}.png` })
    })
  })
}
