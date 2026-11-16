// Screenshots of Find work files' share step (docs/decisions/20261116-find-files-share-step.md), for
// reviewing it by eye: the step as it opens (nothing ticked, the hint), with files ticked and a person added, and the
// result; for a member, an admin and the team owner; at 1440 and 390, light and dark; English, and Korean for the
// member. Only when FIND_SHARE_SHOTS names a folder to write them to.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { answer, fakeApp, look, type Meta } from './fake-work-files'

const dir = process.env.FIND_SHARE_SHOTS
test.skip(!dir, 'FIND_SHARE_SHOTS is not set')

const EVERYONE = '01900000-0000-7000-8000-0000000000a1'
const WHO = {
  member: { username: 'bob', password: 'bob password 1', id: 'bob', other: 'olga' },
  admin: { username: 'dana', password: 'dana password 1', id: 'dana', other: 'bob' },
  owner: { username: 'olga', password: 'correct horse battery', id: 'olga', other: 'bob' },
}
const FOUND: Meta[] = [
  { name: 'Acme quote template 2026.xlsx', folder: 'Sales' }, { name: 'Brand guide v3.pdf', folder: 'Acme/Brand' }, { name: 'Weekly report - Nov 10.docx', root: 'downloads' },
  { name: 'Northwind proposal.pptx', folder: 'Clients/Northwind' }, { name: 'Onboarding policy.pdf', folder: 'Team' }, { name: 'Meeting minutes 11-04.docx', root: 'desktop' },
]

const cases = [
  ...(['member', 'admin', 'owner'] as const).map((role) => ({ role, locale: 'en' as const })),
  { role: 'member' as const, locale: 'ko' as const },
]
for (const { role, locale } of cases) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390] as const) {
      test(`share step · ${role} · ${locale} · ${width} · ${scheme}`, async ({ page }) => {
        const who = WHO[role]
        const shot = async (name: string) => page.screenshot({ path: `${dir}/${role}-${locale}-${width}-${scheme}-${name}.png` })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await fakeApp(page)
        await reset(page, { teamLocale: locale, usersFollowTeam: true, withAdmin: true })
        // opened from the Home welcome card (a dialog opened on a wide window stays when it is made narrow; My files'
        // toolbar button is for computers only, and the phone's Files page has no dialog of its own)
        await page.request.post('/__test/member-welcome', { data: { welcome: {
          team: 'Acme', inviter: { id: 'olga', name: 'Olga' }, people: 3, rooms: [{ id: EVERYONE, kind: 'all', name: null }],
          owner: { id: 'olga', name: 'Olga' }, steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false,
        } } })
        await page.request.post('/__test/file', { data: { path: `users/${who.id}/memo.md`, text: 'memo' } })
        await signIn(page, who)
        await page.goto('/')
        await look(page, FOUND)
        await page.getByTestId('member-welcome-files-button').click()
        await answer(page, 'look')
        await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
        await expect(page.getByTestId('find-work-ai')).toBeVisible()
        for (const c of (await page.getByTestId('find-work-check').all()).slice(0, 5)) await c.check()
        await page.getByTestId('find-work-add').click()
        await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share', { timeout: 15_000 })
        if (width === 390) await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.getByTestId('find-work-share')).toBeVisible()
        await shot('1-share')
        const rows = page.getByTestId('find-work-share-row')
        await rows.nth(0).getByTestId('find-work-share-check').check()
        await rows.nth(1).getByTestId('find-work-share-check').check()
        await shot('2-ticked')
        await page.getByTestId('find-work-share-picker-search').fill(who.other)
        await page.getByTestId(`participant-add-user-${who.other}`).click()
        await expect(page.getByTestId('find-work-share-go')).toBeEnabled()
        await page.waitForTimeout(300)
        await shot('3-picked')
        await page.getByTestId('find-work-share-go').click()
        await expect(page.getByTestId('find-work-shared')).toBeVisible()
        await shot('4-shared')
      })
    }
  }
}
