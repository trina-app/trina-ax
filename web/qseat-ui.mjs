import { chromium, devices } from '/Users/potenlab/.tfx/qseat/node_modules/.bun/node_modules/playwright/index.mjs'
const B = process.env.QB ?? 'http://127.0.0.1:19431', PW = 'Qseat-throwaway-9271', SH = process.env.HOME + '/.tfx/manager/shots/qseat-'
const [, , user, path, shot, size = '1440', ...acts] = process.argv
const browser = await chromium.launch()
const ctx = await browser.newContext(size === '390' ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
if (user !== '-') {
  const r = await page.request.post(B + '/api/auth/login', { headers: { 'x-mycel-csrf': '1', origin: B }, data: { username: user, password: PW } })
  if (r.status() !== 200) console.log('login', r.status(), await r.text())
}
await page.goto(B + path); await page.waitForLoadState('networkidle'); await page.waitForTimeout(800)
for (const a of acts) {
  const [kind, arg, arg2] = a.split('::')
  try {
    if (kind === 'click') await page.getByText(arg, { exact: arg2 === 'exact' }).first().click({ timeout: 5000 })
    if (kind === 'role') await page.getByRole('button', { name: arg, exact: arg2 === 'exact' }).first().click({ timeout: 5000 })
    if (kind === 'loc') await page.locator(arg).first().click({ timeout: 5000 })
    if (kind === 'mi') await page.getByRole('menuitem', { name: arg }).first().click({ timeout: 5000 })
    if (kind === 'tid') await page.getByTestId(arg).first().click({ timeout: 5000 })
    if (kind === 'fill') await page.getByLabel(arg).first().fill(arg2, { timeout: 5000 })
    if (kind === 'fillsel') await page.locator(arg).first().fill(arg2, { timeout: 5000 })
    if (kind === 'wait') await page.waitForTimeout(Number(arg))
    if (kind === 'goto') { await page.goto(B + arg); await page.waitForLoadState('networkidle') }
  } catch (e) { console.log('ACT FAIL', a, String(e).split('\n')[0]) }
  await page.waitForTimeout(700)
}
await page.screenshot({ path: SH + shot + '.png', fullPage: false })
const txt = await page.evaluate(() => document.body.innerText)
console.log(txt.replace(/\n+/g, ' | ').slice(0, Number(process.env.N ?? 2500)))
await browser.close()
