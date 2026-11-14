// Settings › Notifications › Phone › "Phone notifications" (components/settings/PhoneGatewayRow.tsx, docs/DECISIONS.md
// "Owners and admins choose where phone notifications go"): owners and admins choose Trina push (default), Off or
// Custom; a custom address that does not answer as a push service is refused with the reason, nothing saved. The
// server's config locks it (the value and where it is set). Members get no row. On a computer a select box, on a phone
// the phone's choice row. SHOTS=<dir> also writes the screenshots of the UI check (1440 and 390, light and dark).
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const DANA = { username: 'dana', password: 'dana password 1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const SHOTS = process.env.SHOTS
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  // the Phone section in sight (the settings dialog scrolls inside itself), then the screen as it is
  await page.getByTestId('notifications-phone').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}
const section = (page: Page) => page.getByTestId('notifications-phone')

for (const size of [{ name: '1440', viewport: { width: 1440, height: 900 } }, { name: '390', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${size.name} ${scheme}`, () => {
      test.use({ viewport: size.viewport, ...('hasTouch' in size ? { hasTouch: true, isMobile: true } : {}), locale: 'en-US', colorScheme: scheme })
      test.beforeEach(async ({ page }) => { await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true }) })
      const phone = size.name === '390'
      const pick = async (page: Page, choice: 'default' | 'off' | 'custom') => {
        if (!phone) return page.getByTestId('phone-gateway-choice').selectOption(choice)
        await page.getByTestId('phone-gateway').click()
        await page.getByTestId(`phone-gateway-option-${choice}`).click()
      }

      test('owner: default, Off at once, Custom refused then saved', async ({ page }) => {
        await signIn(page); await page.goto('/settings/notifications')
        const row = section(page).getByText(t['pushGateway.title'], { exact: true })
        await expect(row).toBeVisible()
        await expect(section(page)).toContainText(t['pushGateway.desc.default'].replace('{product}', 'Trina AX'))
        await shot(page, `owner-${size.name}-${scheme}-default`)
        await pick(page, 'off')
        await expect(section(page)).toContainText(t['pushGateway.desc.off'])
        await expect.poll(async () => (await (await page.request.get('/api/admin/push-gateway')).json()).choice).toBe('off')
        // Off's "saved" toast is put away, so the refusal below is seen alone (a refusal toasts nothing)
        await expect(page.getByTestId('toast')).toContainText(t['pushGateway.saved'])
        await page.getByTestId('toast').getByRole('button', { name: t['common.close'] }).click()
        await expect(page.getByTestId('toast')).toHaveCount(0)
        await pick(page, 'custom')
        await expect(page.getByTestId('phone-gateway-custom')).toContainText(t['pushGateway.customNote'])
        await page.getByTestId('phone-gateway-address').fill('https://not-a-gateway.example.com')
        await page.getByTestId('phone-gateway-save').click()
        await expect(page.getByTestId('phone-gateway-error')).toContainText(t['pushGateway.problem.not_gateway'])
        await expect(page.getByTestId('toast')).toHaveCount(0)
        await shot(page, `owner-${size.name}-${scheme}-custom-refused`)
        expect((await (await page.request.get('/api/admin/push-gateway')).json()).choice).toBe('off')
        await page.getByTestId('phone-gateway-address').fill('https://push.example.com')
        await page.getByTestId('phone-gateway-save').click()
        await expect(page.getByTestId('phone-gateway-error')).toHaveCount(0)
        await expect.poll(async () => (await (await page.request.get('/api/admin/push-gateway')).json())).toMatchObject({ choice: 'custom', url: 'https://push.example.com' })
        await expect(section(page)).toContainText(t['pushGateway.desc.custom'])
        await shot(page, `owner-${size.name}-${scheme}-custom-saved`)
      })

      test('admin: the same row; set in the server\'s config it is locked with where', async ({ page }) => {
        await page.request.post('/__test/push-gateway', { data: { choice: 'custom', url: 'https://push.acme.example', lockedBy: 'MYCEL_PUSH_GATEWAY' } })
        await signIn(page, DANA); await page.goto('/settings/notifications')
        await expect(page.getByTestId('phone-gateway-locked')).toHaveText(t['pushGateway.locked'].replace('{where}', 'MYCEL_PUSH_GATEWAY'))
        await expect(page.getByTestId('phone-gateway-value')).toHaveText(t['pushGateway.choice.custom'])
        await expect(page.getByTestId('phone-gateway-url')).toHaveText('https://push.acme.example')
        await expect(page.getByTestId('phone-gateway-choice')).toHaveCount(0)
        await shot(page, `admin-${size.name}-${scheme}-locked`)
      })

      test('member: no row, never asked', async ({ page }) => {
        const asked: string[] = []
        page.on('request', (r) => { if (r.url().includes('/api/admin/push-gateway')) asked.push(r.url()) })
        await signIn(page, BOB); await page.goto('/settings/notifications')
        await expect(page.getByTestId('notification-sound')).toBeAttached()
        await expect(section(page)).toBeVisible()
        await expect(page.getByTestId('phone-gateway')).toHaveCount(0)
        await expect(page.getByTestId('phone-gateway-row')).toHaveCount(0)
        await shot(page, `member-${size.name}-${scheme}`)
        expect(asked).toEqual([])
      })
    })
  }
}
