// A scheduled task's save folder (server/src/chat/schedule-scope.ts; docs/DECISIONS.md "Scheduled tasks: saving and
// sending allowed on the card"): the Scheduled list says where runs save ("저장: shared/주간보고"), the task's page what
// may go there and where it may send, 수정 has the "저장 폴더" field and the places, each removable with ×, and its card
// shows them as they will be. A lapsed folder (its permissions changed) says "저장 폴더를 다시 확인해 주세요" in the list;
// that opens the task with its card for the folder as it is now, and "다시 허용" ends it.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function task(page: Page, data: Record<string, unknown> = {}) {
  expect((await page.request.post('/__test/schedule', { data })).ok()).toBeTruthy()
}
/** a card with three answers (a list): pick one, then 답하기 */
async function answer(ask: Locator, label: string) {
  await ask.getByRole('radio', { name: label, exact: true }).check()
  await ask.getByRole('button', { name: '답하기', exact: true }).click()
}

test('the list line, the task page, and 수정 with the save folder and its places', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page, { title: '주간 보고', saveFolder: 'shared/주간보고', sends: true })
  await signIn(page)
  await page.goto('/scheduled')
  const card = page.getByTestId('schedule-item').filter({ hasText: '주간 보고' })
  await expect(card.getByTestId('schedule-card-save')).toHaveText('저장: shared/주간보고')
  await card.click()
  const view = page.getByTestId('schedule-view')
  await expect(view.getByTestId('schedule-save-folder')).toHaveText('저장: shared/주간보고')
  await expect(view.getByTestId('schedule-save-sources')).toHaveText('넣어도 되는 내용: 내 폴더, #영업팀 대화')
  await expect(view.getByTestId('schedule-sends')).toHaveText("보낼 수 있는 곳: 내 Notion · '일일 메모'")
  await page.getByTestId('schedule-menu').click()
  await page.getByTestId('schedule-edit').click()
  const dialog = page.getByRole('dialog', { name: '예약 작업 수정' })
  await expect(dialog.getByTestId('schedule-edit-save-pick')).toHaveText('shared/주간보고')
  const places = dialog.getByTestId('schedule-edit-save-source')
  await expect(places).toHaveText(['내 폴더', '#영업팀 대화'])
  // × takes a place away; the card shows the rest
  await dialog.getByRole('button', { name: '#영업팀 대화 빼기' }).click()
  await expect(places).toHaveText(['내 폴더'])
  await dialog.getByTestId('schedule-edit-check').click()
  const ask = dialog.getByTestId('schedule-edit-card').getByTestId('ask-card')
  await expect(ask).toContainText('새 파일 저장: shared/주간보고 (지금 30명이 볼 수 있어요). 넣어도 되는 내용: 내 폴더')
  await expect(ask).not.toContainText('#영업팀')
  await expect(ask).toContainText("보낼 수 있는 곳: 내 Notion · '일일 메모'")
  // no new buttons: with sends, the three answers of a card with connections
  await expect(ask.getByRole('radio')).toHaveCount(3)
  for (const name of ['바꾸기(연결 서비스에 보내기 허용)', '바꾸기(연결 서비스에는 보내지 않음)', '바꾸지 않기']) await expect(ask.getByRole('radio', { name, exact: true })).toBeVisible()
  await answer(ask, '바꾸기(연결 서비스에 보내기 허용)')
  await expect(dialog).toHaveCount(0)
  await expect(view.getByTestId('schedule-save-sources')).toHaveText('넣어도 되는 내용: 내 폴더')
  // the save folder taken away: no line, the card says nothing about saving
  await page.getByTestId('schedule-menu').click()
  await page.getByTestId('schedule-edit').click()
  await dialog.getByTestId('schedule-edit-save-remove').click()
  await expect(dialog.getByTestId('schedule-edit-save-folder')).toContainText('없음 (내 폴더에만 저장)')
  await dialog.getByTestId('schedule-edit-check').click()
  await expect(dialog.getByTestId('ask-card')).not.toContainText('새 파일 저장')
  await answer(dialog.getByTestId('ask-card'), '바꾸기(연결 서비스에 보내기 허용)')
  await expect(view.getByTestId('schedule-save-folder')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('a lapsed save folder: the list asks to check it again, the task opens with its card, 다시 허용 ends it', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page, { title: '주간 보고', saveFolder: 'shared/주간보고', lapsed: true })
  await signIn(page)
  await page.goto('/scheduled')
  const card = page.getByTestId('schedule-item').filter({ hasText: '주간 보고' })
  await expect(card.getByTestId('schedule-card-save')).toHaveText('저장 폴더를 다시 확인해 주세요 · 다시 확인')
  await expect(card.getByTestId('schedule-card-save')).toHaveAttribute('data-lapsed', 'yes')
  await card.click()
  const view = page.getByTestId('schedule-view')
  await expect(view.getByTestId('schedule-save-lapsed')).toContainText('그동안 결과는 내 폴더에 저장해요')
  // opened from the list's "다시 확인": the card is there at once, with the folder's count now
  const ask = view.getByTestId('schedule-review-card').getByTestId('ask-card')
  await expect(ask).toContainText('저장 폴더의 권한 설정이 바뀌었어요')
  await expect(ask).toContainText('새 파일 저장: shared/주간보고 (지금 32명이 볼 수 있어요).')
  await ask.getByRole('button', { name: '다시 허용' }).click()
  await expect(page.getByText('저장 폴더를 다시 허용했어요.')).toBeVisible()
  await expect(view.getByTestId('schedule-save-lapsed')).toHaveCount(0)
  await expect(view.getByTestId('schedule-save-folder')).toHaveText('저장: shared/주간보고')
  await page.goto('/scheduled')
  await expect(card.getByTestId('schedule-card-save')).toHaveText('저장: shared/주간보고')
  expect(realErrors(errors)).toEqual([])
})
