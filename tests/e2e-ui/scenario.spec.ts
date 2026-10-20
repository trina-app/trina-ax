// The integrated product, end to end, in a real browser. Steps share the team they build (state.json), run in
// order, and each signs in afresh, so one step can be rerun on its own against a running product (E2E_REUSE=1).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { countEngineCall, DIRECT, killRelay, readState, relayPid, RELAYED, rssMb, serverPid, until, WORK, writeState, type Account } from './lib/dev'
import { FINANCE_CANARY, LAUNCH_FACT, makeBigFile, makeFixtures, sha256File, type Fixtures } from './lib/fixtures'
import { closeDesktop, desktopView, launchDesktop } from './lib/desktop'
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

test('step 3d: edit the last message (new branch), regenerate the answer and stop the regenerated one', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  await page.goto(`${RELAYED}/c/${st.aliceChat2}`)
  await expect(lastAnswer(page)).not.toHaveAttribute('data-status', 'streaming')
  const um = page.getByTestId('user-message').last()
  const twoOfTwo = /^2\s*\/\s*2$/
  const N = 150
  const items = (s: string | null) => [...(s ?? '').matchAll(/Item (\d+)\b/g)].map((m) => Number(m[1]))
  // (a rerun against the same product finds the branches of the previous run)
  if (!(await um.getByTestId('branch-label').count())) {
    await um.hover()
    await um.getByRole('button', { name: '메시지 수정' }).click()
    const prev = await lastAnswerId(page)
    countEngineCall('claude')
    await um.getByRole('textbox', { name: '메시지 수정' }).fill(`Without using any tools, write the lines "Item 1", "Item 2", ... up to "Item ${N}", one per line, nothing else.`)
    await page.getByTestId('edit-send').click()
    expect(await waitAnswer(page, prev)).toBe('done')
  }
  await expect(um.getByTestId('branch-label')).toHaveText(twoOfTwo)
  // the first version of the question is still there, and switching back and forth works
  await um.hover()
  await um.getByRole('button', { name: '이전 버전' }).click()
  await expect(page.getByTestId('user-text').last()).toContainText('budget-2027.csv')
  await expect(lastAnswer(page)).not.toContainText('Item 1')
  await page.getByTestId('user-message').last().hover()
  await page.getByTestId('user-message').last().getByRole('button', { name: '다음 버전' }).click()
  await expect(page.getByTestId('user-text').last()).toContainText(`Item ${N}`)

  // regenerate: a sibling answer to the same message; stop it while it streams
  if (!(await lastAnswer(page).getByTestId('branch-label').count())) {
    await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    const prev = await lastAnswerId(page)
    countEngineCall('claude')
    await lastAnswer(page).hover()
    await lastAnswer(page).getByTestId('regenerate').click()
    await expect.poll(async () => (await lastAnswer(page).getAttribute('data-message-id')) !== prev, { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => items(await lastAnswer(page).innerText()).length, { timeout: 120_000, intervals: [100] }).toBeGreaterThanOrEqual(3)
    await page.getByTestId('stop').click()
    expect(await waitAnswer(page, prev, 30_000)).toBe('stopped')
  }
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'stopped')
  await expect(a).toContainText('중지됨')
  expect(items(await a.innerText()).length).toBeLessThan(N)
  await expect(a.getByTestId('branch-label')).toHaveText(twoOfTwo)
  // the composer is usable again, and the first answer (complete) is one click away
  await expect(page.getByTestId('send')).toBeVisible()
  await a.hover()
  await a.getByRole('button', { name: '이전 버전' }).click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  expect(items(await lastAnswer(page).innerText())).toEqual(Array.from({ length: N }, (_, i) => i + 1))
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

// ---------------------------------------------------------------------------------------------- step 6 (resume)

test('step 6: the relay dies mid-answer: the page shows "reconnecting", resumes, and the answer is complete without gaps or repeats', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, RELAYED, st.alice)
  const ws = recordWs(page)
  const N = 150
  const chatId = await newChat(page, RELAYED, `Without using any tools, write the lines "Line 1", "Line 2", ... up to "Line ${N}", one per line, nothing else.`)
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'streaming')
  await expect.poll(async () => /Line 2\d\b/.test((await a.textContent()) ?? ''), { timeout: 120_000, intervals: [100] }).toBe(true)
  const relayBefore = relayPid()
  killRelay()
  await expect(page.getByTestId('conn-banner')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('conn-banner')).toContainText('다시 연결하는 중')
  // dev.ts brings the relay back; the page reconnects by itself and the banner goes away
  await until(() => relayPid() && relayPid() !== relayBefore, 20_000, 'the relay to restart')
  await expect(page.getByTestId('conn-banner')).toBeHidden({ timeout: 60_000 })
  expect(await waitAnswer(page, null)).toBe('done')
  expect(ws.sockets).toBeGreaterThanOrEqual(2)
  const hello = ws.events.filter((e) => e.type === 'hello') as { type: string; resumed?: boolean }[]
  expect(hello.length).toBeGreaterThanOrEqual(2)
  // the same server run: the new socket resumed after the last event it had (no reset / reload)
  expect(hello.at(-1)!.resumed).toBe(true)

  const seq = (s: string) => [...s.matchAll(/Line (\d+)\b/g)].map((m) => Number(m[1]))
  const saved = (await serverMessages(page.request, RELAYED, chatId)).at(-1)!
  const expected = Array.from({ length: N }, (_, i) => i + 1)
  expect(seq(saved.content)).toEqual(expected)
  // what the page shows is exactly the saved answer: nothing lost, nothing twice
  expect(seq(await a.innerText())).toEqual(expected)
  // and after a reload too
  await page.reload()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  expect(seq(await lastAnswer(page).innerText())).toEqual(expected)
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 7 (big file)

test('step 7: a 200 MB file goes up in chunks through the relay and comes back identical; server and relay memory stay bounded', async ({ browser }) => {
  test.setTimeout(20 * 60_000)
  const st = readState()
  const big = makeBigFile(200)
  const { ctx, page } = await as(browser, RELAYED, st.owner)
  const name = path.basename(big.file)
  const sPid = serverPid()!
  const rPid = relayPid()!
  const base = { server: rssMb(sPid), relay: rssMb(rPid) }
  const peak = { ...base }
  const sampler = setInterval(() => {
    peak.server = Math.max(peak.server, rssMb(sPid) || 0)
    peak.relay = Math.max(peak.relay, rssMb(rPid) || 0)
  }, 250)
  try {
    // chunked upload sessions (8 MB pieces, sha256 checked by the server) from the Files screen
    const sessions: string[] = []
    page.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/upload-sessions\/[^/]+\/chunks\/\d+/.test(r.url())) sessions.push(r.url()) })
    // (a rerun replaces the copy of the previous run)
    for (const n of [name, name.replace('.bin', ' (2).bin')]) await api(page.request, RELAYED, 'DELETE', `/api/files?path=${encodeURIComponent(`shared/${n}`)}`).catch(() => {})
    await page.goto(`${RELAYED}/files?path=shared`)
    await expect(page.getByTestId('file-table')).not.toContainText(name)
    await page.getByTestId('files-input').setInputFiles(big.file)
    await expect(page.getByTestId('upload-list')).toBeVisible()
    await expect(page.getByTestId('file-table')).toContainText(name, { timeout: 15 * 60_000 })
    expect(new Set(sessions).size).toBe(25) // 200 MB / 8 MB

    // download it again through the relay (the page's own download link)
    const row = page.getByTestId('file-row').filter({ hasText: name })
    await row.hover()
    await row.getByTestId('file-menu').click()
    const dl = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByRole('menuitem', { name: '내려받기' }).click()
    const d = await dl
    const out = path.join(WORK, 'downloaded.bin')
    await d.saveAs(out)
    expect(fs.statSync(out).size).toBe(200 * 1024 * 1024)
    expect(sha256File(out)).toBe(big.sha256)
    fs.rmSync(out, { force: true })
  } finally {
    clearInterval(sampler)
  }
  console.log(`[step 7] rss MB at full speed: server ${base.server.toFixed(0)} -> peak ${peak.server.toFixed(0)}, relay ${base.relay.toFixed(0)} -> peak ${peak.relay.toFixed(0)}`)
  // at full speed the peak is mostly garbage not yet collected; neither process may come near holding the file
  expect(peak.server - base.server).toBeLessThan(200)
  expect(peak.relay - base.relay).toBeLessThan(200)

  // backpressure: a slow reader (about 8 MB/s) of the same download through the relay. Nothing may pile up in the
  // relay or the server while the reader lags behind (the 200 MB are there to be buffered if anything did).
  const cookie = (await ctx.cookies(RELAYED)).map((c) => `${c.name}=${c.value}`).join('; ')
  const slowBase = { server: rssMb(sPid), relay: rssMb(rPid) }
  const slowPeak = { ...slowBase }
  const res = await fetch(`${RELAYED}/api/files/download?path=${encodeURIComponent(`shared/${name}`)}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  let got = 0
  const t0 = Date.now()
  while (got < 48 * 1024 * 1024) {
    const { value, done } = await reader.read()
    if (done) break
    got += value.byteLength
    const ahead = got / (8 * 1024 * 1024) * 1000 - (Date.now() - t0)
    if (ahead > 0) await new Promise((r) => setTimeout(r, ahead))
    slowPeak.server = Math.max(slowPeak.server, rssMb(sPid))
    slowPeak.relay = Math.max(slowPeak.relay, rssMb(rPid))
  }
  await reader.cancel()
  console.log(`[step 7] rss MB with a slow reader: server ${slowBase.server.toFixed(0)} -> peak ${slowPeak.server.toFixed(0)}, relay ${slowBase.relay.toFixed(0)} -> peak ${slowPeak.relay.toFixed(0)}`)
  expect(slowPeak.server - slowBase.server).toBeLessThan(64)
  expect(slowPeak.relay - slowBase.relay).toBeLessThan(64)
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 8 (admin)

test('step 8: admin screens with real data: who sees what, engines, usage, audit, diagnostics', async ({ browser }) => {
  const st = readState()
  const { ctx, page } = await as(browser, DIRECT, st.owner)
  const errors = watch(page)

  // who sees what: proposing "everyone reads groups/finance" shows Alice gaining access; nothing is saved
  await page.goto(`${DIRECT}/admin/folders`)
  const fin = page.getByTestId('folder-list').locator('li').filter({ has: page.getByText('groups/finance', { exact: true }) })
  await fin.getByRole('button', { name: '수정' }).click()
  await page.getByTestId('rule-add').click()
  await page.getByRole('dialog').getByLabel('대상').last().selectOption('everyone')
  await page.getByTestId('rules-preview').click()
  const preview = page.getByTestId('rules-preview-result')
  await expect(preview).toContainText(st.alice.name)
  await expect(preview).toContainText('groups/finance')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(fin).not.toContainText('모두')

  // engines: both connected with the owner's own logins (DEV mode)
  await page.goto(`${DIRECT}/admin/engines`)
  await expect(page.getByTestId('engine-card')).toHaveCount(2)
  for (const card of await page.getByTestId('engine-card').all()) await expect(card).toContainText('연결됨')

  // usage: Alice used Claude, Bob used Codex
  await page.goto(`${DIRECT}/admin/usage`)
  const usage = page.getByTestId('usage-table')
  await expect(usage).toContainText(st.alice.name)
  await expect(usage).toContainText(st.bob.name)
  await page.getByLabel('묶는 기준').selectOption('engine')
  await expect(usage).toContainText(/claude/i)
  await expect(usage).toContainText(/codex/i)
  const byUser = await api<{ rows: { key: string; turns: number; inputTokens: number; outputTokens: number }[] }>(page.request, DIRECT, 'GET', '/api/admin/usage?groupBy=user')
  const aliceRow = byUser.rows.find((r) => r.key === st.alice.id)!
  expect(aliceRow.turns).toBeGreaterThanOrEqual(5)
  expect(aliceRow.inputTokens + aliceRow.outputTokens).toBeGreaterThan(0)

  // audit: Alice's tool calls (make_file, artifact) and file changes by the AI
  await page.goto(`${DIRECT}/admin/audit`)
  await page.getByLabel('종류').selectOption('tool')
  await page.getByLabel('누가').selectOption(st.alice.id!)
  const audit = page.getByTestId('audit-list')
  await expect(audit).toContainText('make_file')
  await expect(audit).toContainText('artifact')
  await page.getByLabel('종류').selectOption('file')
  // a file in someone's personal folder is listed without its name (admins do not see members' private files)
  await expect(audit).toContainText(`users/${st.alice.id}/…`)
  await expect(audit).not.toContainText('kestrel-report')
  await expect(audit).toContainText('shared/team-notes.md')

  // diagnostics and connection (owner only)
  await page.goto(`${DIRECT}/admin/system`)
  const diag = page.getByTestId('diagnostics')
  await expect(diag.locator('li').first()).toBeVisible()
  expect(await diag.locator('li').count()).toBeGreaterThanOrEqual(3)
  // DEV mode runs the engines as this Mac's user with its own logins: both must show as signed in
  await expect(diag.locator('li').filter({ hasText: 'Claude Code' })).toContainText('로그인됨')
  await expect(diag.locator('li').filter({ hasText: 'Codex' })).toContainText('로그인됨')
  await expect(diag.locator('li').filter({ hasText: '원격 접속' })).toContainText('http://demo.localhost:19161')
  const conn = page.locator('section').filter({ has: page.getByRole('heading', { name: '연결', exact: true }) })
  await expect(conn).toContainText('연결됨')
  await expect(conn).toContainText('http://demo.localhost:19161')
  expect(realErrors(errors)).toEqual([])
  await ctx.close()
})

// ---------------------------------------------------------------------------------------------- step 9 (desktop)

test('step 9: the desktop app on the team address: Alice signs in and Claude reads example.com in the Browser pane', async () => {
  const st = readState()
  const userData = fs.mkdtempSync(path.join(WORK, 'desktop-'))
  const app = await launchDesktop(userData)
  try {
    const w = await desktopView(app, (u) => u.endsWith('/welcome.html'))
    await w.getByRole('textbox', { name: '팀 주소' }).fill('demo.localhost:19161')
    await w.getByRole('button', { name: '연결' }).click()
    const page = await desktopView(app, (u) => u.startsWith(RELAYED))
    await page.getByTestId('login-username').fill(st.alice.username)
    await page.getByTestId('login-password').fill(st.alice.password)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })
    // the session is a desktop session (browser tools are only offered to those)
    const me = await page.evaluate(async () => (await fetch('/api/me')).json())
    expect(me.session.client).toBe('desktop')

    countEngineCall('claude')
    await page.getByTestId('composer-input').fill('Open https://example.com in the browser and tell me the exact title of the page. Do not use web search.')
    await page.getByTestId('send').click()
    // the chat header has the Browser pane button only inside the desktop app
    await expect(page.getByTestId('browser-toggle')).toBeVisible({ timeout: 30_000 })
    // the site question is asked by the desktop app's own pane toolbar (never by the web page)
    const pane = await desktopView(app, (u) => u.endsWith('/pane.html'), 120_000)
    const prompt = pane.getByTestId('permission-prompt').first()
    await expect(prompt).toBeVisible({ timeout: 120_000 })
    await expect(prompt).toHaveAttribute('data-scope', 'site')
    await prompt.getByRole('button', { name: '이번만 허용' }).click()
    const answer = page.getByTestId('assistant-message').last()
    await expect(answer).not.toHaveAttribute('data-status', 'streaming', { timeout: 240_000 })
    await expect(answer).toHaveAttribute('data-status', 'done')
    await expect(answer).toContainText('Example Domain')
    await expect(answer.getByTestId('steps')).toBeVisible()
    // the browser tab really is on example.com
    await desktopView(app, (u) => u.startsWith('https://example.com'), 10_000)
  } finally {
    await closeDesktop(app)
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
