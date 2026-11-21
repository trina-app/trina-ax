// A room's event lines that name a project, as the server reads the project for me now (plan
// docs/AGENTS/plan/20261121-1009-event-project-link.md; server/src/rooms/project-link.ts eventProjectsFor): a project I
// can open (renamed since: its name now) is a link to it; one in the trash is its name "(in the trash)" as plain text;
// one I cannot open is "a project" (never its name); one deleted for good is "a deleted project". At 1440 and 390.
// With SHOTS=1 it also saves the timeline into $SHOTS_DIR (default test-results/event-project-link).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MINJUN = { id: 'minjun', name: '민준' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const PROJECT = id(900)
const fill = (s: string, p: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? `{${k}}`)

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await reset(page)
  await signIn(page)
  await routeRoom(page, {
    members: [MINJUN],
    messages: [
      { id: id(1), author: MINJUN, body: '', extra: { event: { type: 'project_linked', project: { id: PROJECT, name: '런칭 v2' } } } },
      { id: id(2), author: MINJUN, body: '', extra: { event: { type: 'project_unlinked', project: null, projectGone: { state: 'trash', name: '봄 캠페인' } } } },
      { id: id(3), author: MINJUN, body: '', extra: { event: { type: 'project_linked', project: null } } },
      { id: id(4), author: MINJUN, body: '', extra: { event: { type: 'project_linked', project: null, projectGone: { state: 'deleted' } } } },
      { id: id(5), author: MINJUN, body: '다음 주 일정 공유드려요' },
    ],
  })
  await page.goto(`/rooms/019a5f00-0000-7000-8000-00000000a001`)
  await expect(page.getByTestId('room-event')).toHaveCount(4)
}

for (const width of [1440, 390] as const)
  test(`${width} px: an event line links only a project I can open now; trash, no access and deleted are plain text`, async ({ page }) => {
    await open(page, width)
    const lines = page.getByTestId('room-event')
    const actor = '민준'
    // renamed: the name now, a link to the project
    await expect(lines.nth(0)).toHaveAttribute('data-project', 'open')
    await expect(lines.nth(0)).toHaveText(fill(t['rooms.event.projectLinkedNamed'], { actor, name: '런칭 v2' }))
    await expect(lines.nth(0).getByTestId('room-event-project')).toHaveAttribute('href', `/projects/${PROJECT}`)
    // in the trash: its name "(in the trash)", no link
    await expect(lines.nth(1)).toHaveAttribute('data-project', 'trash')
    await expect(lines.nth(1)).toHaveText(fill(t['rooms.event.projectUnlinkedTrash'], { actor, name: '봄 캠페인' }))
    // no access: "a project"
    await expect(lines.nth(2)).toHaveAttribute('data-project', 'hidden')
    await expect(lines.nth(2)).toHaveText(fill(t['rooms.event.projectLinked'], { actor }))
    // deleted for good
    await expect(lines.nth(3)).toHaveAttribute('data-project', 'deleted')
    await expect(lines.nth(3)).toHaveText(fill(t['rooms.event.projectLinkedDeleted'], { actor }))
    // one link in all, and nothing runs out of the screen
    await expect(page.getByTestId('room-event-project')).toHaveCount(1)
    for (let i = 0; i < 4; i++) for (const a of await lines.nth(i).locator('a').all()) expect(await a.getAttribute('href')).toBe(`/projects/${PROJECT}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // the link opens the project
    await lines.nth(0).getByTestId('room-event-project').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}`))
  })

test('screenshots (SHOTS=1)', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'only with SHOTS=1')
  const dir = process.env.SHOTS_DIR ?? 'test-results/event-project-link'
  for (const width of [1440, 390] as const) {
    await open(page, width)
    await page.screenshot({ path: `${dir}/event-lines-${width}.png` })
  }
})
