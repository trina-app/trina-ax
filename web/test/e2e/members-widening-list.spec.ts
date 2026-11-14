// The widening list in a project's Members dialog (docs/DECISIONS.md "People who see a shared chat later: nothing new
// is hidden", QA TC-1404): adding someone who would start seeing answers that used places they can't open shows one
// line under the count with "Show answers"; the list replaces the dialog's body (the picks stay); on a computer an
// answer opens in a new tab at /c/<chat>?answer=<id> (the chat page shows it lit); on a phone it opens on the same
// screen with "‹ Back to sharing", which brings the dialog back on the list with the picks. At 1440 and 390 px wide.
// The mock: POST /__test/widening {items} is the list (and its count in the dry run).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }

/** a team project of mine with Bob in it and one shared chat with an answer: the project page, the chat, the answer */
async function world(page: Page) {
  expect((await page.request.post('/api/admin/users', { headers: H, data: { id: 'sora', username: 'sora', name: '김소라', role: 'member', groupIds: [], temporaryPassword: 'sora-Password-1' } })).ok()).toBeTruthy()
  const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
  expect(r.status()).toBe(201)
  const projectId = ((await r.json()) as { id: string }).id
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: { projectId } })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '예산 요약', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  const answer = ((await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }).items.find((m) => m.role === 'assistant')!
  await page.request.post('/__test/widening', { headers: H, data: { items: [
    { chatId: chat.id, chatTitle: 'Q3 budget questions', messageId: answer.id, at: '2026-11-12T03:00:00.000Z', askedBy: { id: 'bob', name: 'Bob' }, preview: 'The finance draft puts Q3 spend at 41 % over plan', places: [{ name: 'Groups › Finance' }, { hidden: true }], missedBy: ['김소라'] },
  ] } })
  return { projectId, chatId: chat.id, answerId: answer.id }
}
async function openMembersAndAdd(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}?members=1`)
  await page.getByTestId('project-participants-search').fill('김소라')
  await page.getByTestId('participant-add-user-sora').click()
  await expect(page.getByTestId('project-widen-answers')).toBeVisible()
}

test('a computer: the line, the list in place, the answer in a new tab lit; ‹ back to the picks', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const w = await world(page)
  await openMembersAndAdd(page, w.projectId)
  await expect(page.getByTestId('project-widen-answers')).toContainText('김소라')
  await page.getByTestId('project-widen-show').click()
  await expect(page.getByTestId('widening-list')).toBeVisible()
  await expect(page.getByTestId('widening-list-title')).toContainText('김소라')
  const item = page.getByTestId(`widening-item-${w.answerId}`)
  await expect(item).toContainText('Q3 budget questions')
  await expect(item).toContainText('Groups › Finance')
  const link = item.getByTestId('widening-item-open')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('href', `/c/${w.chatId}?answer=${w.answerId}`)
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()])
  await tab.waitForLoadState()
  await expect(tab.locator(`[data-message-id="${w.answerId}"]`)).toBeVisible()
  await expect(tab.locator(`[data-message-id="${w.answerId}"][data-focused]`)).toHaveCount(1)
  await tab.close()
  // the dialog and its picks stay as they were
  await page.getByTestId('widening-list-back').click()
  await expect(page.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'new')
})

test('an answer that is not there any more: the chat at its end with the line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const w = await world(page)
  await page.goto(`/c/${w.chatId}?answer=${uuidv7()}`)
  await expect(page.getByText('그 답은 더 이상 여기 없어요.').or(page.getByText('That answer is no longer here.'))).toBeVisible()
})

test('a phone: the answer on the same screen, ‹ Back to sharing brings the list back with the picks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  const w = await world(page)
  await openMembersAndAdd(page, w.projectId)
  await page.getByTestId('project-widen-show').click()
  await page.getByTestId(`widening-item-${w.answerId}`).getByTestId('widening-item-open').click()
  await expect(page).toHaveURL(new RegExp(`/c/${w.chatId}\\?answer=${w.answerId}`))
  await expect(page.getByTestId('back-to-sharing')).toBeVisible()
  await page.getByTestId('back-to-sharing').click()
  await expect(page.getByTestId('widening-list')).toBeVisible()
  await page.getByTestId('widening-list-back').click()
  await expect(page.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'new')
})
