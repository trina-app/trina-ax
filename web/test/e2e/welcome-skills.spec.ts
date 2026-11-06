// 내 스킬 가져오기 in a real browser against the mock (docs/DECISIONS.md "K"): the first result starts the deck and the
// steps go on at once; [내 스킬 찾기] opens the folder window (Chrome's showDirectoryPicker, stubbed here with an
// in-memory .claude folder that logs every name opened: Playwright cannot drive the OS folder window), the list comes
// back checked and judged, [팀에 공유 · N개] shares the ticked ones; 팀 파일 is put off; the finished deck opens, and its
// [팀에 공유] invites with a message naming the shared skills and a link that opens the first of them.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

/** A .claude folder: skills, a plugin, a command, CLAUDE.md, and what must never be opened. */
const TREE = {
  'CLAUDE.md': '# 일하는 방식\n- 답은 해요체로 짧게 써요.\n',
  '.credentials.json': '{"never":"read"}',
  'history.jsonl': 'never read',
  projects: { 'x': { 'a.jsonl': 'never read' } },
  skills: {
    'weekly-report': { 'SKILL.md': '---\nname: weekly-report\ndescription: 주간 업무 보고를 써요\n---\n이번 주 한 일을 정리해요.\n' },
    'quote-draft': { 'SKILL.md': '---\nname: quote-draft\ndescription: 견적서 초안\n---\ntemplates/quote.md 양식으로 써요.\n', templates: { 'quote.md': '# 견적서\n' } },
  },
  commands: { 'standup.md': '어제, 오늘, 막힌 일을 한 줄씩.\n' },
}

test('[내 스킬 찾기] → the list → [팀에 공유]; the deck opens; the invite names the shared skills and opens the first', async ({ page }) => {
  const errors = watchConsole(page)
  await page.addInitScript((tree) => {
    const opened: string[] = []
    ;(window as unknown as { __opened: string[] }).__opened = opened
    type Node = string | { [name: string]: Node }
    const dir = (name: string, t: { [name: string]: Node }, at: string): unknown => ({
      kind: 'directory', name,
      async getDirectoryHandle(n: string) { const c = t[n]; opened.push(`${at}${n}/`); if (!c || typeof c === 'string') throw new DOMException('NotFound', 'NotFoundError'); return dir(n, c, `${at}${n}/`) },
      async getFileHandle(n: string) { const c = t[n]; opened.push(`${at}${n}`); if (typeof c !== 'string') throw new DOMException('NotFound', 'NotFoundError'); return { kind: 'file', name: n, getFile: async () => new File([c], n, { type: 'text/plain' }) } },
      async *entries() { opened.push(`${at}*`); for (const [n, c] of Object.entries(t)) yield [n, typeof c === 'string' ? { kind: 'file', name: n } : { kind: 'directory', name: n }] },
    })
    ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => dir('.claude', tree as { [name: string]: Node }, '')
  }, TREE)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('welcome-files-none').click()
  // 3/4 내 스킬, the deck building behind it
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('3/4 내 스킬')
  await expect(page.getByRole('heading', { name: 'Claude에서 쓰던 스킬, 팀도 쓰게 할까요?' })).toBeVisible()
  await expect(page.getByTestId('skills-promise')).toBeVisible()
  await expect(page.getByTestId('skills-cc-prompt')).toContainText('내 스킬 중 팀에 공유할 만한 걸 트리나에 올려 줘')
  await page.getByTestId('skills-find').click()
  // the list: recommended ones ticked with a reason each, the folded rows, CLAUDE.md as a rule, one primary
  await expect(page.getByTestId('skills-recommended')).toBeVisible()
  await expect(page.getByTestId('skills-share')).toBeEnabled()
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
  // only known places: never transcripts, history or the sign-in file
  expect(opened.filter((x) => /credentials|history|projects/.test(x))).toEqual([])
  await page.getByTestId('skills-share').click()
  await expect(page.getByTestId('skills-done')).toBeVisible()
  await page.getByTestId('skills-done-next').click()
  // 4/4 팀 파일, put off; the deck opens (it was done meanwhile) or its progress first
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  // [팀에 공유] under the deck: the invite names the shared skills; the link opens the first one shared
  await page.getByTestId('welcome-invite-open').click()
  await expect(page.getByTestId('team-link-message')).toContainText('같이 써 보자고 해요')
  await expect(page.getByTestId('team-link-landing')).toContainText('부터 열려요')
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  const link = (await (await page.request.get('/api/admin/team-link')).json()).link
  expect(progress.steps.skills).toBe('done')
  expect(link.skill.path).toBe(progress.shared.landing)
  expect(realErrors(errors)).toEqual([])
})
