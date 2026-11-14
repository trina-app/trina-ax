// A project with a guest, on its page (guest UX audit). "Includes 1 guest" and the Guest tag for every viewer (QA S8;
// #848 for members):
// an owner or admin outside a guest's one place has no guest in their people list (the server's sharesPlace), so the
// project's own people list says who is a guest (ProjectPerson.guest; components/GuestTag.tsx, store/people.ts
// guestIds). Here the owner's people list is answered without the guest, as the server does for someone outside.
// The guest's own page of a project with no files: "No files yet" on a computer as on a phone, never "0 items" (QA N4).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

async function projectWithGuest(page: Page, as: 'owner' | 'guest' = 'owner') {
  await reset(page)
  const r = await page.request.post('/__test/project', { data: { name: '견적 준비', by: 'bob', participants: [{ subjectType: 'user', subjectId: 'olga' }] } })
  expect(r.ok()).toBeTruthy()
  const { id } = (await r.json()) as { id: string }
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina Park', place: { kind: 'project', id }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  if (as === 'guest') {
    await page.goto('/login')
    await page.getByTestId('login-username').fill('gina')
    await page.getByTestId('login-password').fill('gina password 1')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-submit')).toHaveCount(0)
    return id
  }
  // the owner is outside the guest's place: their people list has no guest
  await page.route(/\/api\/people(\?|$)/, async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { people: { id: string }[] }
    await route.fulfill({ response: res, json: { ...body, people: body.people.filter((p) => p.id !== 'gina') } })
  })
  await signIn(page)
  return id
}

test('a guest who joins while the project is open: its people and "Includes 1 guest" follow at once (no reload)', async ({ page }) => {
  await reset(page)
  const r = await page.request.post('/__test/project', { data: { name: '견적 준비', by: 'bob', participants: [{ subjectType: 'user', subjectId: 'olga' }] } })
  const { id } = (await r.json()) as { id: string }
  await signIn(page)
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-people-header')).toBeVisible()
  await expect(page.getByTestId('includes-guests')).toHaveCount(0)
  // the guest accepts their invite (the server tells the project's people: chat/project-joins.ts)
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina Park', place: { kind: 'project', id }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/publish', { data: { event: { type: 'notice', data: { level: 'info', code: 'project_people_changed', message: id } } } })).ok()).toBeTruthy()
  await expect(page.getByTestId('includes-guests')).toHaveText('게스트 1명 포함')
  // another project's notice changes nothing here (one read per notice of this project only)
  let reads = 0
  page.on('request', (q) => { if (new RegExp(`/api/projects/${id}/people`).test(q.url())) reads++ })
  await page.request.post('/__test/publish', { data: { event: { type: 'notice', data: { level: 'info', code: 'project_people_changed', message: 'another' } } } })
  await page.waitForTimeout(500)
  expect(reads).toBe(0)
})

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test.describe(`${w}`, () => {
    test.use({ viewport: { width: w, height: h } })

    test('the owner outside the guest\'s place: "Includes 1 guest" under the faces and the Guest tag in the members dialog', async ({ page }) => {
      const id = await projectWithGuest(page)
      await page.goto(`/projects/${id}`)
      await expect(page.getByTestId('project-people-header')).toBeVisible()
      await expect(page.getByTestId('includes-guests')).toHaveText('게스트 1명 포함')
      // the directory really had no guest: what said so is the project's own list
      expect(await page.evaluate(async () => ((await (await fetch('/api/people')).json()) as { people: { id: string }[] }).people.some((p) => p.id === 'gina'))).toBe(false)
      await page.getByTestId('project-header-open').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Gina Park')).toBeVisible()
      await expect(dialog.getByTestId('guest-tag')).toHaveCount(1)
    })

    test('the guest on their project with no files: "No files yet", as on a phone, never "0 items"', async ({ page }) => {
      const id = await projectWithGuest(page, 'guest')
      await page.goto(`/projects/${id}`)
      const files = page.getByTestId('project-files')
      await expect(files.getByTestId('project-files-empty')).toHaveText('아직 파일이 없어요')
      await expect(files).not.toContainText('0개')
      // nothing to open on a computer (a phone's row goes to the files screen)
      await expect(page.getByTestId('project-files-toggle')).toHaveCount(0)
    })
  })
}
