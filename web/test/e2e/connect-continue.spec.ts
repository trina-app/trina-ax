// Connect from the chat card, and the same answer goes on (owner decision 2026-11-12, QA TC-128): the person asks for
// something a service they have not connected would answer, the AI's answer shows the connect card, the person connects
// it on the card, and the SAME answer goes on with the new connection's tool: no second question, no second answer.
// "Not now" ends the answer without it. The mock plays the server's side (test/mock/server.ts "connectcontinue").
import path from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const isConnect = (r: Request) => r.method() === 'POST' && /^\/api\/turns\/[^/]+\/connect$/.test(new URL(r.url()).pathname)
const isSend = (r: Request) => r.method() === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname)

test('connected on the card: the same answer goes on with the new tool, nothing is sent again', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const sends: string[] = []
  page.on('request', (r) => { if (isSend(r)) sends.push(r.url()) })
  await ask(page, 'connectcontinue 출시 페이지 요약해 줘')
  const card = page.getByTestId('connect-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('connect-title')).toContainText('Notion')
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toContainText('Notion이 아직 연결되지 않았어요')
  await shot(page, 'connect-continue-1-card.png')
  const connected = page.waitForRequest(isConnect)
  await page.getByTestId('connect-submit').click()
  expect((await connected).postDataJSON()).toMatchObject({ action: 'connect', requestId: 'cc-notion' })
  // the card closes and the same answer goes on: the new tool's step and the summary, under the first words
  await expect(card).toHaveCount(0)
  await expect(answer).toContainText('「출시 계획」 페이지 요약이에요')
  await expect(answer).toContainText('Notion이 아직 연결되지 않았어요')
  await expect(page.getByTestId('assistant-message')).toHaveCount(1)
  await expect(page.getByTestId('user-message')).toHaveCount(1)
  expect(sends).toHaveLength(1)
  await shot(page, 'connect-continue-2-went-on.png')
  expect(realErrors(errors)).toEqual([])
})

test('"not now" on the card: the answer ends without the service', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'connectcontinue 출시 페이지 요약해 줘')
  const card = page.getByTestId('connect-card')
  await expect(card).toBeVisible()
  const skipped = page.waitForRequest(isConnect)
  await page.getByTestId('connect-skip').click()
  expect((await skipped).postDataJSON()).toMatchObject({ action: 'skip', requestId: 'cc-notion' })
  await expect(card).toHaveCount(0)
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toContainText('Notion을 연결하지 않아서 페이지를 읽지 못했어요.')
  await expect(answer).not.toContainText('페이지 요약이에요')
  await expect(page.getByTestId('assistant-message')).toHaveCount(1)
  expect(realErrors(errors)).toEqual([])
})
