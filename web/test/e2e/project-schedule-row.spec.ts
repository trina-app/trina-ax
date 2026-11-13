// A project page's chat list with a scheduled task's runs folded into one row (QA TC-990; components/nav/TaskRunsRow.tsx
// foldRuns' `task` row, pages/Projects.tsx ProjectTaskRow): the task's row is a row of that list, not the sidebar's.
// Its title starts where the other chats' titles start, in the same size, weight and colour, its clock after the title,
// and its time ends where theirs end. "기존 대화 가져오기" (QA TC-1001) is a quiet action at the end of the heading's line
// for a member, whatever the number of chats (5+ too, a task's runs among them), and the "···" that shows on a row's
// hover does not move its time. A computer and a phone, light and dark, the owner and a member. TC_SHOTS=<folder> keeps
// screenshots.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${width}px ${scheme}: the scheduled row's title, look and time line up with the other chats`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await signIn(page)
      const r = await post(page, '/api/projects', { name: 'Daily briefs', scope: 'personal', instructions: '' })
      expect(r.status()).toBe(201)
      const id = ((await r.json()) as { id: string }).id
      expect((await page.request.post('/__test/schedule', { data: { title: '평일 뉴스 브리핑', runs: 3, projectId: id } })).ok()).toBeTruthy()
      for (const title of ['Gemini Decisions API 댓글 초안', 'Hacker News 비공식 문서 요약'])
        expect((await post(page, '/api/chats', { projectId: id, title })).ok()).toBeTruthy()
      await page.goto(`/projects/${id}`)
      const list = page.getByTestId('project-chats')
      const chats = list.getByTestId('project-chat')
      const task = list.getByTestId('task-runs-row')
      await expect(chats).toHaveCount(2)
      await expect(task).toHaveCount(1)
      await expect(task).toContainText('평일 뉴스 브리핑')
      await list.scrollIntoViewIfNeeded()
      if (process.env.TC_SHOTS) await list.screenshot({ path: `${process.env.TC_SHOTS}/tc990-${width}-${scheme}.png` })

      // one title each (data-testid="project-row-title"): the same left edge, size, weight and colour
      const look = (row: Locator) =>
        row.getByTestId('project-row-title').evaluate((el) => {
          const s = getComputedStyle(el), b = el.getBoundingClientRect()
          return { x: b.x, size: s.fontSize, weight: s.fontWeight, color: s.color }
        })
      const plain = await look(chats.first()), other = await look(chats.nth(1)), sched = await look(task)
      expect(Math.abs(sched.x - plain.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(other.x - plain.x)).toBeLessThanOrEqual(1)
      expect({ ...sched, x: 0 }).toEqual({ ...plain, x: 0 })
      // the clock stays, after the title
      const clock = await task.getByRole('img', { name: '예약 작업' }).boundingBox()
      expect(clock!.x).toBeGreaterThan(sched.x)
      // the times end at the same x (the column on the right)
      const end = async (row: Locator) => {
        const b = (await row.locator('time').boundingBox())!
        return b.x + b.width
      }
      expect(Math.abs((await end(task)) - (await end(chats.first())))).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${width}px ${scheme}: "bring in chats" stays on the heading's line with many chats, for the owner and a member`, async ({ page, browser }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await signIn(page)
      const r = await post(page, '/api/projects', { name: 'Kite', participants: [{ subjectType: 'user', subjectId: 'bob' }] })
      expect(r.ok()).toBeTruthy()
      const id = ((await r.json()) as { id: string }).id
      expect((await page.request.patch(`/api/projects/${id}`, { headers: { [CSRF_HEADER]: '1' }, data: { shareChats: true } })).ok()).toBeTruthy()
      expect((await page.request.post('/__test/schedule', { data: { title: '평일 뉴스 브리핑', runs: 3, projectId: id } })).ok()).toBeTruthy()
      for (const title of ['Weekly numbers', 'Launch plan review', 'Hacker News 비공식 문서 요약', 'Gemini Decisions API 댓글 초안', 'Q4 budget notes'])
        expect((await post(page, '/api/chats', { projectId: id, title })).ok()).toBeTruthy()
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', viewport: { width, height }, colorScheme: scheme, serviceWorkers: 'block' })
      const bob = await ctx.newPage()
      await signIn(bob, BOB)
      for (const [who, p] of [['owner', page], ['member', bob]] as const) {
        await p.goto(`/projects/${id}`)
        const list = p.getByTestId('project-chats')
        await expect(list.getByTestId('project-chat')).toHaveCount(5)
        await expect(list.getByTestId('task-runs-row')).toHaveCount(1)
        await list.scrollIntoViewIfNeeded()
        if (process.env.TC_SHOTS) await list.screenshot({ path: `${process.env.TC_SHOTS}/tc1001-${width}-${scheme}-${who}.png` })
        // on the heading's line, at its end, on the heading's baseline; 44px to tap on a phone
        const heading = list.getByRole('heading', { level: 2 })
        const bring = list.getByTestId('project-import')
        await expect(bring).toBeVisible()
        const [h, b, l] = [(await heading.boundingBox())!, (await bring.boundingBox())!, (await list.boundingBox())!]
        expect(Math.abs(b.x + b.width - (l.x + l.width))).toBeLessThanOrEqual(1)
        const base = (el: typeof heading) => el.evaluate((e) => {
          // its words' baseline: the bottom of their text box less the font's descent
          const text = [...e.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!
          const range = document.createRange()
          range.selectNodeContents(text)
          const ctx = document.createElement('canvas').getContext('2d')!
          ctx.font = getComputedStyle(e).font
          return range.getBoundingClientRect().bottom - ctx.measureText(text.textContent!).fontBoundingBoxDescent
        })
        // centred on the heading's line: the button's icon sets its own baseline, so the words sit within 2px of the
        // heading's baseline (17px beside 13px), its middle on the heading's middle
        expect(Math.abs((await base(heading)) - (await base(bring)))).toBeLessThanOrEqual(2)
        expect(Math.abs(h.y + h.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(1)
        if (width < 768) expect(b.height).toBeGreaterThanOrEqual(44)
        // every title at one x: the shared chats' people icon and the task's clock come after their titles
        const xs = await list.getByTestId('project-row-title').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))
        expect(xs).toHaveLength(6)
        expect(new Set(xs).size).toBe(1)
        // every row the same height (inside the divider lines); the "···" on hover does not move a row's time
        const heights = await list.locator('ul > li').evaluateAll((xs) => xs.map((x) => x.clientHeight))
        expect(heights).toEqual(heights.map(() => heights[0]))
        const row = list.getByTestId('project-chat').first()
        const time = row.locator('time')
        const before = (await time.boundingBox())!
        await row.hover()
        await expect(list.getByTestId('project-chat-menu').first()).toBeVisible()
        const after = (await time.boundingBox())!
        expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5)
        expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
      await ctx.close()
    })
  }
}
