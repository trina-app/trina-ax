// What a new member sees first (docs/DECISIONS.md "W6.3"; components/onboarding/TeamPrepared.tsx, GET /api/skills/
// examples), at 1440 and 390:
// - a member whose team has the four kept skills and files: "팀에 준비된 것" with three skill rows, "팀 스킬 1개 더" and the
//   files row (the brand folder not counted); one filled button; 자연스러운 글 fills the box with "/humanizer …:" with the
//   caret after it (typing or pasting next goes after the command; alone it does not send and the box says to paste the
//   text); another skill's form over Home and back; 예시; 물어보기 fills the box with the folder by its name; on a phone
//   the row's tap (it says 써 보기) and 예시 its own target;
// - a member on a team with nothing: "이렇게 시작해 보세요" and one filled question (the profile's when one is saved, else
//   what the AI can do for the team: never a path); one outside the team group (a single-use invite) sees the team's
//   files too, which are in 전사 공유 (shared/, docs/DECISIONS.md "Team folder basics");
// - a member who chatted before: the skills still show (the files row does not) until they run a team skill;
// - the owner's own first Home: the block without a filled button; an empty team: "스킬 넣기 · 팀 파일 넣기" (팀 스킬 with
//   the ready-made skills unfolded); the goal card of an empty team someone joined: [스킬 넣기] first, [다시 보내기] quiet;
// - the invite step (5/5) of an empty team: "지금 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기", the way to 내
//   스킬 and back to 초대, hidden while "이 사람이 팀장이에요" is ticked; gone once the team has a skill.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const H = { [CSRF_HEADER]: '1' }
const PROFILE = { website: 'https://acme.example/', oneLine: 'Acme는 조용한 책상 선풍기를 만들어요', products: '책상 선풍기', audience: '작은 사무실', tone: [], avoid: '', sources: [] }
/** the team's files: shared/ since docs/DECISIONS.md "Team folder basics" (the team group keeps groups/Acme) */
const FOLDER = 'shared'

async function call(page: Page, method: 'POST' | 'PATCH' | 'PUT', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}

/** As the owner: the team's start (its group and folders), the setup ended; the four kept skills in, the team's files
 * (one in the brand folder, which does not count) and bob in the team group unless `outside`. Signed out after. */
async function prepare(page: Page, o: { skills?: boolean; files?: boolean; outside?: boolean; profile?: boolean } = {}) {
  await signIn(page)
  const team = await call(page, 'POST', '/api/onboarding/welcome/team')
  await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
  const group = team.progress.teamGroup as { id: string; folder: string; brandFolder: string; home?: string }
  expect(group.folder).toBe('groups/Acme')
  expect(group.home).toBe(FOLDER)
  if (!o.outside) await call(page, 'PATCH', `/api/admin/groups/${group.id}`, { memberIds: ['olga', 'bob'] })
  if (o.skills) {
    await call(page, 'POST', '/api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] })
    await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  }
  await call(page, 'POST', '/__test/file', { path: `${group.brandFolder}/회사 소개.md`, text: '# Acme' })
  if (o.files) for (const name of ['견적서.md', '2026/매출.csv']) await call(page, 'POST', '/__test/file', { path: `${FOLDER}/회사 자료/${name}`, text: 'x' })
  if (o.profile) await call(page, 'PUT', '/api/onboarding/profile', PROFILE)
  await page.context().clearCookies()
}

const block = (page: Page) => page.getByTestId('team-prepared')
const filled = (page: Page) => block(page).locator('button.bg-accent')

for (const width of [1440, 390] as const) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })
    const phone = width === 390

    test('a member with skills and files: three rows, "1개 더", the files row; one filled; 자연스러운 글 fills the box; a form over Home; 예시; 물어보기', async ({ page }) => {
      const errors = watchConsole(page)
      await reset(page)
      await prepare(page, { skills: true, files: true })
      await signIn(page, BOB)
      await expect(block(page)).toBeVisible()
      await expect(block(page).getByRole('heading')).toHaveText('팀에 준비된 것')
      const rows = block(page).getByTestId('team-prepared-skill')
      await expect(rows).toHaveCount(3)
      expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['skills/work/humanizer/SKILL.md', 'skills/general/card-news/SKILL.md', 'skills/general/promo-video/SKILL.md'])
      await expect(rows.first()).toContainText('자연스러운 글')
      await expect(rows.first()).toContainText('AI가 쓴 티가 나는 글을 사람이 쓴 것처럼 다듬어요')
      await expect(block(page).getByTestId('team-prepared-more')).toHaveText('팀 스킬 1개 더')
      // two documents: the brand folder's intro does not count
      await expect(block(page).getByTestId('team-prepared-files')).toContainText('파일 2개')
      if (phone) {
        await expect(filled(page)).toHaveCount(0)
        await expect(rows.first()).toHaveAttribute('data-primary', 'true')
        // each row says what its tap does
        await expect(rows.first().getByTestId('team-prepared-try-label')).toHaveText('써 보기')
        await expect(rows.first().getByTestId('team-prepared-try-label')).toBeVisible()
        await expect(rows.nth(1).getByTestId('team-prepared-try-label')).toBeVisible()
        // 예시 is its own 44px target at the row's end
        const box = await rows.nth(1).getByTestId('team-prepared-example').boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(44)
        expect(box!.width).toBeGreaterThanOrEqual(44)
      } else {
        await expect(filled(page)).toHaveCount(1)
        await expect(rows.first().getByTestId('team-prepared-try')).toHaveClass(/(^|\s)bg-accent(\s|$)/)
        await expect(block(page).getByTestId('team-prepared-files')).toContainText('전사 공유')
      }
      // 자연스러운 글: the box, no form; alone it does not go, and the box says what to add
      const box = page.getByTestId('composer-input')
      const ASK = '/humanizer 아래 글을 자연스럽게 다듬어 줘:\n'
      await rows.first().getByTestId('team-prepared-try').click()
      await expect(box).toHaveValue(ASK)
      await expect(page.getByTestId('skill-form')).toHaveCount(0)
      await expect(page.getByTestId('composer-waits')).toHaveText('다듬을 글을 붙여 넣어 주세요')
      await expect(page.getByTestId('send')).toBeDisabled()
      // the caret after the request: what the person pastes or types next follows the command
      await expect(box).toBeFocused()
      expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([ASK.length, ASK.length, ASK.length])
      await page.keyboard.insertText('회의 결과를 공유드립니다.')
      await page.keyboard.type(' 감사합니다')
      await expect(box).toHaveValue(`${ASK}회의 결과를 공유드립니다. 감사합니다`)
      await expect(page.getByTestId('composer-waits')).toHaveCount(0)
      await expect(page.getByTestId('send')).toBeEnabled()
      // 카드뉴스: its form over Home; ✕ comes back to the block
      await rows.nth(1).getByTestId('team-prepared-try').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('skill-form')).toHaveAttribute('data-path', 'skills/general/card-news/SKILL.md')
      await expect(dialog).toContainText('카드뉴스')
      await dialog.getByRole('button', { name: '닫기' }).first().click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page).toHaveURL(/\/$/)
      await expect(block(page)).toBeVisible()
      // 예시: the viewer with the example; Esc back
      await rows.nth(1).getByTestId('team-prepared-example').click()
      await expect(page.getByTestId('skill-example')).toHaveAttribute('data-name', 'card-news')
      await expect(page.getByTestId('skill-example-image')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('skill-example')).toHaveCount(0)
      // 물어보기: the question in the box, not sent; the folder by its name, the left-out folders in words; the caret after it
      await block(page).getByTestId('team-prepared-ask').click()
      const asked = '전사 공유 폴더에서 브랜드 폴더와 스킬 폴더는 빼고, 파일 이름과 종류만 보고 내가 먼저 보면 좋을 것 3개를 골라 줘'
      await expect(box).toHaveValue(asked)
      await expect(box).toBeFocused()
      await page.keyboard.type('!')
      await expect(box).toHaveValue(`${asked}!`)
      await expect(page.getByTestId('composer-waits')).toHaveCount(0)
      await expect(page).toHaveURL(/\/$/)
      // 팀 스킬 1개 더 › 팀 스킬
      await block(page).getByTestId('team-prepared-more').click()
      await expect(page).toHaveURL(/\/skills$/)
      expect(realErrors(errors)).toEqual([])
    })

    test('a member on a team with nothing: "이렇게 시작해 보세요" and one filled question; one outside the team group sees the files in 전사 공유', async ({ page }) => {
      await reset(page)
      await signIn(page, BOB)
      await expect(block(page)).toHaveAttribute('data-state', 'ready')
      await expect(block(page).getByRole('heading')).toHaveText('이렇게 시작해 보세요')
      const ready = block(page).getByTestId('team-prepared-ready')
      const START = '우리 팀 일을 어떻게 도와줄 수 있는지 3가지만 알려 줘'
      await expect(ready).toHaveText(START)
      // the question fits its button (a phone wraps it; it ran past the button's edge before)
      expect(await ready.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await expect(filled(page)).toHaveCount(1)
      await ready.click()
      await expect(page.getByTestId('composer-input')).toHaveValue(START)
      await expect(page.getByTestId('send')).toBeEnabled()
      // a single-use invite: outside the team group; the team's files are in shared/, which everyone sees
      await reset(page)
      await prepare(page, { files: true, outside: true, profile: true })
      await signIn(page, BOB)
      await expect(block(page).getByTestId('team-prepared-files')).toContainText('파일 2개')
      await expect(block(page).getByTestId('team-prepared-ready')).toHaveCount(0)
      // nothing prepared but the profile: the profile's question
      await reset(page)
      await prepare(page, { outside: true, profile: true })
      await signIn(page, BOB)
      await expect(block(page)).toHaveAttribute('data-state', 'ready')
      await expect(block(page).getByTestId('team-prepared-ready')).toHaveText('우리 회사가 하는 일을 3줄로 정리해 줘')
    })

    test('a member who chatted before: the skills stay (not the files row) until they run a team skill', async ({ page }) => {
      await reset(page)
      await prepare(page, { skills: true, files: true })
      await signIn(page, BOB)
      await expect(block(page).getByTestId('team-prepared-files')).toBeVisible()
      await page.getByTestId('composer-input').fill('안녕하세요')
      await page.getByTestId('composer-input').press('Enter')
      await expect(page).toHaveURL(/\/c\//)
      await page.goto('/')
      await expect(block(page).getByTestId('team-prepared-skill')).toHaveCount(3)
      await expect(block(page).getByTestId('team-prepared-files')).toHaveCount(0)
      // a team skill run: the block is gone (the skills stay on 팀 스킬)
      await page.getByTestId('composer-input').fill('/humanizer 이 글을 다듬어 줘')
      await expect(page.getByTestId('skill-menu')).toHaveCount(0)
      await page.getByTestId('composer-input').press('Enter')
      await expect(page).toHaveURL(/\/c\//)
      const read = page.waitForResponse((r) => r.url().includes('/api/skills/examples'))
      await page.goto('/')
      expect(((await (await read).json()) as { ranTeamSkill: boolean }).ranTeamSkill).toBe(true)
      await expect(page.getByTestId('composer-input')).toBeVisible()
      // (the answer has been read: the block would be on screen by now)
      await page.waitForTimeout(300)
      await expect(block(page)).toHaveCount(0)
    })

    test('the owner\'s own first Home: the rows, no filled button; an empty team: "스킬 넣기 · 팀 파일 넣기"', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await expect(block(page)).toHaveAttribute('data-state', 'add')
      await expect(block(page).getByTestId('team-prepared-ready')).toHaveCount(0)
      await expect(block(page).getByTestId('team-prepared-add')).toHaveText('스킬 넣기 · 팀 파일 넣기')
      await expect(filled(page)).toHaveCount(0)
      // 팀 스킬 with the ready-made skills unfolded
      await block(page).getByTestId('team-prepared-add-skills').click()
      await expect(page).toHaveURL(/\/skills\?catalog=open$/)
      await expect(page.getByTestId('skill-catalog-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('skill-pack-row')).toHaveCount(4)
      // with the skills in
      await reset(page)
      await prepare(page, { skills: true, files: true })
      await signIn(page)
      await expect(block(page).getByTestId('team-prepared-skill')).toHaveCount(3)
      await expect(block(page).getByTestId('team-prepared-files')).toBeVisible()
      await expect(filled(page)).toHaveCount(0)
      await expect(block(page)).not.toHaveAttribute('data-primary', /./)
    })
  })
}

test('the invite step of an empty team: one line, the way to 내 스킬 and back to 초대; hidden while the lead box is ticked; gone with a skill', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  const line = page.getByTestId('invite-empty-team')
  await expect(line).toHaveText('지금 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기')
  // never blocks: the message and its copy are there
  await expect(page.getByTestId('team-link-copy-message')).toBeEnabled()
  // 스킬 넣기 → 내 스킬; 나중에 → back to 초대
  await line.getByTestId('invite-empty-skills').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  // 팀 파일 넣기 → 팀 파일; 나중에 → back to 초대
  await page.getByTestId('invite-empty-files').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  // the lead will set up: no line while the box is ticked
  await page.getByTestId('lead-flag-check').check()
  await expect(line).toHaveCount(0)
  await page.getByTestId('lead-flag-check').uncheck()
  await expect(line).toBeVisible()
  // a skill in the team: no line
  await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  await page.reload()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('team-link-message')).toBeVisible()
  await expect(line).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('the goal card of an empty team someone joined: skills come first ([스킬 넣기], filled, opens the catalog), [다시 보내기] stays quiet', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  const start = Date.now() - 86_400_000
  await call(page, 'POST', '/__test/team-goal', { goal: {
    state: 'open', target: 3, days: 7, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86_400_000).toISOString(), daysLeft: 6,
    skill: null, reachedAt: null, joined: 1, waiting: { first: '민지', more: 0 },
  } })
  await page.goto('/')
  const card = page.getByTestId('team-goal')
  await expect(card.getByTestId('team-goal-next')).toHaveText('민지님이 들어왔어요. 팀 스킬을 넣으면 같이 써 볼 수 있어요.')
  await expect(card).not.toContainText('써 보기 전')
  // one filled button, [스킬 넣기]; [다시 보내기] beside it, not filled
  await expect(card.locator('button.bg-accent')).toHaveCount(1)
  await expect(card.getByTestId('team-goal-add-skills')).toHaveClass(/(^|\s)bg-accent(\s|$)/)
  await expect(card.getByTestId('team-goal-resend')).toBeVisible()
  await expect(card.getByTestId('team-goal-resend')).not.toHaveClass(/(^|\s)bg-accent(\s|$)/)
  await card.getByTestId('team-goal-add-skills').click()
  await expect(page).toHaveURL(/\/skills\?catalog=open$/)
  await expect(page.getByTestId('skill-catalog-toggle')).toHaveAttribute('aria-expanded', 'true')
  // a skill in: the card goes back to the goal's own line and button
  await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  await page.goto('/')
  await expect(card.getByTestId('team-goal-next')).toHaveText('민지님이 들어왔어요. 팀 스킬은 아직 써 보기 전이에요.')
  await expect(card.getByTestId('team-goal-add-skills')).toHaveCount(0)
  await expect(card.getByTestId('team-goal-resend')).toHaveClass(/(^|\s)bg-accent(\s|$)/)
  expect(realErrors(errors)).toEqual([])
})
