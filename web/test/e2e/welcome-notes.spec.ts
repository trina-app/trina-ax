// The meeting-notes start in a real browser against the mock (docs/DECISIONS.md "M — One meeting note, everyone's own
// tasks", "S — The lead's way becomes a team skill"): the owner drops two meeting notes on the welcome steps' first
// result; they go into the team's own folder and "/meeting-tasks …" runs on them in a new chat; under the answer one bar
// asks "팀원 AI도 이 방식대로 하게 할까요?", the card shows the team skill made from it (title, line, the choice, "the newest
// notes"), sharing it leads to the invite with that skill; someone joins with the link and lands on its form with who
// made it, runs it, and gets their own chat.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const note = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

test('meeting notes in, tasks out; the lead\'s way becomes a team skill; a member lands on its form', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-pack-line')).toHaveText('팀 스킬을 넣어 둘게요 · 마케팅팀이에요')
  // the profile put off: the team's start goes in, then the first result asks for files
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByRole('heading', { name: '평소 일에 쓰는 파일을 놓아 주세요' })).toBeVisible()
  await expect(page.getByText('회의록, 견적서, 보고서 · 몇 개면 충분해요')).toBeVisible()
  // who sees it, with the real number (the group's members and the owners and admins)
  await expect(page.getByTestId('welcome-files-who')).toHaveText(/^여기 올린 파일은 Acme \d+명만 봐요 · 채팅은 각자만 봐요$/)
  await page.getByTestId('welcome-files-input').setInputFiles([
    note('11월 1주 회의.md', '# 11월 1주 주간 회의\n- 민지: 랜딩 시안 금요일까지\n- 지훈: 광고 집행 보고\n'),
    note('11월 2주 회의.md', '# 11월 2주 주간 회의\n- 김 대리: 견적서 정리\n'),
  ])
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  const question = page.getByTestId('user-message').first()
  // the skill by its title, then the question (the command runs underneath)
  await expect(question.getByTestId('skill-chip')).toHaveText('할 일 정리')
  await expect(question).toContainText('이 파일로 정리해 줘')
  await expect(question).not.toContainText('/meeting-tasks')
  await expect(question).toContainText('11월 1주 회의.md')
  await expect(question).toContainText('11월 2주 회의.md')
  // the files are in the team's meeting notes folder
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/회의록')}`)
  expect((await listed.json()).entries.map((e: { name: string }) => e.name).sort()).toEqual(['11월 1주 회의.md', '11월 2주 회의.md'])

  // under the answer: one bar, one button: the lead's way becomes a team skill
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('팀원 AI도 이 방식대로 하게 할까요?')
  await page.getByTestId('skill-share-open').click()
  await expect(page.getByTestId('skill-share')).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('skill-share-title')).toHaveText('주간회의 할 일')
  await expect(page.getByTestId('skill-share-choice')).toContainText('내 할 일')
  await expect(page.getByTestId('skill-share-files')).toHaveText('쓰는 자료:Acme 회의록 폴더의 가장 최근 회의록')
  await expect(page.getByTestId('skill-share-note')).toHaveText('팀 전체 AI가 이 방식을 따라요 · 팀 스킬에서 언제든 고칠 수 있어요')
  await expect(page.getByTestId('skill-share')).not.toContainText('juganhoeui')
  await page.getByTestId('skill-share-share').click()
  await page.getByTestId('team-link-create').click()
  await expect(page.getByTestId('team-link-message')).toContainText("우리 팀 '주간회의 할 일' 스킬을 만들어 뒀어요. 링크 열면 같은 방식으로 바로 써요.")
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
  // the skill's form, with who made it and who sees the chat; its one choice starts on 내 할 일
  await expect(p2).toHaveURL(/\/skills\?run=/)
  await expect(p2.getByTestId('skill-form-by')).toHaveText('Olga님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요')
  await expect(p2.getByTestId('skill-choice-scope-mine')).toHaveAttribute('data-on', 'true')
  await p2.getByTestId('skill-form-run').click()
  await expect(p2).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(p2.getByTestId('user-message').first().getByTestId('skill-chip')).toHaveText('주간회의 할 일')
  await expect(p2.getByTestId('user-message').first()).toContainText('누구 할 일: 내 할 일')
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
