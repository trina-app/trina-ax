import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { reset, signIn } from './helpers'

const groups = ['user', 'group', 'engine', 'model', 'day', 'credential', 'skill'] as const
const tokens = [133879, 40198, 34524]
const tokenSum = tokens.reduce((sum, n) => sum + n, 0)

async function barWidths(page: Page) {
  return page.getByTestId('usage-table').locator('tbody td[aria-hidden] [style]').evaluateAll((bars) =>
    bars.map((bar) => Number.parseFloat((bar as HTMLElement).style.width)))
}

test('all groupings show shares of displayed row tokens and preserve report totals and CSV values', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.route('**/api/admin/usage?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const group = query.get('groupBy')!
    const rows = tokens.map((n, i) => ({ key: `${group}-${i}`, label: i === 0 ? '=1+1' : `${group} ${i}`, turns: 1, inputTokens: n - 100, outputTokens: 100, costUsd: i * 0.125, unpricedTurns: i === 0 ? 1 : 0 }))
    // Overlapping skill/group rows and partial credential coverage must not change the unique team total.
    const total = group === 'skill' || group === 'group' ? tokens[0]! : group === 'credential' ? tokenSum + 1000 : tokenSum
    await route.fulfill({ json: { from: query.get('from'), to: query.get('to'), rows, totals: { turns: 3, inputTokens: total - 300, outputTokens: 300, costUsd: 0.375, unpricedTurns: 1 } } })
  })
  await page.goto('/admin/usage')
  for (const group of groups) {
    await page.locator('select').selectOption(group)
    const table = page.getByTestId('usage-table')
    await expect(table).toContainText(`${group} 1`)
    await expect(page.getByTestId('usage-unpriced')).toHaveCount(1)
    await expect(page.getByTestId('usage-unpriced-note')).toBeVisible()
    const widths = await barWidths(page)
    expect(widths).toHaveLength(3)
    widths.forEach((width, i) => expect(width).toBeCloseTo(tokens[i]! / tokenSum * 100, 3))
    expect(widths.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 3)
    const total = group === 'skill' || group === 'group' ? tokens[0]! : group === 'credential' ? tokenSum + 1000 : tokenSum
    await expect(table.locator('tfoot td').nth(2)).toHaveText(total.toLocaleString('ko'))
    if (group === 'skill') await expect(page.getByTestId('usage-skill-note')).toContainText('중복')
    else await expect(page.getByTestId('usage-skill-note')).toHaveCount(0)
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
    const csv = await fs.readFile((await download.path())!, 'utf8')
    const dates = await page.locator('input[type="date"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    const range = await page.evaluate(([from, to]) => {
      const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate() + 1)
      return [new Date(`${from}T00:00:00`).toISOString(), end.toISOString()]
    }, dates)
    expect(csv).toBe('\uFEFFgroup_by,from,to,key,label,turns,input_tokens,output_tokens,cost_usd,attribution\r\n' +
      tokens.map((n, i) => `${group},${range[0]},${range[1]},${group}-${i},${i === 0 ? "'=1+1" : `${group} ${i}`},1,${n - 100},100,${i * 0.125},${group === 'skill' ? 'whole turn; skill rows may overlap' : 'turn totals'}\r\n`).join(''))
  }
})

test('zero usage produces finite zero-width bars and an empty range remains exportable', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.route('**/api/admin/usage?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    await route.fulfill({ json: { from: query.get('from'), to: query.get('to'), totals,
      rows: query.get('groupBy') === 'day' ? [] : [{ key: 'zero', label: 'Zero usage', ...totals }] } })
  })
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Zero usage')
  expect(await barWidths(page)).toEqual([0])
  await page.locator('select').selectOption('day')
  await expect(page.getByTestId('usage-table')).toHaveCount(0)
  await expect(page.getByTestId('usage-csv')).toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
  expect(await fs.readFile((await download.path())!, 'utf8')).toBe('\uFEFFgroup_by,from,to,key,label,turns,input_tokens,output_tokens,cost_usd,attribution\r\n')
})

for (const [locale, phrases] of [
  ['en', ['API key amounts use provider-reported costs when available, otherwise list-price estimates.', 'Managed subscription connections show 0', 'Development local-login may show an engine-reported estimate, even with a subscription.', 'not bills or subscription fees', 'Rows may overlap.']],
  ['ko', ['API 키 연결 금액은 제공자가 보고한 비용을 우선 쓰고, 없으면 정가로 추정해요.', '관리형 구독 연결은 요청 단가가 없어 금액이 0', '개발용 로컬 로그인(local-login)은 구독이어도 엔진이 보고한 추정 비용이 표시될 수 있어요.', '실제 청구액이나 구독료가 아니에요', '중복']],
  ['id', ['Jumlah untuk kunci API memakai biaya yang dilaporkan penyedia jika tersedia, atau perkiraan berdasarkan harga daftar.', 'Koneksi langganan terkelola menampilkan 0', 'Login lokal untuk pengembangan (local-login) dapat menampilkan perkiraan dari mesin, meskipun memakai langganan.', 'bukan tagihan atau biaya langganan', 'Penggunaan dapat terhitung di beberapa baris.']],
] as const) {
  test(`cost explanation covers managed zero, API and local-login estimates in ${locale}`, async ({ page }, testInfo) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await page.route('**/api/admin/usage?**', async (route) => {
      const query = new URL(route.request().url()).searchParams
      await route.fulfill({ json: { from: query.get('from'), to: query.get('to'),
        rows: [
          { key: 'managed', label: 'Managed subscription', turns: 1, inputTokens: 100, outputTokens: 20, costUsd: 0 },
          { key: 'api', label: 'API key', turns: 1, inputTokens: 200, outputTokens: 30, costUsd: 0.125 },
          { key: 'dev', label: 'Development local-login', turns: 1, inputTokens: 300, outputTokens: 40, costUsd: 0.5142 },
        ], totals: { turns: 3, inputTokens: 600, outputTokens: 90, costUsd: 0.6392 } } })
    })
    await page.goto('/admin/usage')
    await expect(page.getByTestId('usage-table')).toContainText('Development local-login')
    for (const phrase of phrases.slice(0, 4)) await expect(page.getByText(phrase, { exact: false })).toBeVisible()
    for (const [i, cost] of [0, 0.125, 0.5142].entries()) {
      await expect(page.getByTestId('usage-table').locator('tbody tr').nth(i).locator('td').last()).toHaveText(
        new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(cost))
    }
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
    const csv = await fs.readFile((await download.path())!, 'utf8')
    expect(csv).toContain(',managed,Managed subscription,1,100,20,0,turn totals\r\n')
    expect(csv).toContain(',api,API key,1,200,30,0.125,turn totals\r\n')
    expect(csv).toContain(',dev,Development local-login,1,300,40,0.5142,turn totals\r\n')
    await page.locator('select').selectOption('skill')
    await expect(page.getByTestId('usage-skill-note')).toContainText(phrases[4])
    await expect(page.getByTestId('usage-table')).toBeVisible()
    const screenshot = testInfo.outputPath(`usage-${locale}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach(`usage-${locale}`, { path: screenshot, contentType: 'image/png' })
  })
}

test('administrator exports the selected person, model and skill report as CSV with matching dates', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  for (const [group, label] of [['user', 'Olga'], ['model', 'model-test'], ['skill', '주간 보고서']]) {
    await page.locator('select').selectOption(group!)
    await expect(page.getByTestId('usage-table')).toContainText(label!)
    if (group === 'skill') await expect(page.getByTestId('usage-skill-note')).toContainText('중복')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
    expect(download.suggestedFilename()).toMatch(new RegExp(`^usage-${group}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.csv$`))
    const content = await fs.readFile((await download.path())!, 'utf8')
    expect(content).toContain(label!)
    expect(content.startsWith('\uFEFFgroup_by,from,to,key,label')).toBe(true)
    expect(content).toContain(`\r\n${group},`)
    if (group === 'skill') expect(content).toContain('whole turn; skill rows may overlap')
  }
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-10-01')
  // Pick a different end date even when the test runs on the original fixture date.
  const selectedTo = (await dates.nth(1).inputValue()) === '2026-10-26' ? '2026-10-25' : '2026-10-26'
  const expectedFrom = await page.evaluate(() => new Date('2026-10-01T00:00:00').toISOString())
  const expectedTo = await page.evaluate((date) => { const end = new Date(`${date}T00:00:00`); end.setDate(end.getDate() + 1); return end.toISOString() }, selectedTo)
  const report = page.waitForResponse((r) => r.url().includes('/api/admin/usage?') && new URL(r.url()).searchParams.get('to') === expectedTo)
  await dates.nth(1).fill(selectedTo)
  // Date changes update immediately; use the final API request as evidence that CSV uses this same selection.
  await report
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
  expect(download.suggestedFilename()).toBe(`usage-skill-2026-10-01-${selectedTo}.csv`)
  const content = await fs.readFile((await download.path())!, 'utf8')
  expect(content).toContain(expectedFrom)
  expect(content).toContain(expectedTo)
})

test('CSV never labels a stale response as a newly selected report', async ({ page }) => {
  await reset(page); await signIn(page); await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/admin/usage?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('groupBy') === 'model') await delayed
    await route.continue()
  })
  await page.locator('select').selectOption('model')
  await expect(page.getByTestId('usage-csv')).toBeDisabled()
  await page.locator('select').selectOption('skill')
  await expect(page.getByTestId('usage-table')).toContainText('주간 보고서')
  const oldResponse = page.waitForResponse((r) => new URL(r.url()).searchParams.get('groupBy') === 'model')
  release(); await oldResponse
  await expect(page.getByTestId('usage-table')).toContainText('주간 보고서')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
  expect(await fs.readFile((await download.path())!, 'utf8')).toContain('skills/report.md')
})
