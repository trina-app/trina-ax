// The team invite link (onboarding stream E): an admin makes it on Admin › Members, copies the link and the
// ready-made message; someone opens it in another browser, the token leaves the address bar, they join with name,
// username and password (no second password field), and land on the form of the skill the link names. A revoked link
// says to ask for a new one.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('make the team link, copy the message, join with it, land on the skill; a revoked link asks for a new one', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  expect((await page.request.post('/__test/skills', { data: { files: [{ path: 'skills/광고-문구.md', name: '광고 문구', description: '광고 문구 세 줄' }] } })).ok()).toBe(true)
  await signIn(page)
  await page.goto('/admin/members')
  const card = page.getByTestId('team-link-form')
  await expect(card).toBeVisible()
  await page.getByTestId('team-link-skill').selectOption('skills/광고-문구.md')
  await page.getByTestId('team-link-create').click()
  const url = (await page.getByTestId('team-link-url').innerText()).trim()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join#t=tl[0-9a-f]+$/)
  await expect(page.getByTestId('team-link-uses')).toHaveText('0/20명')
  await audit(page, 'members, the open team link')
  await page.getByRole('button', { name: '메시지 복사' }).click()
  const message = await page.evaluate(() => navigator.clipboard.readText())
  expect(message).toContain('함께 일하자고 초대했어요.')
  expect(message).toContain("'광고 문구' 스킬을 같이 써 보자고 해요.")
  expect(message.endsWith(url)).toBe(true)

  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const requests: string[] = []
  p2.on('request', (r) => requests.push(r.url()))
  await p2.goto(url)
  await expect(p2.getByRole('heading', { name: /팀에 참여하기/ })).toBeVisible()
  // the token is out of the address bar, and no request carried it in its address
  await expect(p2).toHaveURL(/\/join$/)
  const token = url.split('#t=')[1]!
  await expect(p2.getByTestId('invite-password2')).toHaveCount(0)
  await audit(p2, 'the join page')
  await p2.getByTestId('invite-name').fill('New Person')
  await p2.getByTestId('invite-username').fill('newbie')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-password-show').click()
  await expect(p2.getByTestId('invite-password')).toHaveAttribute('type', 'text')
  await p2.getByTestId('invite-submit').click()
  await expect(p2).toHaveURL(/\/skills\?run=/)
  expect(new URL(p2.url()).searchParams.get('run')).toBe('skills/광고-문구.md')
  // the Skills page opens that skill's form (onboarding C), ready to run
  await expect(p2.getByTestId('skill-form')).toBeVisible()
  await expect(p2.getByTestId('skill-form')).toHaveAttribute('data-path', 'skills/광고-문구.md')
  await expect(p2.getByTestId('skill-form-run')).toBeEnabled()
  expect(requests.filter((r) => r.includes(token))).toEqual([])
  await other.close()

  // the admin sees the use; turning the link off makes it say so
  await page.reload()
  await expect(page.getByTestId('team-link-uses')).toHaveText('1/20명')
  await page.getByTestId('team-link-revoke').click()
  await page.getByRole('dialog').getByRole('button', { name: '링크 끄기' }).click()
  await expect(page.getByTestId('team-link-form')).toBeVisible()
  const late = await browser.newContext({ locale: 'ko-KR' })
  const p3 = await late.newPage()
  await p3.goto(url)
  await expect(p3.getByTestId('join-problem')).toHaveText('더 이상 쓰지 않는 초대 링크예요. 링크를 보낸 분께 새 링크를 부탁해 주세요.')
  await expect(p3.getByTestId('invite-submit')).toHaveCount(0)
  await late.close()
  expect(realErrors(errors)).toEqual([])
})
