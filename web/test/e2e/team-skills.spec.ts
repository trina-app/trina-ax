// Team skills (docs/DECISIONS.md "팀 스킬 관리"): who can edit them, one line on the Team skills page for the owner and
// admins, and its [바꾸기] dialog (add a person or group to all of skills/ after the warning, remove a rule, a subfolder
// rule with its folder, editors through other rules, the same rule on Admin > 폴더 권한), the server's card before the
// AI saves under skills/ (with the diff; the AI cannot answer it), the banner that links to the version history, and
// "스킬로 제안" → [등록].
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const SHOTS = process.env.STAGE67_SHOTS

const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

/** The Team skills page's [바꾸기] dialog, open. */
async function openEditors(page: Page) {
  await page.getByTestId('skill-editors-change').click()
  const dialog = page.getByRole('dialog', { name: '팀 스킬을 고칠 수 있는 사람' })
  await expect(dialog.getByTestId('skill-editors-list')).toBeVisible()
  return dialog
}

test('"고칠 수 있는 사람" on Team skills: admins only; [바꾸기] adds a person and a group after the warning, removes them; the columns are gone', async ({ page, browser }) => {
  await reset(page, { withAdmin: true })
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  const H = { [CSRF_HEADER]: '1' }
  // 영업팀 with Bob (the mock keeps a person's groups on the person too)
  const sales = await (await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업팀', memberIds: ['bob'] } })).json()
  expect((await page.request.patch('/api/admin/users/bob', { headers: H, data: { groupIds: [sales.id] } })).ok()).toBeTruthy()
  await page.goto('/skills')
  const line = page.getByTestId('skill-editors')
  await expect(line.getByTestId('skill-editors-text')).toHaveText('고칠 수 있는 사람: 팀장과 관리자만')
  // one text button, no box
  await expect(line.getByRole('button')).toHaveCount(1)
  await expect(line.getByRole('button')).toHaveText('바꾸기')

  // the owner and admins always; nobody else yet
  let dialog = await openEditors(page)
  await expect(dialog.getByTestId('skill-editor-always')).toContainText('팀장·관리자')
  await expect(dialog.getByTestId('skill-editor-always')).toContainText('항상')
  await expect(dialog.getByTestId('skill-editor')).toHaveCount(0)
  await expect(dialog.getByTestId('skill-manager-warning')).toHaveCount(0)
  // a person: searched, then the warning before anything is turned on; the owner and admins are not offered
  await dialog.getByTestId('edit-add').fill('a')
  await expect(dialog.getByTestId('edit-add-option').filter({ hasText: 'Olga' })).toHaveCount(0)
  await expect(dialog.getByTestId('edit-add-option').filter({ hasText: 'Dana' })).toHaveCount(0)
  await dialog.getByTestId('edit-add').fill('Bob')
  await dialog.locator('[data-testid="edit-add-option"][data-subject="user:bob"]').click()
  await expect(dialog.getByTestId('skill-editor-pending')).toContainText('Bob에게 skills/ 전체를 맡길까요?')
  // the warning is read first: it takes the focus, and Turn on points at it
  await expect(dialog.getByTestId('skill-manager-warning')).toContainText('팀 전체 AI가 따라요')
  await expect(dialog.getByTestId('skill-manager-warning')).toBeFocused()
  await expect(dialog.getByTestId('skill-manager-on')).toHaveAccessibleDescription(/팀 전체 AI가 따라요/)
  await dialog.getByTestId('skill-manager-on').click()
  await expect(dialog.getByTestId('skill-editor-pending')).toHaveCount(0)
  const bobRow = dialog.locator('[data-testid="skill-editor"][data-subject="user:bob"][data-path="skills"]')
  await expect(bobRow).toContainText('Bob')
  // focus back in the search, the line follows
  await expect(dialog.getByTestId('edit-add')).toBeFocused()
  await expect(line.getByTestId('skill-editors-text')).toHaveText('고칠 수 있는 사람: 팀장·관리자, Bob 님')
  // a group: Bob decides by his own rule, so the group names nobody yet
  await dialog.getByTestId('edit-add').fill('영업')
  await dialog.locator(`[data-testid="edit-add-option"][data-subject="group:${sales.id}"]`).click()
  await expect(dialog.getByTestId('skill-manager-warning')).toBeVisible()
  await dialog.getByTestId('skill-manager-on').click()
  await expect(dialog.locator(`[data-testid="skill-editor"][data-subject="group:${sales.id}"]`)).toContainText('영업팀그룹')
  // a person already there for all of skills/ is not offered again
  await dialog.getByTestId('edit-add').fill('Bob')
  await expect(dialog.locator('[data-testid="edit-add-option"][data-subject="user:bob"]')).toHaveCount(0)
  await dialog.getByTestId('edit-add').fill('')
  // remove Bob's own rule: today's confirm, and the group's rule still lets him edit
  await bobRow.getByRole('button', { name: 'Bob: skills/ 빼기' }).click()
  const confirm = page.getByRole('dialog', { name: 'Bob의 팀 스킬 관리를 끌까요?' })
  await expect(confirm).toContainText('skills/에 대한 쓰기 권한이 빠져요')
  await expect(confirm).toContainText('그룹이나 모두에게 준 규칙으로 계속 고칠 수 있어요')
  await confirm.getByRole('button', { name: '계속' }).click()
  await expect(bobRow).toHaveCount(0)
  await expect(line.getByTestId('skill-editors-text')).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // a rule on a folder of skills/ (handed over in Folder permissions): listed with its folder, removable here
  expect((await page.request.put('/api/admin/skill-managers', { headers: H, data: { subjectType: 'user', subjectId: 'bob', path: 'skills/재무', enabled: true } })).ok()).toBeTruthy()
  await page.reload()
  dialog = await openEditors(page)
  const sub = dialog.locator('[data-testid="skill-editor"][data-subject="user:bob"][data-path="skills/재무"]')
  await expect(sub.getByTestId('skill-editor-folder')).toHaveText('skills/재무/')
  await expect(dialog.getByTestId('skill-editors-by-folder')).toHaveAttribute('href', '/admin/folders?folder=skills')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/skill-editors-dialog-1360.png` })
  await sub.getByTestId('skill-editor-remove').click()
  await page.getByRole('dialog', { name: 'Bob의 팀 스킬 관리를 끌까요?' }).getByRole('button', { name: '계속' }).click()
  await expect(sub).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Admin > 폴더 권한 shows the group's rule on skills/, labelled, and points back at the Team skills page
  await page.goto('/admin/folders?folder=skills')
  const detail = page.getByTestId('folder-detail')
  await expect(detail.getByTestId('folder-rules')).toContainText('영업팀 그룹: 읽기·쓰기')
  await expect(detail.getByTestId('skill-manager-badge')).toBeVisible()
  await expect(detail).toContainText('팀 스킬 화면의 "고칠 수 있는 사람"과 같은 설정')
  // no team skills column on Members and Groups any more
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toBeVisible()
  await expect(page.getByTestId('members-table').locator('thead')).not.toContainText('팀 스킬 관리')
  await expect(page.getByRole('switch')).toHaveCount(0)
  await page.goto('/admin/groups')
  await expect(page.getByTestId('group-list')).toContainText('영업팀')
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('팀 스킬 관리')

  // an admin sees the line; a member who manages team skills (through 영업팀) does not, and asks nothing admin-only
  for (const [who, sees] of [[DANA, true], [BOB, false]] as const) {
    const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'ko-KR' })
    const p = await ctx.newPage()
    const adminCalls: string[] = []
    p.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/admin/')) adminCalls.push(r.url()) })
    await signIn(p, who)
    await p.goto('/skills')
    await expect(p.getByRole('tab', { name: '쓸 수 있는 스킬' })).toBeVisible()
    if (sees) await expect(p.getByTestId('skill-editors-text')).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
    else {
      await expect(p.getByRole('tab', { name: '검토 대기' })).toBeVisible()
      await expect(p.getByTestId('skill-editors')).toHaveCount(0)
      expect(adminCalls).toEqual([])
    }
    await ctx.close()
  }
  expect(realErrors(errors)).toEqual([])
})

test('who can edit, in words (the tree, the panel, the Team skills line); through a group or everyone, and the note before removing', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  const H = { [CSRF_HEADER]: '1' }
  const send = async (method: 'post' | 'put', url: string, data: unknown) => {
    const r = await page.request[method](url, { headers: H, data })
    expect(r.ok(), `${method} ${url}: ${r.status()}`).toBeTruthy()
    return r.json()
  }
  // 영업팀 (Bob) writes in skills/; skills/재무 lets everyone read only, so 영업팀 cannot edit there
  const sales = await send('post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  const r = await page.request.patch('/api/admin/users/bob', { headers: H, data: { groupIds: [sales.id] } })
  expect(r.ok()).toBeTruthy()
  const everyone = (access: string) => ({ subjectType: 'everyone', subjectId: null, access })
  const skills = await send('post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'group', subjectId: sales.id, access: 'write' }] })
  await send('post', '/api/admin/folders', { path: 'skills/재무', create: true, rules: [everyone('read')] })
  const shot = (name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve())

  // the tree: skills/ and its folder say who can edit, and who of skills/' managers cannot there
  await page.goto('/admin/folders?folder=skills')
  await expect(page.getByTestId('folder-skill-editors')).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
  await expect(page.getByTestId('folder-skill-locked')).toHaveCount(0)
  await page.goto('/admin/folders?folder=skills/재무')
  await expect(page.getByTestId('folder-skill-editors')).toHaveText('고칠 수 있는 사람: 팀장과 관리자만')
  await expect(page.getByTestId('folder-skill-locked')).toHaveText('skills에서는 고칠 수 있지만 여기서는 못 고치는 사람: Bob 님')
  await shot('skills-line-tree-1360')
  // the panel: the same, for the rules as edited
  await page.getByTestId('folder-detail-edit').click()
  const panel = page.getByTestId('edit-panel')
  await expect(panel.getByTestId('edit-skill-editors')).toHaveText('고칠 수 있는 사람: 팀장과 관리자만')
  await expect(panel.getByTestId('edit-skill-locked')).toHaveText('skills에서는 고칠 수 있지만 여기서는 못 고치는 사람: Bob 님')
  await panel.getByTestId('edit-basic-follow').click()
  await expect(panel.getByTestId('edit-skill-editors')).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
  await expect(panel.getByTestId('edit-skill-locked')).toHaveCount(0)
  await shot('skills-line-panel-1360')
  await page.setViewportSize({ width: 375, height: 800 })
  await expect(panel.getByTestId('edit-skill-editors')).toBeVisible()
  await shot('skills-line-panel-375')
  await page.setViewportSize({ width: 1360, height: 860 })
  await panel.getByTestId('edit-close').click()
  await page.getByRole('dialog', { name: '바꾼 규칙을 버릴까요?' }).getByRole('button', { name: '버리기', exact: true }).click()
  await expect(panel).toHaveCount(0)

  // the Team skills page says the same as the tree; the group's rule is a row of its dialog
  await page.goto('/skills')
  const text = page.getByTestId('skill-editors-text')
  await expect(text).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
  let dialog = await openEditors(page)
  await expect(dialog.locator(`[data-testid="skill-editor"][data-subject="group:${sales.id}"]`)).toBeVisible()
  await expect(dialog.getByTestId('skill-editors-elsewhere')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // everyone writes: the line says so; the dialog names it as another rule, changed in Folder permissions
  await send('put', `/api/admin/folders/${skills.id}/rules`, { rules: [everyone('write')] })
  await page.reload()
  await expect(text).toHaveText('고칠 수 있는 사람: 팀장·관리자, 모두')
  dialog = await openEditors(page)
  await expect(dialog.getByTestId('skill-editor')).toHaveCount(0)
  await expect(dialog.getByTestId('skill-editors-elsewhere')).toContainText('폴더 권한의 다른 규칙으로도 고칠 수 있어요: 모두')
  await expect(dialog.getByTestId('skill-editors-elsewhere-link')).toHaveAttribute('href', '/admin/folders?folder=skills')
  await page.setViewportSize({ width: 375, height: 800 })
  await expect(dialog.getByTestId('skill-editors-elsewhere')).toBeVisible()
  await shot('skill-editors-dialog-everyone-375')
  await page.keyboard.press('Escape')
  await expect(text).toBeVisible()
  await shot('skill-editors-line-375')
  await page.setViewportSize({ width: 1360, height: 860 })
  // a rule of his own on skills/ itself as well as his group's: removing his says first that the group's rule still
  // lets him edit (the server's preview without his row)
  await send('put', `/api/admin/folders/${skills.id}/rules`, { rules: [everyone('read'), { subjectType: 'group', subjectId: sales.id, access: 'write' }] })
  await send('put', '/api/admin/skill-managers', { subjectType: 'user', subjectId: 'bob', path: 'skills', enabled: true })
  await page.reload()
  await expect(text).toHaveText('고칠 수 있는 사람: 팀장·관리자, Bob 님')
  dialog = await openEditors(page)
  const own = dialog.locator('[data-testid="skill-editor"][data-subject="user:bob"][data-path="skills"]')
  await own.getByTestId('skill-editor-remove').click()
  await expect(page.getByRole('dialog', { name: 'Bob의 팀 스킬 관리를 끌까요?' })).toContainText('그룹이나 모두에게 준 규칙으로 계속 고칠 수 있어요')
  await page.getByRole('button', { name: '계속' }).click()
  await expect(own).toHaveCount(0)
  await expect(text).toHaveText('고칠 수 있는 사람: 팀장·관리자, 영업팀 1명')
  await page.keyboard.press('Escape')
  // his own rule on skills/재무, where everyone only reads: removing it loses him that folder, so no such note
  await send('put', '/api/admin/skill-managers', { subjectType: 'user', subjectId: 'bob', path: 'skills/재무', enabled: true })
  await page.reload()
  dialog = await openEditors(page)
  await dialog.locator('[data-testid="skill-editor"][data-subject="user:bob"][data-path="skills/재무"]').getByTestId('skill-editor-remove').click()
  const confirm = page.getByRole('dialog', { name: 'Bob의 팀 스킬 관리를 끌까요?' })
  await expect(confirm).toContainText('skills/재무/에 대한 쓰기 권한이 빠져요')
  await expect(confirm).not.toContainText('계속 고칠 수 있어요')
  await confirm.getByRole('button', { name: '취소' }).click()
  await expect(dialog.locator('[data-testid="skill-editor"][data-subject="user:bob"][data-path="skills/재무"]')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('the AI saving under skills/: the server card with the diff; 저장 saves and the banner opens the version history', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  // declined: nothing saved
  await ask(page, 'skillsave this workflow')
  let card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('팀 서버의 안전 확인')
  await expect(card).toContainText('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요')
  await card.getByRole('button', { name: '저장하지 않기', exact: true }).click()
  await expect(lastAnswer(page)).toContainText('Not saved')
  // saved
  await page.getByTestId('composer-input').fill('skillsave again')
  await page.getByTestId('send').click()
  card = page.getByTestId('ask-card')
  const preview = card.getByTestId('skill-preview')
  await expect(preview).toContainText('skills/weekly.md')
  await expect(preview).toContainText('새 파일')
  await expect(preview.getByTestId('skill-preview-count')).toHaveText('+6 −0줄')
  await expect(preview.getByTestId('skill-preview-diff')).toContainText('+name: 주간 보고서')
  await card.getByRole('button', { name: '저장', exact: true }).click()
  await expect(lastAnswer(page)).toContainText('Saved skills/weekly.md')
  // owner and admins hear about the change, with a link to the version history
  await page.getByRole('button', { name: '버전 기록 보기' }).last().click()
  await expect(page).toHaveURL(/\/files\?path=skills.*history=skills%2Fweekly\.md/)
  await expect(page.getByRole('dialog', { name: /weekly\.md/ })).toBeVisible()
  // and in 팀 스킬 > 최근 변경, marked as saved by the AI
  await page.keyboard.press('Escape')
  await page.goto('/skills')
  await page.getByRole('tab', { name: '최근 변경' }).click()
  const change = page.getByTestId('skill-change').first()
  await expect(change).toContainText('skills/weekly.md')
  await expect(change).toContainText('AI가 저장')
  expect(realErrors(errors)).toEqual([])
})

test('"스킬로 제안" from an answer → the manager reviews, edits and registers it → the suggester sees it registered', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, BOB)
  await ask(page, 'how do we write the weekly report')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByTestId('suggest-skill').click()
  const dialog = page.getByTestId('suggest-dialog')
  await expect(dialog).toContainText('skills/에 바로 들어가지 않아요')
  await expect(dialog.getByTestId('suggest-content')).toHaveValue(/the answer/)
  await dialog.getByTestId('suggest-name').fill('주간/보고')
  await expect(dialog).toContainText('슬래시(/)는 쓸 수 없어요')
  await expect(page.getByTestId('suggest-send')).toBeDisabled()
  await dialog.getByTestId('suggest-name').fill('주간 보고')
  await dialog.getByTestId('suggest-description').fill('회의록으로 주간 보고서를 만든다')
  await page.getByTestId('suggest-send').click()
  await expect(page.getByText('스킬을 제안했어요. 검토가 끝나면 알려 드려요.')).toBeVisible()
  await page.getByTestId('nav-skills').click()
  // the page opens on the skills Bob can use; his suggestion is on "내 제안"
  await expect(page.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: '내 제안' }).click()
  const mine = page.getByTestId('mine-list').getByTestId('suggestion')
  await expect(mine).toHaveAttribute('data-status', 'pending')
  await expect(mine).toContainText('주간 보고')
  await expect(page.getByRole('tab', { name: /검토 대기/ })).toHaveCount(0) // bob manages nothing

  // the owner manages skills/: a count on the review tab (the sidebar's count is the Inbox's), the review dialog, edit,
  // 등록
  const ctx = await browser.newContext({ baseURL: page.url().replace(/\/skills.*$/, ''), locale: 'ko-KR' })
  const owner = await ctx.newPage()
  await signIn(owner, OWNER)
  await owner.getByTestId('nav-skills').click()
  await expect(owner.getByRole('tab', { name: '검토 대기 (1)' })).toBeVisible()
  await owner.getByTestId('review-list').getByTestId('review-open').click()
  const review = owner.getByTestId('review-dialog')
  await expect(review.getByTestId('review-preview')).toContainText('the answer')
  await review.getByTestId('review-name').fill('주간 보고서')
  await owner.getByTestId('review-approve').click()
  await expect(owner.getByText('스킬을 등록했어요: skills/주간-보고서.md')).toBeVisible()
  await expect(owner.getByTestId('review-list').getByTestId('suggestion')).toHaveAttribute('data-status', 'approved')
  await ctx.close()

  // the suggester hears it and sees it registered
  await expect(page.getByText('제안한 스킬이 등록됐어요')).toBeVisible()
  await page.getByRole('tab', { name: '쓸 수 있는 스킬' }).click()
  // already on the page: the link still changes the tab
  await page.getByRole('status').filter({ hasText: '제안한 스킬이 등록됐어요' }).getByRole('button', { name: '팀 스킬 열기' }).click()
  await expect(page.getByRole('tab', { name: '내 제안' })).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await page.getByRole('tab', { name: '내 제안' }).click()
  await expect(page.getByTestId('mine-list').getByTestId('suggestion')).toHaveAttribute('data-status', 'approved')
  await expect(page.getByTestId('mine-list')).toContainText('skills/주간-보고서.md')
  // (the first-time folder card probes folders the member cannot see: those 404s are expected)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('[거절] with a note: the suggester sees the reason', async ({ page }) => {
  await reset(page)
  await signIn(page, OWNER)
  await ask(page, 'some workflow')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByTestId('suggest-skill').click()
  await page.getByTestId('suggest-name').fill('흐름')
  await page.getByTestId('suggest-send').click()
  await page.goto('/skills')
  await page.getByRole('tab', { name: /검토 대기/ }).click()
  await page.getByTestId('review-open').click()
  await page.getByTestId('review-reject').click()
  await page.getByRole('dialog', { name: '거절' }).getByRole('textbox').fill('비슷한 스킬이 이미 있어요')
  await page.getByRole('dialog', { name: '거절' }).getByRole('button', { name: '거절' }).click()
  await page.getByRole('tab', { name: '내 제안' }).click()
  const s = page.getByTestId('mine-list').getByTestId('suggestion')
  await expect(s).toHaveAttribute('data-status', 'rejected')
  await expect(s.getByTestId('review-note')).toContainText('비슷한 스킬이 이미 있어요')
})

// App review 2026-11-01: a member's Team skills page listed no skills, only their own suggestions (admins at least had
// "최근 변경"). The first tab lists what each person can use, read-only, from the same list as the "/" menu.
test('"쓸 수 있는 스킬": every person sees the skills they can use, members too, without managers\' controls', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  expect((await page.request.post('/__test/skills', { data: { files: [
    { path: 'skills/quote.md', name: '견적서', description: '고객 견적서 초안을 만들어요' },
    { path: 'skills/weekly/SKILL.md', name: 'weekly', description: '주간 보고서' },
    { path: 'skills/임원/board.md', name: '이사회 메모', description: '관리자만 읽는 폴더' },
    { path: 'users/bob/skills/tone.md', name: '내 말투', description: 'Bob의 메일 말투' },
  ] } })).ok()).toBeTruthy()
  await signIn(page, BOB)
  await page.getByTestId('nav-skills').click()
  await expect(page.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  // only "내 제안" besides it: no review, no recent changes
  await expect(page.getByRole('tab')).toHaveCount(2)
  const list = page.getByTestId('skill-list')
  await expect(list.getByTestId('skill-row')).toHaveCount(3)
  await expect(list).toContainText('견적서')
  await expect(list).toContainText('고객 견적서 초안을 만들어요')
  await expect(list.getByTestId('skill-row').filter({ hasText: 'weekly' })).toHaveAttribute('data-path', 'skills/weekly/SKILL.md')
  await expect(list).not.toContainText('SKILL.md')
  // a skill in a folder Bob cannot read is not his to use; his own personal skill is marked
  await expect(list).not.toContainText('이사회 메모')
  await expect(list.getByRole('region', { name: '개인' }).getByTestId('skill-row')).toContainText('내 말투')
  // read-only: use it in a chat, or open its file
  await expect(list.getByRole('button')).toHaveCount(6)
  await list.getByTestId('skill-row').filter({ hasText: '견적서' }).getByRole('button', { name: /^\/견적서 .*채팅에서 쓰기$/ }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/견적서 ')
  await page.goto('/skills')
  await page.getByRole('button', { name: '/weekly 스킬 메뉴' }).click()
  await page.getByRole('menuitem', { name: '파일 보기' }).click()
  await expect(page).toHaveURL(/\/files\?path=skills%2Fweekly&select=skills%2Fweekly%2FSKILL\.md/)

  // the owner: the admins-only folder's skill too, next to the managers' tabs
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'ko-KR' })
  const owner = await ctx.newPage()
  await signIn(owner, OWNER)
  await owner.goto('/skills')
  await expect(owner.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  await expect(owner.getByRole('tab', { name: '최근 변경' })).toBeVisible()
  await expect(owner.getByTestId('skill-row')).toHaveCount(3)
  await expect(owner.getByTestId('skill-list')).toContainText('이사회 메모')
  await expect(owner.getByTestId('skill-list')).not.toContainText('내 말투')
  await ctx.close()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('the skills I can use: most used first, search, "…" opens the file, the row starts a chat', async ({ page }) => {
  await reset(page)
  await page.route(/\/api\/skills(\?.*)?$/, (r) => r.fulfill({ json: { items: [
    { path: 'skills/proposal.md', name: 'proposal', description: 'Writes a client proposal deck' },
    { path: 'skills/weekly/SKILL.md', name: 'weekly', description: '' },
  ] } }))
  await page.route('**/api/skills/popular', (r) => r.fulfill({ json: { days: 30, items: [
    { path: 'skills/weekly/SKILL.md', name: 'weekly', description: '', uses: 4, users: 2 },
  ] } }))
  await signIn(page, OWNER)
  await page.goto('/skills')
  const rows = page.getByTestId('skill-row')
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('skill-count')).toHaveText('2')
  await expect(rows.first()).toContainText('/weekly')
  await expect(rows.first()).toContainText('4회')
  // the row says the name people type and the description; the path is in the "…" menu, not before the description
  await expect(rows.last()).toContainText('/proposal')
  await expect(rows.last()).toContainText('Writes a client proposal deck')
  await expect(rows.last()).not.toContainText('skills/')

  const search = page.getByRole('searchbox', { name: '스킬 검색' })
  await search.fill('CLIENT')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('proposal')
  await search.fill('nothing like this')
  await expect(page.getByText('"nothing like this"에 맞는 스킬이 없어요.')).toBeVisible()
  await search.fill('')
  await expect(rows).toHaveCount(2)

  const more = page.getByRole('button', { name: '/proposal 스킬 메뉴' })
  await more.click()
  await expect(page.getByRole('menuitem', { name: '채팅에서 쓰기' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()
  await more.click()
  await page.getByRole('heading', { name: '팀 스킬', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await more.click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await more.click()
  await page.getByTestId('skill-file').click()
  await expect(page).toHaveURL(/\/files\?path=skills&select=skills%2Fproposal\.md/)

  await page.goto('/skills')
  await page.getByRole('button', { name: /^\/proposal .*채팅에서 쓰기$/ }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/proposal ')
})

test('a link to my suggestions works again while the page is open; on a phone the chosen tab is in view', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.setViewportSize({ width: 375, height: 812 })
  await signIn(page)
  await page.goto('/skills?mine=1')
  const row = page.getByRole('tablist', { name: 'Team skills' })
  const selected = row.locator('[role="tab"][aria-selected="true"]')
  await expect(selected).toHaveText('My suggestions')
  // applied, the link leaves the address, so the same link works again later
  await expect.poll(() => new URL(page.url()).searchParams.has('mine')).toBe(false)
  const inView = () => selected.evaluate((tab) => {
    const r = tab.parentElement!.getBoundingClientRect()
    const b = tab.getBoundingClientRect()
    return b.left >= r.left - 1 && b.right <= r.right + 1
  })
  await expect.poll(inView).toBe(true)
  // the admin's four tabs do not fit this width in English: a tab chosen out of view scrolls into the row (a DOM
  // click, because Playwright's own click would scroll it first)
  expect(await row.evaluate((r) => r.scrollWidth > r.clientWidth)).toBe(true)
  await row.evaluate((r) => { r.scrollLeft = r.scrollWidth })
  await row.evaluate((r) => (r.querySelector('[role="tab"]') as HTMLElement).click())
  await expect(selected).toHaveText('Available skills')
  await expect.poll(inView).toBe(true)
  // a banner's link to my suggestions again, while the page is open
  await page.evaluate(() => {
    history.pushState({}, '', '/skills?mine=1')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(selected).toHaveText('My suggestions')
  await expect.poll(inView).toBe(true)
})

test('no skill to use yet: the tab says so and how one gets there', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/skills')
  await expect(page.getByTestId('skill-list')).toHaveCount(0)
  await expect(page.getByText('아직 쓸 수 있는 스킬이 없어요.')).toBeVisible()
  await expect(page.getByText('"스킬로 제안"을 눌러 제안할 수 있어요')).toBeVisible()
})
