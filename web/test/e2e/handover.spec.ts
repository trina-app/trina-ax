// 팀장 넘기기 (docs/DECISIONS.md "W6"; web/src/components/handover/): the owner flags an invite "이 사람이 팀장이에요" (Admin
// › Members, the welcome steps' invite step) and gets the one-person message; the flagged person joins; Home's card names
// the owner's words beside the account's name, username and time; ✕ hides it while the Inbox notice stays; [넘기기] from
// the Inbox opens the confirm with 받는 사람 and my connections ticked; a wrong password says so; the right one hands the
// role over (the old owner is an admin at once); the new owner's Inbox says so with [내보내기]. The "…" menu offers it
// only for someone who signed in and changed their temporary password; a race says the owner changed already.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** a row's "…" menu on Admin › Members (the wide table) */
const menuOf = async (page: Page, name: string) => {
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: name }).getByTestId('member-more').click()
}

test('flag an invite, the lead joins, the card, ✕ keeps the Inbox notice, hand over from the Inbox, the new owner is told', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/members')

  // the invite form: the flag, then for whom; the role, groups and days wait while it is ticked
  await page.getByTestId('invite-new').click()
  const form = page.getByRole('dialog')
  await expect(form.getByTestId('lead-flag')).toContainText('이 사람이 팀장이에요 · 들어오면 팀장을 넘길지 물어볼게요')
  await form.getByTestId('lead-flag-check').check()
  await expect(form.getByTestId('lead-note')).toHaveText(ko('handover.leadNote', { days: 3 }))
  await expect(form.getByTestId('invite-settings').getByRole('combobox').first()).toBeDisabled()
  await expect(form.getByTestId('invite-create')).toBeDisabled()
  await expect(form.getByTestId('invite-create')).toHaveText(ko('handover.makeLink'))
  await form.getByTestId('lead-for').fill('김팀장 대표님')
  await form.getByTestId('invite-create').click()
  const made = page.getByRole('dialog', { name: ko('handover.linkTitle') })
  const message = await made.getByTestId('lead-message').innerText()
  expect(message).toMatch(/^Olga님이 Trina AX에 팀을 만들어 두었어요\. 들어오면 Olga님이 팀장을 넘겨 드려요: http:\/\/127\.0\.0\.1:\d+\/invite\/inv[0-9a-f]+ · 한 사람만 쓸 수 있는 링크예요$/)
  await expect(made.getByTestId('lead-facts')).toContainText('받는 사람: 김팀장 대표님 · ')
  await expect(made.getByTestId('lead-replaced')).toHaveCount(0)
  await made.getByTestId('lead-copy-message').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message)
  await made.getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('invite-lead')).toContainText('팀장 링크 · 받는 사람: 김팀장 대표님')
  const url = /(http\S+\/invite\/\S+)/.exec(message)![1]!

  // the flagged person joins with it (a member, in another browser)
  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('박민준')
  await p2.getByTestId('invite-username').fill('minjun')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  await expect(p2.getByTestId('composer-input').or(p2.getByTestId('rooms-page'))).toBeVisible()

  // the owner's Home: the card is the one thing at the top, with the owner's words and the account's facts
  await page.goto('/')
  const card = page.getByTestId('handover-card')
  await expect(card).toContainText("김팀장 대표님에게 보낸 팀장 링크로 '박민준'(아이디 minjun)님이 ")
  await expect(card).toContainText(/\d{1,2}:\d{2}에 들어왔어요/)
  await expect(card).toContainText('팀장을 넘길까요?')
  await expect(card.getByRole('button')).toHaveCount(2)
  await audit(page, 'Home with the handover card')
  // ✕: gone, also after a reload; the Inbox notice stays
  await card.getByRole('button', { name: '닫기' }).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('handover-card')).toHaveCount(0)

  await page.goto('/activity')
  const row = page.getByTestId('notification-item').filter({ hasText: '김팀장 대표님에게 보낸 팀장 링크로' })
  await expect(row).toContainText("'박민준'(아이디 minjun)님이 ")
  await expect(row).toContainText('팀장을 넘길까요?')
  await row.getByTestId('handover-notice-open').click()
  const confirm = page.getByRole('dialog', { name: '박민준님을 팀장으로 정할까요?' })
  await expect(confirm).toContainText('받는 사람: 김팀장 대표님 · 이 사람이 맞는지 직접 확인했나요? 팀장이 되면 나를 내보낼 수도 있어요.')
  await expect(confirm).toContainText('넘기면 팀 이름·관리자 지정·업데이트와 백업은 박민준님이 맡고, 나는 관리자가 돼요.')
  const ai = confirm.getByTestId('handover-conn-team_ai-cred-claude')
  const drive = confirm.getByTestId('handover-conn-drive_share-share-acme')
  await expect(ai).toBeChecked()
  await expect(drive).toBeChecked()
  await expect(confirm).toContainText("팀 AI '회사 Claude' (내 Claude 계정) · 넘기면 끊어요")
  await expect(confirm.getByTestId('handover-recovery')).toHaveText(ko('handover.recovery.server'))
  // the drive is the company's own: kept
  await drive.uncheck()
  await expect(confirm).toContainText("드라이브 공유 'Acme 드라이브' (내 구글 계정) · 남겨요")
  await audit(page, 'the handover confirm')
  // a wrong password says so under the field, and nothing changes
  await confirm.getByTestId('handover-password').fill('wrong password')
  await confirm.getByTestId('handover-submit').click()
  await expect(confirm.getByRole('alert')).toHaveText('비밀번호가 맞지 않아요. 다시 입력해 주세요.')
  await confirm.getByTestId('handover-password').fill(OWNER.password)
  await confirm.getByTestId('handover-submit').click()
  await expect(page.getByTestId('toast').filter({ hasText: '박민준님이 팀장이 되었어요 · 나는 관리자예요' })).toHaveCount(1)
  await expect(confirm).toBeHidden()
  // the window that pressed it says it once (the realtime notice that follows is not toasted again)
  await expect(page.getByTestId('toast').filter({ hasText: '팀장이 박민준님으로 바뀌었어요' })).toHaveCount(0)
  // my own Inbox: the notice it went to; no [넘기기] any more
  await expect(page.getByTestId('notification-item').filter({ hasText: '박민준님이 팀장이 되었어요 · 나는 관리자예요' })).toHaveCount(1)
  await expect(row).toContainText('지금은 넘길 수 없어요')
  await expect(row.getByTestId('handover-notice-open')).toHaveCount(0)
  // an admin now: the owner-only settings are read-only
  await page.goto('/admin/settings')
  await expect(page.getByLabel('팀 이름')).toBeDisabled()

  // the new owner: told in the Inbox, with what was ended, [내보내기] and the setup to go on with
  await p2.goto('/activity')
  const told = p2.getByTestId('notification-item').filter({ hasText: 'Olga님이 팀장을 넘겼어요 · Olga님은 관리자로 남아 있어요' })
  await expect(told).toContainText('끊은 연결: 팀 AI 1개')
  await expect(told.getByTestId('handover-notice-setup')).toHaveAttribute('href', '/welcome')
  await told.getByTestId('handover-notice-remove').click()
  await p2.getByRole('dialog', { name: 'Olga님을 내보낼까요?' }).getByRole('button', { name: '내보내기' }).click()
  await expect(p2.getByTestId('toast').filter({ hasText: 'Olga님을 내보냈어요' })).toHaveCount(1)
  await expect(told.getByTestId('handover-notice-remove')).toHaveCount(0)
  await other.close()
  // Olga was signed out by being disabled: the 401s that follow are expected
  expect(realErrors(errors).filter((e) => !/status of 40[13]/.test(e))).toEqual([])
})

test('"…" › 팀장 넘기기: only for someone who signed in and changed their password; a race says the owner changed; then a real one', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  // Bob signs in once (the menu needs someone who did)
  const bobCtx = await browser.newContext({ locale: 'ko-KR' })
  await signIn(await bobCtx.newPage(), { username: 'bob', password: 'bob password 1' })
  await bobCtx.close()
  await signIn(page)
  // Team settings no longer has a transfer card
  await page.goto('/admin/settings')
  await expect(page.getByLabel('팀 이름')).toBeEnabled()
  await expect(page.getByRole('heading', { name: '팀장 넘김' })).toHaveCount(0)
  await page.goto('/admin/members')
  // Carol: added with a temporary password, never signed in
  await page.getByRole('button', { name: '직접 추가' }).click()
  await page.getByRole('dialog').getByLabel('이름', { exact: true }).fill('Carol')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  await page.getByTestId('add-member-submit').click()
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await menuOf(page, 'Carol')
  await expect(page.getByTestId('reset-password-carol')).toBeVisible()
  await expect(page.getByTestId('handover-member-carol')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // a race: the next transfer answers 409 owner_changed, as when the role moved in another tab meanwhile
  expect((await page.request.post('/__test/handover', { data: { race: true } })).ok()).toBe(true)
  await menuOf(page, 'Bob')
  await page.getByTestId('handover-member-bob').click()
  const confirm = page.getByRole('dialog', { name: 'Bob님을 팀장으로 정할까요?' })
  await expect(confirm.getByTestId('handover-check')).toHaveText('Bob(아이디 bob) · 팀장이 되면 나를 내보낼 수도 있어요.')
  // my connections are listed here as on the card's path
  await expect(confirm.getByTestId('handover-conn-team_ai-cred-claude')).toBeChecked()
  await confirm.getByTestId('handover-password').fill(OWNER.password)
  await confirm.getByTestId('handover-submit').click()
  await expect(page.getByTestId('toast').filter({ hasText: '이미 팀장이 바뀌었어요' })).toHaveCount(1)
  await expect(confirm).toBeHidden()

  // the real one, by Enter in the password field: once the dialog has listed my connections (what is ended comes from
  // that list, so until then [넘기기] is disabled and Enter does nothing)
  await menuOf(page, 'Bob')
  await page.getByTestId('handover-member-bob').click()
  await expect(confirm.getByTestId('handover-conn-team_ai-cred-claude')).toBeChecked()
  await confirm.getByTestId('handover-password').fill(OWNER.password)
  await confirm.getByTestId('handover-password').press('Enter')
  await expect(page.getByTestId('toast').filter({ hasText: 'Bob님이 팀장이 되었어요 · 나는 관리자예요' })).toHaveCount(1)
  // an admin now: roles are read-only, and nobody's "…" offers the handover
  await expect(page.getByTestId('member-role-bob')).toHaveText('팀장')
  await menuOf(page, 'Carol')
  await expect(page.getByTestId('handover-member-carol')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto('/admin/settings')
  await expect(page.getByLabel('팀 이름')).toBeDisabled()
  // the race's 409 is the answer the test asked for
  expect(realErrors(errors).filter((e) => !/status of 40[39]/.test(e))).toEqual([])
})

test("the welcome steps' invite step: tick, say for whom, make the owner link; an unsent one is revoked on untick, a copied one stays; a second flag replaces it", async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  // 팀 파일, then 도구 연결, put off
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  // unticked: the team link's message as before
  await expect(page.getByTestId('team-link-message')).toBeVisible()
  const flag = page.getByTestId('lead-flag-check')
  await flag.check()
  await expect(page.getByTestId('team-link-message')).toHaveCount(0)
  await expect(page.getByTestId('lead-create')).toBeDisabled()
  await page.getByTestId('lead-for').fill('김팀장 대표님')
  await page.getByTestId('lead-create').click()
  await expect(page.getByTestId('lead-message')).toContainText('Olga님이 Trina AX에 팀을 만들어 두었어요. 들어오면 Olga님이 팀장을 넘겨 드려요: ')
  await expect(page.getByTestId('lead-facts')).toContainText('받는 사람: 김팀장 대표님 · ')
  const leads = async () => ((await (await page.request.get('/api/admin/invites')).json()).items as { leadFor?: string | null }[]).filter((i) => i.leadFor).length
  expect(await leads()).toBe(1)
  // never sent: unticking revokes it, and the team link's message is back
  await flag.uncheck()
  await expect(page.getByTestId('team-link-message')).toBeVisible()
  await expect.poll(leads).toBe(0)
  // ticking again keeps the words; this one is copied, so it stays after unticking (Admin › Members lists it)
  await flag.check()
  await expect(page.getByTestId('lead-for')).toHaveValue('김팀장 대표님')
  await page.getByTestId('lead-create').click()
  await page.getByTestId('lead-copy-link').click()
  await flag.uncheck()
  await expect(page.getByTestId('lead-open')).toContainText('김팀장 대표님에게 보낸 팀장 링크가 ')
  expect(await leads()).toBe(1)
  await flag.check()
  await expect(page.getByTestId('lead-message')).toBeVisible()

  // a second flag elsewhere replaces it: the form says the one sent before stopped working
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  await page.getByRole('dialog').getByTestId('lead-flag-check').check()
  await page.getByRole('dialog').getByTestId('lead-for').fill('Acme')
  await page.getByRole('dialog').getByTestId('invite-create').click()
  const made = page.getByRole('dialog', { name: ko('handover.linkTitle') })
  await expect(made.getByTestId('lead-replaced')).toHaveText(ko('handover.replaced'))
  await expect(made.getByTestId('lead-facts')).toContainText('받는 사람: Acme · ')
  expect(await leads()).toBe(1)
  expect(realErrors(errors)).toEqual([])
})

test('a hosted team without its safety switch: no flag anywhere, the "…" menu still hands over', async ({ page, browser }) => {
  await reset(page)
  expect((await page.request.post('/__test/handover', { data: { flag: false, recovery: 'hosted' } })).ok()).toBe(true)
  const bobCtx = await browser.newContext({ locale: 'ko-KR' })
  await signIn(await bobCtx.newPage(), { username: 'bob', password: 'bob password 1' })
  await bobCtx.close()
  await signIn(page)
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  await expect(page.getByRole('dialog').getByTestId('invite-create')).toBeVisible()
  await expect(page.getByTestId('lead-flag')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await menuOf(page, 'Bob')
  await page.getByTestId('handover-member-bob').click()
  const confirm = page.getByRole('dialog', { name: 'Bob님을 팀장으로 정할까요?' })
  await expect(confirm.getByTestId('handover-recovery')).toHaveText(ko('handover.recovery.hosted'))
})

test('a lead link is the owner\'s to revoke: an admin sees it listed without the button', async ({ page, browser }) => {
  await reset(page, { withAdmin: true })
  await signIn(page)
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  await page.getByRole('dialog').getByTestId('lead-flag-check').check()
  await page.getByRole('dialog').getByTestId('lead-for').fill('김팀장 대표님')
  await page.getByRole('dialog').getByTestId('invite-create').click()
  await page.getByRole('dialog', { name: ko('handover.linkTitle') }).getByRole('button', { name: '완료' }).click()
  const mine = page.getByTestId('invite-list').getByRole('listitem').filter({ has: page.getByTestId('invite-lead') })
  await expect(mine.getByRole('button', { name: ko('members.revoke') })).toBeVisible()
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  const admin = await ctx.newPage()
  await signIn(admin, { username: 'dana', password: 'dana password 1' })
  await admin.goto('/admin/members')
  const row = admin.getByTestId('invite-list').getByRole('listitem').filter({ has: admin.getByTestId('invite-lead') })
  await expect(row).toContainText('팀장 링크 · 받는 사람: 김팀장 대표님')
  await expect(row.getByRole('button')).toHaveCount(0)
  // an admin gets no flag on the invite form either
  await admin.getByTestId('invite-new').click()
  await expect(admin.getByRole('dialog').getByTestId('invite-create')).toBeVisible()
  await expect(admin.getByTestId('lead-flag')).toHaveCount(0)
  await ctx.close()
})
