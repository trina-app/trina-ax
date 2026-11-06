// The waiting state of a dev environment command in the chat (Steps.tsx QueueLine, Step.devEnvRun; server side:
// server/src/devenv/srt/queue.ts): "Waiting for the dev environment… #2 in line" with the live place from
// GET /api/dev-env/runs, a Cancel button that takes it out of the queue, the line goes when the command starts, and a
// command that waited too long says the dev environment is full. DEVQUEUE_SHOTS=<folder> also saves screenshots there.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const shot = async (page: Page, name: string) => {
  const dir = process.env.DEVQUEUE_SHOTS
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test('a waiting command shows its live place in line, then the line goes when it starts', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'Build the site, devqueue slow')
  const line = lastAnswer(page).getByTestId('devenv-queue')
  await expect(line).toHaveText(/Waiting for the dev environment… #2 in line/)
  await expect(line.getByTestId('devenv-queue-cancel')).toHaveText('Cancel')
  await shot(page, 'waiting-2-in-line')
  // the place comes from the poll of the person's runs
  await expect(line).toHaveText(/#1 in line/, { timeout: 10_000 })
  await shot(page, 'waiting-1-in-line')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await expect(page.getByTestId('devenv-queue')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Cancel takes the command out of the queue; the step says it was cancelled', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await ask(page, 'Build the site, devqueue slow')
  const a = lastAnswer(page)
  await expect(a.getByTestId('devenv-queue')).toBeVisible()
  const stop = page.waitForRequest((r) => /\/api\/dev-env\/runs\/[^/]+\/stop$/.test(r.url()) && r.method() === 'POST')
  await a.getByTestId('devenv-queue-cancel').click()
  await stop
  await expect(a).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await a.getByTestId('steps').getByRole('button').first().click()
  await expect(a.getByTestId('devenv-queue-cancelled')).toHaveText('Cancelled. It did not run.')
  await shot(page, 'cancelled')
})

test('a command that waited too long: "The dev environment is full. Try again later."', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await ask(page, 'Build the site, devqueuefull')
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await a.getByTestId('steps').getByRole('button').first().click()
  await expect(a.getByTestId('devenv-queue-full')).toHaveText('The dev environment is full. Try again later.')
  await shot(page, 'full')
})

test('a queued job keeps its place in line after the answer; Cancel takes it out', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await ask(page, 'Render the video, devqueuejob')
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'done')
  // the step list is folded, the waiting line is not
  const line = a.getByTestId('devenv-queue')
  await expect(line).toHaveText(/Waiting for the dev environment… #1 in line/)
  await shot(page, 'job-waiting-after-answer')
  await line.getByTestId('devenv-queue-cancel').click()
  await expect(a.getByTestId('devenv-queue')).toHaveCount(0)
})

test('Korean: the waiting line in the team language', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'devqueue slow')
  await expect(lastAnswer(page).getByTestId('devenv-queue')).toHaveText(/개발 환경을 기다리는 중… 대기 2번째/)
  await expect(lastAnswer(page).getByTestId('devenv-queue-cancel')).toHaveText('취소')
})
