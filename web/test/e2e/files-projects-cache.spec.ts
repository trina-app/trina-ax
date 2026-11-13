// Folders, project pages and file previews open at once (docs/DECISIONS.md "Folders, project pages and file previews
// open at once"): going back to a project's page, a folder on the Files page or a file's preview shows it as last read,
// with no loading placeholder, and reads it once behind it (the project, its chats and its folder each once; the folder
// once; the file once). The places are left and opened again inside the app, as a click does (a reload starts from
// nothing), at 1440 and 390.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

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
/** count every loading placeholder (and the preview's spinner) that shows from now on */
const watchSkeleton = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __sk: number }
    w.__sk = 0
    const look = () => {
      if (document.querySelector('main .animate-pulse, [data-testid="file-panel"] .animate-spin')) w.__sk++
    }
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true })
    look()
  })
const skeletons = (page: Page) => page.evaluate(() => (window as unknown as { __sk: number }).__sk)
/** another address inside the app, as a link does (the page is not loaded again) */
const go = (page: Page, url: string) => page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate', { state: {} })) }, url)
const n = (log: string[], from: number, re: RegExp) => log.slice(from).filter((u) => re.test(u)).length

async function newProject(page: Page) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  const r = await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  for (const title of ['Weekly numbers', 'Launch plan review']) expect((await post('/api/chats', { projectId: id, title })).ok()).toBeTruthy()
  return id
}

for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  test(`going back to a project, a folder and a file at ${vp.w}: shown at once, read once behind it`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h })
    await reset(page)
    await signIn(page)
    const id = await newProject(page)
    const log = track(page)
    const phone = vp.w < 768
    const away = '/rooms'

    // a project's page: first visit, away, back
    await go(page, `/projects/${id}`)
    await expect(page.getByTestId('project-chat')).toHaveCount(2)
    if (!phone) await expect(page.getByTestId('project-files')).toContainText(/\d/)
    await go(page, away)
    await expect(page.getByTestId('project-chats')).toHaveCount(0)
    let from = log.length
    await watchSkeleton(page)
    await go(page, `/projects/${id}`)
    await expect(page.getByTestId('project-chat')).toHaveCount(2)
    await page.waitForTimeout(800)
    expect(await skeletons(page), 'project page: no loading placeholder on return').toBe(0)
    expect(n(log, from, new RegExp(`^/api/projects/${id}\\?manage=1$`)), 'the project read once').toBe(1)
    expect(n(log, from, /^\/api\/chats\?projectId=/), 'its chats read once').toBe(1)
    expect(n(log, from, /^\/api\/files\/tree\?path=marketing&/), 'its folder read once').toBe(1)

    // a phone: the project's files screen; a computer: the same address goes to the folder on the Files page, without
    // asking for the project again
    if (phone) {
      await go(page, `/projects/${id}/files`)
      await expect(page.getByTestId('project-file').first()).toBeVisible()
      await go(page, away)
      from = log.length
      await watchSkeleton(page)
      await go(page, `/projects/${id}/files`)
      await expect(page.getByTestId('project-file').first()).toBeVisible()
      await page.waitForTimeout(800)
      expect(await skeletons(page), 'project files: no loading placeholder on return').toBe(0)
      expect(n(log, from, /^\/api\/files\/tree\?path=marketing&/)).toBe(1)
    } else {
      from = log.length
      await go(page, `/projects/${id}/files`)
      await expect(page).toHaveURL(/\/files\?path=marketing$/)
      await expect(page.getByTestId('file-row').first()).toBeVisible()
      await page.waitForTimeout(800)
      expect(n(log, from, new RegExp(`^/api/projects/${id}`)), 'the project is not asked again').toBe(0)
      expect(n(log, from, /^\/api\/files\/tree\?path=marketing&/), 'the folder read once, not three times').toBe(1)
    }

    // a folder on the Files page
    await go(page, '/files?path=marketing')
    await expect(page.getByTestId('file-row').first()).toBeVisible()
    await go(page, away)
    from = log.length
    await watchSkeleton(page)
    await go(page, '/files?path=marketing')
    await expect(page.getByTestId('file-row').first()).toBeVisible()
    await page.waitForTimeout(800)
    expect(await skeletons(page), 'folder: no loading placeholder on return').toBe(0)
    expect(n(log, from, /^\/api\/files\/tree\?path=marketing&/)).toBe(1)
    expect(n(log, from, /^\/api\/projects$/), 'the projects list is not read again so soon').toBe(0)

    // a file's preview (the AI's link to it)
    await go(page, `/files/view?path=${encodeURIComponent('marketing/notes.txt')}`)
    await expect(page.getByTestId('file-panel')).toContainText('hello notes')
    await go(page, away)
    await expect(page.getByTestId('file-panel')).toHaveCount(0)
    from = log.length
    await watchSkeleton(page)
    await go(page, `/files/view?path=${encodeURIComponent('marketing/notes.txt')}`)
    await expect(page.getByTestId('file-panel')).toContainText('hello notes')
    await page.waitForTimeout(800)
    expect(await skeletons(page), 'preview: no loading placeholder or spinner on return').toBe(0)
    expect(n(log, from, /^\/api\/files\/download\?path=marketing%2Fnotes\.txt/)).toBe(1)
    // the pencil is decided by the folder as listed: no second question for it
    expect(n(log, from, /^\/api\/files\/content\?path=marketing%2Fnotes\.txt&maxBytes=1$/)).toBe(0)
  })
}
