// Leaving a team project (docs/DECISIONS.md "Leaving a project"; QA TC-1020), at 1440 and 390 px with axe on each
// screen: Bob, who is in the project through the 영업 group, leaves it from the project page's name menu (a phone: the
// bar's "···" sheet); one confirm in plain words; he lands on the list without it, his own chat there is his chat now;
// the owner's members dialog shows the group with "Bob 제외" on its row. The last person in a project sees the item off
// with what to do instead (the page's menu; on a computer the card's "…" too).
// SHOT_DIR: where the screenshots go (none without it).
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
const shot = async (page: Page, name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) }) }

/** Sora and a group 영업 with Bob and Sora in it (made by the owner); its id */
async function seed(page: Page) {
  expect((await page.request.post('/api/admin/users', { headers: H, data: { id: 'sora', username: 'sora', name: '김소라', role: 'member', groupIds: [], temporaryPassword: 'sora-Password-1' } })).ok()).toBeTruthy()
  const g = await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업', memberIds: ['bob', 'sora'] } })
  const gid = ((await g.json()) as { id: string }).id
  for (const id of ['bob', 'sora']) expect((await page.request.patch(`/api/admin/users/${id}`, { headers: H, data: { groupIds: [gid] } })).ok()).toBeTruthy()
  return gid
}
async function project(page: Page, name: string, participants: { subjectType: 'group' | 'user'; subjectId: string }[]) {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', participants, instructions: '' } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}

const VIEWPORTS = [
  { name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } },
  { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } },
]
for (const vp of VIEWPORTS) {
  test.describe(`leaving a project at ${vp.name}`, () => {
    test.use(vp.use)
    const asBob = async (browser: Browser): Promise<Page> => {
      const ctx = await browser.newContext({ locale: 'ko-KR', serviceWorkers: 'block', ...vp.use })
      const b = await ctx.newPage()
      await signIn(b, BOB)
      return b
    }

    test('through a group: the page menu, one confirm, the list without it; the owner sees "Bob 제외" on the group', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const gid = await seed(page)
      const id = await project(page, '견적서 제작', [{ subjectType: 'group', subjectId: gid }])
      const b = await asBob(browser)
      const mine = await b.request.post('/api/chats', { headers: H, data: { title: '내 메모', projectId: id } })
      expect(mine.ok()).toBeTruthy()
      const chatId = ((await mine.json()) as { id: string }).id

      await b.goto(`/projects/${id}`)
      await b.getByTestId('project-menu').click()
      const leave = b.getByTestId('project-leave')
      await expect(leave).toBeVisible()
      await expect(leave).toHaveText(t['projects.leave'])
      await expect(leave).toBeEnabled()
      await shot(b, `leave-menu-${vp.name}`)
      await audit(b, 'menu open')
      await leave.click()
      const dialog = b.getByRole('dialog')
      await expect(dialog.getByRole('heading')).toHaveText(translate('ko', 'projects.leaveTitle', { name: '견적서 제작' }))
      await expect(dialog).toContainText(t['projects.leaveBody'])
      await shot(b, `leave-confirm-${vp.name}`)
      await audit(b, 'leave confirm')
      await dialog.getByTestId('dialog-confirm').click()
      await expect(dialog).toHaveCount(0)
      await expect(b).toHaveURL(/\/projects$/)
      await expect(b.getByText(translate('ko', 'projects.left', { name: '견적서 제작' }))).toBeVisible()
      await shot(b, `leave-done-${vp.name}`)
      expect((await b.request.get(`/api/projects/${id}`)).status()).toBe(404)
      // his own chat there is his chat now
      expect(((await (await b.request.get(`/api/chats/${chatId}`)).json()) as { projectId: string | null }).projectId).toBeNull()

      // the owner: the group stays, with Bob as its exception
      await page.goto(`/projects/${id}?members=1`)
      const row = page.getByTestId(`participant-group-${gid}`)
      await expect(row).toContainText(translate('ko', 'projects.except', { names: 'Bob' }))
      await expect(page.getByTestId('project-other-rules')).toHaveCount(0)
      await shot(page, `leave-members-except-${vp.name}`)
      await audit(page, 'members dialog with an exception')
    })

    test('the last person: Leave is off, with what to do instead', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      await seed(page)
      const b = await asBob(browser)
      const r = await b.request.post('/api/projects', { headers: H, data: { name: '혼자 프로젝트', scope: 'team', participants: [], instructions: '' } })
      expect(r.status()).toBe(201)
      const id = ((await r.json()) as { id: string }).id
      await b.goto(`/projects/${id}`)
      await b.getByTestId('project-menu').click()
      const leave = b.getByTestId('project-leave')
      await expect(leave).toBeDisabled()
      await expect(leave).toContainText(t['projects.leaveLast'])
      await shot(b, `leave-last-${vp.name}`)
      await audit(b, 'last person menu')
      if (!vp.phone) {
        await b.keyboard.press('Escape')
        await b.goto('/projects')
        const card = b.getByTestId('project-card').filter({ hasText: '혼자 프로젝트' })
        await card.hover()
        await card.getByTestId('project-card-menu').click()
        await expect(card.getByTestId('project-card-leave')).toBeDisabled()
        await expect(card.getByTestId('project-card-leave')).toContainText(t['projects.leaveLast'])
      }
      expect((await b.request.post(`/api/projects/${id}/leave`, { headers: H })).status()).toBe(409)
    })
  })
}
