// The integrated product, end to end, in a real browser. Steps share the team they build (state.json), run in
// order, and each signs in afresh, so one step can be rerun on its own against a running product (E2E_REUSE=1).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { countEngineCall, DIRECT, readState, RELAYED, writeState, type Account } from './lib/dev'
import { FINANCE_CANARY, LAUNCH_FACT, makeFixtures, type Fixtures } from './lib/fixtures'
import { api, deltasOf, lastAnswer, lastAnswerId, lastAssistantId, newChat, recordWs, send, serverMessages, signIn, waitAnswer } from './lib/ui'

test.describe.configure({ mode: 'serial' })

let fx: Fixtures
test.beforeAll(() => {
  fx = makeFixtures()
})

/** A fresh browser context signed in as `who` on `base`. */
async function as(browser: Browser, base: string, who: Account): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: base })
  const page = await ctx.newPage()
  await signIn(page, base, who)
  return { ctx, page }
}

/** Collect console errors / page errors of a page (CSP violations show up here). */
function watch(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}
const realErrors = (e: string[]) => e.filter((x) => !/status of 401|status of 404 \(Not Found\)/.test(x))

test('step 1: first owner, language, groups, members (invite + direct), folder rules', async ({ browser }) => {
  const st = readState()
  expect(st.setupToken, 'setup token from the dev log').toBeTruthy()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = watch(page)

  // first owner
  await page.goto(`${DIRECT}/setup?token=${st.setupToken}`)
  await page.getByRole('combobox', { name: '언어' }).selectOption('ko')
  await page.getByTestId('setup-team').fill('Demo Team')
  await page.getByRole('textbox', { name: '이름', exact: true }).fill(st.owner.name)
  await page.getByRole('textbox', { name: '아이디' }).fill(st.owner.username)
  await page.getByRole('textbox', { name: '비밀번호', exact: true }).fill(st.owner.password)
  await page.getByRole('textbox', { name: '비밀번호 확인' }).fill(st.owner.password)
  await page.getByRole('button', { name: '팀 만들고 시작하기' }).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()

  // sign out and in again (the login form, not only the setup session)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-username')).toBeVisible()
  await signIn(page, DIRECT, st.owner)

  // language: English, then back to Korean (saved on the account)
  await page.goto(`${DIRECT}/settings`)
  await page.getByTestId('locale-en').click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByTestId('locale-ko').click()
  await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible()

  // groups
  await page.goto(`${DIRECT}/admin/groups`)
  for (const g of ['marketing', 'finance']) {
    await page.getByTestId('group-new').click()
    await page.getByTestId('group-name').fill(g)
    await page.getByTestId('group-save').click()
    await expect(page.getByTestId('group-list')).toContainText(g)
  }

  // alice: invite link (role member, group marketing), accepted in another browser
  await page.goto(`${DIRECT}/admin/members`)
  await page.getByTestId('invite-new').click()
  await page.getByRole('dialog').getByLabel('marketing').check()
  await page.getByTestId('invite-create').click()
  const link = (await page.getByTestId('secret-value').textContent())!.trim()
  expect(link).toMatch(/\/invite\//)
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('invite-list')).toContainText('marketing')

  const actx = await browser.newContext()
  const ap = await actx.newPage()
  await ap.goto(link)
  await ap.getByTestId('invite-name').fill(st.alice.name)
  await ap.getByTestId('invite-username').fill(st.alice.username)
  await ap.getByTestId('invite-password').fill(st.alice.password)
  await ap.getByTestId('invite-password2').fill(st.alice.password)
  await ap.getByTestId('invite-submit').click()
  await expect(ap.getByTestId('composer-input')).toBeVisible()
  await actx.close()

  // bob: added directly (group finance) with a temporary password he must change
  await page.reload()
  await page.getByRole('button', { name: '직접 추가' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('이름', { exact: true }).fill(st.bob.name)
  await dlg.getByLabel('아이디').fill(st.bob.username)
  await dlg.getByLabel('finance').check()
  await dlg.getByRole('button', { name: '만들기' }).click()
  const temp = (await page.getByTestId('secret-value').textContent())!.trim()
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('members-table')).toContainText(st.bob.name)
  await expect(page.getByTestId('members-table')).toContainText('비밀번호 변경 필요')

  const bctx = await browser.newContext()
  const bp = await bctx.newPage()
  await bp.goto(`${DIRECT}/login`)
  await bp.getByTestId('login-username').fill(st.bob.username)
  await bp.getByTestId('login-password').fill(temp)
  await bp.getByTestId('login-submit').click()
  await bp.getByLabel('임시 비밀번호').fill(temp)
  await bp.getByLabel('새 비밀번호').fill(st.bob.password)
  await bp.getByLabel('비밀번호 확인').fill(st.bob.password)
  await bp.getByRole('button', { name: '비밀번호 바꾸기' }).click()
  await expect(bp.getByTestId('composer-input')).toBeVisible()
  await bctx.close()

  const users = (await api<{ items: { id: string; username: string; groupIds: string[] }[] }>(page.request, DIRECT, 'GET', '/api/admin/users')).items
  const groups = (await api<{ items: { id: string; name: string }[] }>(page.request, DIRECT, 'GET', '/api/admin/groups')).items
  const gid = (n: string) => groups.find((g) => g.name === n)!.id
  const uid = (n: string) => users.find((u) => u.username === n)!.id
  expect(users.find((u) => u.username === 'alice')!.groupIds).toEqual([gid('marketing')])
  expect(users.find((u) => u.username === 'bob')!.groupIds).toEqual([gid('finance')])
  writeState({ owner: { ...st.owner, id: uid(st.owner.username) }, alice: { ...st.alice, id: uid('alice') }, bob: { ...st.bob, id: uid('bob') } })

  // folder rules: shared/ written by everyone (saved again through the editor, with the "who sees what" preview),
  // groups/finance only for finance (created with the group), users/<id> personal (built in, no rules allowed)
  await page.goto(`${DIRECT}/admin/folders`)
  const list = page.getByTestId('folder-list')
  const row = (p: string) => list.locator('li').filter({ has: page.getByText(p, { exact: true }) }).first()
  await expect(list).toContainText('shared')
  await expect(list).toContainText('groups/finance')
  await row('shared').getByRole('button', { name: '수정' }).click()
  const ed = page.getByRole('dialog')
  await expect(ed.getByLabel('대상').first()).toHaveValue('everyone')
  await expect(ed.getByLabel('권한').first()).toHaveValue('write')
  await page.getByTestId('rules-preview').click()
  await expect(page.getByTestId('rules-preview-result')).toBeVisible()
  await page.getByTestId('rules-save').click()
  await expect(row('shared')).toContainText('모두: 읽기·쓰기')
  await expect(row('groups/finance')).toContainText('finance 그룹: 읽기·쓰기')
  await expect(row('groups/finance')).not.toContainText('모두')

  // "who sees what" for a proposed change: giving marketing read on groups/finance would let Alice in
  await row('groups/finance').getByRole('button', { name: '수정' }).click()
  await page.getByTestId('rule-add').click()
  await page.getByRole('dialog').getByLabel('누구').last().selectOption({ label: 'marketing' })
  await page.getByTestId('rules-preview').click()
  await expect(page.getByTestId('rules-preview-result')).toContainText(st.alice.name)
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(row('groups/finance')).not.toContainText('marketing')

  // personal folders cannot carry rules
  const bad = await page.request.post(`${DIRECT}/api/admin/folders`, { headers: { 'x-mycel-csrf': '1', origin: DIRECT }, data: { path: `users/${uid('alice')}`, rules: [] } })
  expect(bad.status()).toBe(400)

  expect(realErrors(errors)).toEqual([])
  await ctx.close()
})

test('step 1b: what each member sees in Files', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  await page.goto(`${RELAYED}/files`)
  const table = page.getByTestId('file-table')
  await expect(table).toContainText('shared')
  await expect(table).toContainText('groups')
  await page.goto(`${RELAYED}/files?path=groups`)
  await expect(page.getByTestId('file-table')).toContainText('marketing')
  await expect(page.getByTestId('file-table')).not.toContainText('finance')
  await page.goto(`${RELAYED}/files?path=users`)
  await expect(page.getByTestId('file-table')).toContainText(st.alice.id!)
  await expect(page.getByTestId('file-table')).not.toContainText(st.bob.id!)
  await ctx.close()
})

async function upload(page: Page, base: string, folder: string, files: string[]) {
  await page.goto(`${base}/files?path=${encodeURIComponent(folder)}`)
  await expect(page.getByTestId('upload-button')).toBeEnabled()
  await page.getByTestId('files-input').setInputFiles(files)
  for (const f of files) await expect(page.getByTestId('file-table')).toContainText(path.basename(f), { timeout: 60_000 })
}

test('step 2: owner uploads docx, xlsx, pdf, md and an image; previews render in the side panel', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, DIRECT, st.owner)
  const errors = watch(page)
  await upload(page, DIRECT, 'shared', [fx.docx, fx.xlsx, fx.pdf, fx.md, fx.png, fx.notes])
  await upload(page, DIRECT, 'groups/finance', [fx.financeCsv])

  await page.goto(`${DIRECT}/files?path=shared`)
  const open = async (name: string) => {
    await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button', { name }).first().click()
    const panel = page.getByTestId('file-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(name)
    return panel
  }
  let panel = await open('brief.docx')
  await expect(panel.locator('.docx-host')).toContainText('Quarterly brief', { timeout: 30_000 })
  panel = await open('leads.xlsx')
  await expect(panel.locator('table')).toContainText('September')
  panel = await open('policy.pdf')
  await expect(panel.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(panel).toContainText('Hotels up to 150 USD', { timeout: 30_000 })
  panel = await open('launch-plan.md')
  await expect(panel.getByRole('heading', { name: 'Launch plan' })).toBeVisible()
  await expect(panel.locator('strong')).toHaveText(LAUNCH_FACT.code)
  panel = await open('diagram.png')
  const img = panel.getByRole('img', { name: 'diagram.png' })
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(160)

  // the finance file is there for the owner
  await page.goto(`${DIRECT}/files?path=groups/finance`)
  await expect(page.getByTestId('file-table')).toContainText('budget-2027.csv')
  expect(realErrors(errors)).toEqual([])
  expect(fs.existsSync(fx.financeCsv)).toBe(true)
  expect(FINANCE_CANARY).toBeTruthy()
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 3 (alice)

test('step 3a: alice (through the relay) asks Claude to find and summarise a file in shared/: streaming, steps, markdown, math, mermaid', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  const errors = watch(page)
  const ws = recordWs(page)
  const chatId = await newChat(
    page,
    RELAYED,
    'In the shared/ folder, find the file about the next product launch and summarise it in three short bullet points (project name, launch date, budget). ' +
      'After the bullets add (a) the budget split as one LaTeX display formula between $$ and $$, using \\times, and (b) a small flowchart of the launch steps in a ```mermaid code block with flowchart LR.',
  )
  writeState({ aliceChat: chatId })
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'streaming', { timeout: 30_000 })
  expect(await waitAnswer(page, null)).toBe('done')
  const id = await lastAssistantId(page.request, RELAYED, chatId)

  // streamed: several deltas, contiguous offsets, and their concatenation is exactly what the server saved
  const deltas = deltasOf(ws, id)
  expect(deltas.length).toBeGreaterThan(1)
  let off = 0
  for (const d of deltas) {
    expect(d.data.offset).toBe(off)
    off += d.data.text.length
  }
  const saved = (await serverMessages(page.request, RELAYED, chatId)).find((m) => m.id === id)!
  expect(deltas.map((d) => d.data.text).join('')).toBe(saved.content)

  // the AI searched the team folder (steps) and found the fact only launch-plan.md has
  await expect(a.getByTestId('steps')).toBeVisible()
  await expect(a).toContainText('Kestrel')
  await expect(a).toContainText(/2026-11-18|November 18|18 November|11월 18일/)
  // markdown extras rendered: list, KaTeX, Mermaid SVG
  await expect(a.locator('li').first()).toBeVisible()
  await expect(a.locator('.katex').first()).toBeVisible()
  await expect(a.getByRole('img', { name: '다이어그램' }).locator('svg')).toBeVisible({ timeout: 30_000 })
  expect(realErrors(errors)).toEqual([])
  await ctx.close()
})

test('step 3b: Claude writes a docx report into alice\'s folder (make_file) and an HTML artifact; the panels render them', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  const errors = watch(page)
  await page.goto(`${RELAYED}/c/${st.aliceChat}`)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  // (a rerun of this step against the same product finds the answer of the previous run: no second engine call)
  await expect(page.getByTestId('assistant-message').first()).toBeVisible()
  if (!(await page.getByTestId('artifact-card').count())) {
    const prev = await send(
      page,
      `Now do two things. 1) With the make_file tool, create a Word document users/${st.alice.id}/kestrel-report.docx titled "Kestrel launch report" with the three facts. ` +
        '2) Create an HTML artifact titled "Kestrel countdown": a page with the heading "Kestrel countdown" and the launch date in big text. Keep both short.',
    )
    expect(await waitAnswer(page, prev)).toBe('done')
  }
  const a = page.getByTestId('assistant-message').filter({ has: page.getByTestId('artifact-card') }).last()
  const summary = a.getByTestId('file-summary')
  await expect(summary).toContainText('파일 1개 저장')
  await summary.getByRole('button').first().click()
  await summary.getByRole('button', { name: `users/${st.alice.id}/kestrel-report.docx` }).click()
  const panel = page.getByTestId('file-panel')
  await expect(panel.locator('.docx-host')).toContainText('Kestrel', { timeout: 30_000 })

  const card = a.getByTestId('artifact-card')
  await expect(card).toHaveAttribute('data-state', 'done')
  await card.click()
  const art = page.getByTestId('artifact-panel')
  await expect(art).toBeVisible()
  const frame = page.frameLocator('[data-testid="artifact-panel"] [data-testid="sandbox-frame"]').first()
  await expect(frame.getByRole('heading', { name: /Kestrel countdown/i })).toBeVisible({ timeout: 30_000 })

  // the file is in her folder on the Files screen
  await page.goto(`${RELAYED}/files?path=users/${st.alice.id}`)
  await expect(page.getByTestId('file-table')).toContainText('kestrel-report.docx')
  expect(realErrors(errors)).toEqual([])
  await ctx.close()
})

test('step 3c: alice asks for groups/finance: the AI cannot read it, the audit shows the refusal', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  let chatId = st.aliceChat2 as string | undefined
  if (chatId) {
    // rerun against the same product: the answer of the previous run is checked again
    await page.goto(`${RELAYED}/c/${chatId}`)
  } else {
    chatId = await newChat(page, RELAYED, 'Read the file groups/finance/budget-2027.csv and tell me the secret code written in it. If you cannot read it, say so in one sentence.')
    writeState({ aliceChat2: chatId })
  }
  expect(await waitAnswer(page, null)).toBe('done')
  const a = lastAnswer(page)
  await expect(a).not.toContainText(FINANCE_CANARY)
  const saved = await serverMessages(page.request, RELAYED, chatId)
  expect(JSON.stringify(saved)).not.toContain(FINANCE_CANARY)
  await ctx.close()

  // the owner's audit screen lists alice's refused tool call(s) on groups/finance
  const o = await as(browser, DIRECT, st.owner)
  const audit = await api<{ items: { actor: { id: string } | null; action: string; detail: any; source: string }[] }>(o.page.request, DIRECT, 'GET', `/api/admin/audit?source=tool&actor=${st.alice.id}&limit=100`)
  const refused = audit.items.filter((e) => /groups\/finance|finance/.test(JSON.stringify(e.detail)) && (e.detail?.ok === 0 || e.detail?.ok === false || /denied|skipped|not found|no access/i.test(JSON.stringify(e.detail))))
  expect(refused.length, JSON.stringify(audit.items.slice(0, 10))).toBeGreaterThan(0)
  await o.page.goto(`${DIRECT}/admin/audit`)
  const entry = o.page.getByTestId('audit-list').locator('li').filter({ hasText: 'groups/finance' }).filter({ hasText: '거부됨' }).first()
  await expect(entry).toContainText(st.alice.name)
  await expect(entry).toContainText('-> denied')
  await o.ctx.close()
})

test('step 3d: edit the last message (new branch), then regenerate the answer', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  await page.goto(`${RELAYED}/c/${st.aliceChat2}`)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  const um = page.getByTestId('user-message').last()
  const twoOfTwo = /^2\s*\/\s*2$/
  // (a rerun against the same product finds the branches of the previous run)
  if (!(await um.getByTestId('branch-label').count())) {
    await um.hover()
    await um.getByRole('button', { name: '메시지 수정' }).click()
    const prev = await lastAnswerId(page)
    countEngineCall('claude')
    await um.getByRole('textbox', { name: '메시지 수정' }).fill('Reply with exactly one word: pineapple')
    await page.getByTestId('edit-send').click()
    expect(await waitAnswer(page, prev)).toBe('done')
  }
  await expect(lastAnswer(page)).toContainText(/pineapple/i)
  await expect(um.getByTestId('branch-label')).toHaveText(twoOfTwo)
  // the first version is still there, and switching back and forth works
  await um.hover()
  await um.getByRole('button', { name: '이전 버전' }).click()
  await expect(page.getByTestId('user-text').last()).toContainText('budget-2027.csv')
  await expect(lastAnswer(page)).not.toContainText(/pineapple/i)
  await page.getByTestId('user-message').last().hover()
  await page.getByTestId('user-message').last().getByRole('button', { name: '다음 버전' }).click()
  await expect(page.getByTestId('user-text').last()).toContainText('pineapple')

  // regenerate: a sibling answer to the same message
  if (!(await lastAnswer(page).getByTestId('branch-label').count())) {
    const prev = await lastAnswerId(page)
    countEngineCall('claude')
    await lastAnswer(page).hover()
    await lastAnswer(page).getByTestId('regenerate').click()
    expect(await waitAnswer(page, prev)).toBe('done')
  }
  await expect(lastAnswer(page)).toContainText(/pineapple/i)
  await expect(lastAnswer(page).getByTestId('branch-label')).toHaveText(twoOfTwo)
  await ctx.close()
})

test('step 3e: stop a running answer', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  const chatId = await newChat(page, RELAYED, 'Write a long, detailed essay (at least 1500 words, no tools) about the history of the printing press.')
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'streaming')
  // wait for some text, then stop
  await expect.poll(async () => ((await a.textContent()) ?? '').length, { timeout: 120_000 }).toBeGreaterThan(200)
  await page.getByTestId('stop').click()
  expect(await waitAnswer(page, null, 30_000)).toBe('stopped')
  await expect(a).toContainText('중지됨')
  const saved = (await serverMessages(page.request, RELAYED, chatId)).at(-1)!
  expect(saved.status).toBe('stopped')
  // the composer is usable again
  await expect(page.getByTestId('send')).toBeVisible()
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 4 (bob, Codex)

test('step 4: bob chats with Codex (one short turn)', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, DIRECT, st.bob)
  let chatId = st.bobChat as string | undefined
  if (chatId) await page.goto(`${DIRECT}/c/${chatId}`)
  else {
    chatId = await newChat(page, DIRECT, 'What is 6 times 7? Answer with just the number.', 'Codex')
    writeState({ bobChat: chatId })
  }
  expect(await waitAnswer(page, null, 180_000)).toBe('done')
  await expect(lastAnswer(page)).toContainText('42')
  const chat = await api<{ engine: string | null }>(page.request, DIRECT, 'GET', `/api/chats/${chatId}`)
  expect(chat.engine).toBe('codex')
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 5 (conflicts)

const NOTES = 'shared/team-notes.md'

/** Open a text file in the side panel's editor (Files screen). */
async function openEditor(page: Page, base: string, path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  await page.goto(`${base}/files?path=${encodeURIComponent(path.slice(0, path.lastIndexOf('/')))}`)
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button', { name, exact: true }).click()
  const panel = page.getByTestId('file-panel')
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(name)
  await panel.getByTestId('file-edit').click()
  await expect(panel.getByTestId('file-editor')).toBeVisible()
  return panel
}

const conflictRows = (page: Page) => page.getByTestId('file-row').filter({ hasText: 'team-notes (충돌 사본' })

test('step 5a: two people edit the same shared file at once: the later save becomes a conflict copy in Files', async ({ browser }) => {
  const st = readState()
  const o = await as(browser, DIRECT, st.owner)
  const a = await as(browser, RELAYED, st.alice)
  const before = await conflictRows(o.page).count()
  const op = await openEditor(o.page, DIRECT, NOTES)
  const ap = await openEditor(a.page, RELAYED, NOTES)
  const oText = await op.getByTestId('file-editor').inputValue()
  expect(oText).toContain('Status: draft')
  await ap.getByTestId('file-editor').fill(oText.replace('Status: draft', 'Status: in review'))
  await ap.getByTestId('file-save').click()
  await expect(a.page.getByText('저장했어요.')).toBeVisible()

  await op.getByTestId('file-editor').fill(oText.replace('Next meeting: Monday', 'Next meeting: Tuesday'))
  await op.getByTestId('file-save').click()
  await expect(o.page.getByText(/충돌 사본\(shared\/team-notes \(충돌 사본 - Olga/)).toBeVisible()
  await expect(op).toContainText('Next meeting: Tuesday')

  // both see the copy in Files (live update for alice: files.changed), the original kept alice's version
  await expect(conflictRows(o.page)).toHaveCount(before + 1)
  await a.page.goto(`${RELAYED}/files?path=shared`)
  await expect(conflictRows(a.page).first()).toContainText('충돌 사본')
  const orig = await api<{ content: string }>(a.page.request, RELAYED, 'GET', `/api/files/content?path=${encodeURIComponent(NOTES)}`)
  expect(orig.content).toContain('Status: in review')
  expect(orig.content).toContain('Next meeting: Monday')
  await o.ctx.close()
  await a.ctx.close()
})

test('step 5b: alice\'s AI edits the note it read while the owner saves it: the AI\'s version becomes a conflict copy', async ({ browser }) => {
  const st = readState()
  const o = await as(browser, DIRECT, st.owner)
  const a = await as(browser, RELAYED, st.alice)
  await a.page.goto(`${RELAYED}/files?path=shared`)
  const aiCopies = a.page.getByTestId('file-row').filter({ hasText: 'team-notes (충돌 사본 - Alice' })
  const copiesBefore = await aiCopies.count()
  const op = await openEditor(o.page, DIRECT, NOTES)
  const text = await op.getByTestId('file-editor').inputValue()
  const status = /Status: .*/.exec(text)![0]
  const wanted = `Status: reviewed by Alice ${new Date().toISOString().slice(11, 19)}`
  await op.getByTestId('file-editor').fill(text.replace(/Next meeting: \w+/, 'Next meeting: Wednesday'))

  const ws = recordWs(a.page)
  const chatId = await newChat(
    a.page,
    RELAYED,
    `Please do these steps in order, one tool call at a time. 1) Read ${NOTES}. 2) List the folder shared/. 3) Read shared/launch-plan.md. ` +
      `4) Then use the edit tool on ${NOTES} to replace the text "${status}" with "${wanted}". Finally tell me in one sentence what happened.`,
  )
  writeState({ aliceConflictChat: chatId })
  // as soon as the AI has read the note, the owner saves his change (the AI's read is now stale)
  await expect.poll(() => ws.events.some((e) => e.type === 'message.step' && e.data?.step?.status === 'ok' && /team-notes/.test(JSON.stringify(e.data.step))), { timeout: 120_000, intervals: [50] }).toBe(true)
  await op.getByTestId('file-save').click()
  await expect(o.page.getByText('저장했어요.')).toBeVisible()

  expect(await waitAnswer(a.page, null)).toBe('done')
  const summary = lastAnswer(a.page).getByTestId('file-summary')
  await expect(summary).toContainText('충돌 사본')
  // the summary under the answer links the copy: it has the AI's change on top of the owner's version
  await summary.getByRole('button').first().click()
  await summary.getByRole('button', { name: /team-notes \(충돌 사본 - Alice/ }).click()
  await expect(a.page.getByTestId('file-panel')).toContainText(wanted)
  await expect(a.page.getByTestId('file-panel')).toContainText('Next meeting: Wednesday')
  // the original kept the owner's save
  const notes = await api<{ content: string }>(a.page.request, RELAYED, 'GET', `/api/files/content?path=${encodeURIComponent(NOTES)}`)
  expect(notes.content).toContain('Next meeting: Wednesday')
  expect(notes.content).toContain(status)
  await a.page.goto(`${RELAYED}/files?path=shared`)
  await expect(aiCopies).toHaveCount(copiesBefore + 1)
  await o.ctx.close()
  await a.ctx.close()
})
