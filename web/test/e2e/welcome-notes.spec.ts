// The meeting-notes start in a real browser against the mock (docs/DECISIONS.md "M — One meeting note, everyone's own
// tasks"): the owner drops two meeting notes on the welcome steps' first result; they go into the team's own folder and
// "/meeting-tasks …" runs on them in a new chat; under the answer the invite bar offers the link, which carries the
// files; someone joins with it and lands on Home with one line, the box filled with their own question and the files
// attached, and who sees the chat; sending it opens their own chat, and Home is the usual Home again.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const note = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

test('meeting notes in, tasks out; the invite carries the files; a member lands on their own question', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-pack-line')).toHaveText('팀 스킬을 넣어 둘게요 · 마케팅팀이에요')
  // the profile put off: the team's start goes in, then the first result asks for files
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByRole('heading', { name: '최근 회의록이나 업무 파일을 놓아 주세요' })).toBeVisible()
  await expect(page.getByTestId('welcome-files-who')).toHaveText('여기 올린 파일은 Acme만 봐요 · 채팅은 각자만 봐요')
  await page.getByTestId('welcome-files-input').setInputFiles([
    note('11월 1주 회의.md', '# 11월 1주 주간 회의\n- 민지: 랜딩 시안 금요일까지\n- 지훈: 광고 집행 보고\n'),
    note('11월 2주 회의.md', '# 11월 2주 주간 회의\n- 김 대리: 견적서 정리\n'),
  ])
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  const question = page.getByTestId('user-message').first()
  await expect(question).toContainText('/meeting-tasks 이 회의록으로 이번 주 할 일, 사람별로 정리해 줘')
  await expect(question).toContainText('11월 1주 회의.md')
  await expect(question).toContainText('11월 2주 회의.md')
  // the files are in the team's meeting notes folder
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/회의록')}`)
  expect((await listed.json()).entries.map((e: { name: string }) => e.name).sort()).toEqual(['11월 1주 회의.md', '11월 2주 회의.md'])

  // under the answer: one bar, one button
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('팀원도 이 회의록에서 각자 할 일을 바로 받아요')
  await page.getByTestId('welcome-invite-open').click()
  await page.getByTestId('team-link-create').click()
  await expect(page.getByTestId('team-link-message')).toContainText('이번 주 팀 회의록 올려 뒀어요. 링크 열면 내 할 일이 바로 나와요.')
  const url = (await page.getByTestId('team-link-message').innerText()).trim().split('\n').at(-1)!
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)

  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const errors2 = watchConsole(p2)
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('민지')
  await p2.getByTestId('invite-username').fill('minji')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  // Home, not a form: one line, the box filled in with the files attached, who sees the chat
  await expect(p2.getByTestId('starter-line')).toHaveText('Olga님이 이번 주 팀 회의록 2개를 올려 뒀어요')
  await expect(p2.getByTestId('composer-input')).toHaveValue('/meeting-tasks 내 할 일 정리해 줘')
  await expect(p2.getByTestId('composer').getByTestId('attachment-chip')).toHaveCount(2)
  await expect(p2.getByTestId('starter-private')).toHaveText('이 채팅은 민지님만 봐요. Olga님도 못 봐요.')
  await expect(p2.getByTestId('first-time-folders')).toHaveCount(0)
  await p2.getByTestId('send').click()
  await expect(p2).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(p2.getByTestId('user-message').first()).toContainText('/meeting-tasks 내 할 일 정리해 줘')
  await expect(p2.getByTestId('user-message').first()).toContainText('11월 1주 회의.md')
  await expect(p2.getByTestId('user-message').first()).toContainText('11월 2주 회의.md')
  await p2.goto('/')
  await expect(p2.getByTestId('composer-input')).toBeVisible()
  await expect(p2.getByTestId('starter-line')).toHaveCount(0)
  expect(realErrors(errors2)).toEqual([])
  await other.close()
  expect(realErrors(errors)).toEqual([])
})

test('"자료 없이 해 볼게요" without marketing: the steps end, Home points at the team\'s folder', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('welcome-files-none').click()
  await expect(page.getByTestId('welcome-notes-line')).toHaveText('회의록이 생기면 Acme 폴더에 놓아 주세요')
  await page.getByTestId('welcome-notes-folder').click()
  await expect(page).toHaveURL(/\/files\?path=groups%2FAcme$/)
  expect(realErrors(errors)).toEqual([])
})
