// Projects and Files lists open at once (docs/DECISIONS.md "Projects and Files lists open at once"): going back to
// 프로젝트 or 파일 shows the list as last read, with no loading placeholder, and reads each list at most once behind it
// (GET /api/projects?manage=1, /api/files/tree?path=, /api/files/recent). The first visit may show the placeholder.
// The places are opened as a person does: the rail at 1440, the tabs at 390.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { isPhone, openPlace } from './nav'

test.use({ serviceWorkers: 'block' })

/** the GET /api/... requests from here on */
function track(page: Page) {
  const log: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/') && r.method() === 'GET') log.push(u.pathname + u.search)
  })
  return log
}
/** count every loading placeholder that shows in the page from now on */
const watchSkeleton = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __sk: number }
    w.__sk = 0
    const look = () => {
      if (document.querySelector('main .animate-pulse')) w.__sk++
    }
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true })
    look()
  })
const skeletons = (page: Page) => page.evaluate(() => (window as unknown as { __sk: number }).__sk)

const LISTS = { projects: /^\/api\/projects\?manage=1$/, tree: /^\/api\/files\/tree\?path=$/, recent: /^\/api\/files\/recent/ }
const counts = (reqs: string[]) => Object.fromEntries(Object.entries(LISTS).map(([k, re]) => [k, reqs.filter((u) => re.test(u)).length]))

for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  test(`going back to Projects and Files at ${vp.w}: the last list at once, at most one read of each behind it`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h })
    await reset(page)
    const log = track(page)
    await signIn(page)
    const phone = isPhone(page)
    const projectsShown = () => expect(page.getByTestId(phone ? 'phone-projects-list' : 'project-new')).toBeVisible()
    const filesShown = () => expect(page.getByTestId(phone ? 'phone-files-home' : 'recent-files')).toBeVisible()

    // the first visits read the lists
    await openPlace(page, 'projects')
    await projectsShown()
    await openPlace(page, 'files')
    await filesShown()
    await expect(page.getByTestId('files-panel-team').first()).toBeVisible()
    if (!phone) await expect(page.getByTestId('recent-file').or(page.getByTestId('recent-files-empty')).first()).toBeVisible()
    await openPlace(page, 'trina')

    for (const [place, shown] of [['projects', projectsShown], ['files', filesShown], ['projects', projectsShown]] as const) {
      const before = log.length
      await watchSkeleton(page)
      await openPlace(page, place)
      await shown()
      if (place === 'files') await expect(page.getByTestId('files-panel-team').first()).toBeVisible()
      // the read behind it has time to come back
      await page.waitForTimeout(600)
      expect(await skeletons(page), `${place}: no loading placeholder on a visit after the first`).toBe(0)
      const c = counts(log.slice(before))
      for (const [list, n] of Object.entries(c)) expect(n, `${place}: ${list} read at most once`).toBeLessThanOrEqual(1)
      if (place === 'projects' && !phone) expect(c.projects).toBe(1)
      if (place === 'files') expect(c.tree).toBe(1)
      if (place === 'files' && !phone) expect(c.recent).toBe(1)
      await openPlace(page, 'trina')
    }
  })
}
