// The welcome steps' invite (6/6): the ready-made message introduces the team (owner 2026-11-14). It greets from the
// owner, carries the team's line from "About the company" (the profile's one-line intro; none saved: no line), says
// what the AI is for in plain words, the skill the link opens, and the link alone on the last line. It is edited in
// place, and "메시지 복사" copies what is in the box; nothing is sent anywhere by itself. At 1440 and 390.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const SKILL = 'skills/work/humanizer/SKILL.md'
const PROFILE = { website: 'https://acme.example/', oneLine: '병원 마케팅 콘텐츠를 만드는 팀이에요', products: '', audience: '', tone: [], avoid: '', sources: [] }

async function call(page: Page, method: 'POST' | 'PATCH' | 'PUT', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}

/** The owner on the invite step: the team's start, a skill and a link that opens it; every step before put off. */
async function toInvite(page: Page, o: { profile: boolean }) {
  await reset(page)
  await signIn(page)
  const team = await call(page, 'POST', '/api/onboarding/welcome/team')
  await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  if (o.profile) await call(page, 'PUT', '/api/onboarding/profile', PROFILE)
  await call(page, 'POST', '/api/admin/team-link', { groupIds: [team.progress.teamGroup.id], expiresInDays: 14, skillPath: SKILL })
  for (const id of ['ai', 'profile', 'result', 'skills', 'files', 'tools']) await call(page, 'PATCH', '/api/onboarding/welcome', { step: { id, state: 'skipped' } })
  await page.goto('/welcome')
  await expect(page.getByTestId('invite-step')).toBeVisible()
}

for (const width of [1440, 390] as const) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })

    test('the message introduces the team; edited in place, 메시지 복사 copies the edit', async ({ page }) => {
      const errors = watchConsole(page)
      await toInvite(page, { profile: true })
      const box = page.getByTestId('team-link-message')
      await expect(box).toBeEditable()
      const message = await box.inputValue()
      const url = (await page.getByTestId('team-link-url').getAttribute('title')) ?? ''
      expect(url).toContain('/join#t=')
      const lines = message.split('\n')
      expect(lines[0]).toBe('안녕하세요, Olga입니다. 트리나에서 Acme에 초대할게요.')
      expect(lines[1]).toBe('우리 팀 소개: 병원 마케팅 콘텐츠를 만드는 팀이에요')
      expect(message).toContain("우리 팀용으로 '자연스러운 글' 스킬을 준비해 뒀어요.")
      expect(lines.at(-1)).toBe(url)
      // edited in place: the copy is what is in the box
      const edited = `민지님, 다음 주부터 같이 써요!\n${url}`
      await box.fill(edited)
      await page.getByTestId('team-link-copy-message').click()
      await expect(page.getByTestId('team-link-copy-message')).toContainText('복사됨')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(edited)
      // emptied: nothing to copy
      await box.fill('')
      await expect(page.getByTestId('team-link-copy-message')).toBeDisabled()
      expect(realErrors(errors)).toEqual([])
    })
  })
}

test('no team description: no "우리 팀 소개" line and no blank line', async ({ page }) => {
  const errors = watchConsole(page)
  await toInvite(page, { profile: false })
  const message = await page.getByTestId('team-link-message').inputValue()
  expect(message).not.toContain('우리 팀 소개')
  expect(message).not.toContain('\n\n')
  expect(message.split('\n')[1]).toBe('우리 팀은 트리나에서 일상 문서 작업을 AI에게 맡겨요.')
  expect(realErrors(errors)).toEqual([])
})
