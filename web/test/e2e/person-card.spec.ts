// A person's card in a room (components/PersonCard.tsx; docs/decisions/20261116-person-card.md): a click on someone's
// photo, their name, an @mention of them or their row in the member list opens a small card; "Message" opens the 1:1
// chat with them with the message box ready. Yourself: "Edit profile" instead. The AI, an app and someone the
// directory does not list (for a guest: anyone outside their places) have no card and no button. The keyboard opens
// and closes it; a phone gets a bottom sheet. The room is answered through page.route (rooms-mock.ts); the 1:1 chat
// here too.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { appMessage } from './room-apps-mock'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const DM_ID = '019a5f00-0000-7000-8000-00000000d001'
const olga = { id: 'olga', name: 'Olga' }
const bob = { id: 'bob', name: 'Bob' }
/** in the room, not in the directory (an account that is gone) */
const zed = { id: 'zed', name: 'Zed' }
const mid = (n: number) => `019a5f00-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const messages: MockMessage[] = [
  { id: mid(1), author: bob, body: 'The quote is ready.' },
  { id: mid(2), author: olga, body: 'Thanks @Bob, I will read it today.', mentions: ['bob'] },
  { id: mid(3), author: zed, body: 'Written before the account went away.' },
  { id: mid(4), author: olga, body: '', extra: appMessage({ id: 'app1', kind: 'github', name: 'GitHub' }, { title: 'A pull request was opened' }) },
]

/** The 1:1 chat `POST /api/rooms {kind: 'dm'}` answers with, and its own (empty) page; `asked`: who it was opened with. */
async function routeDm(page: Page, me: { id: string; name: string }, peer: { id: string; name: string }): Promise<string[]> {
  const asked: string[] = []
  const at = '2026-11-05T09:00:00.000Z'
  const dm = { id: DM_ID, kind: 'dm', name: null, canRename: false, managerId: null, groupId: null, memberCount: 2, peers: [peer], lastSeq: 0, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastMessage: null, muted: false, createdAt: at, activityAt: at }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  // (after routeRoom: this one answers first and hands the room's own requests on)
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (req.method() === 'POST' && path === '/api/rooms') {
      asked.push((req.postDataJSON() as { userId: string }).userId)
      return route.fulfill(json(dm, 201))
    }
    if (!path.startsWith(`/api/rooms/${DM_ID}`)) return route.fallback()
    if (path === `/api/rooms/${DM_ID}`) return route.fulfill(json(dm))
    if (path.endsWith('/messages')) return route.fulfill(json({ items: [], nextCursor: null }))
    if (path.endsWith('/members')) return route.fulfill(json({ items: [me, peer].map((user) => ({ user, joinedAt: at })) }))
    if (path.endsWith('/read')) return route.fulfill(json({ lastReadSeq: 0, unreadCount: 0, mentioned: false }))
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return asked
}

const run = (page: Page, name: string) => page.getByTestId('room-run').filter({ has: page.getByTestId('room-run-head').getByText(name, { exact: true }) }).first()
const card = (page: Page) => page.getByTestId('person-card')

async function openRoom(page: Page) {
  await reset(page)
  await routeRoom(page, { members: [bob, zed], messages })
  const asked = await routeDm(page, olga, bob)
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  return asked
}

test('a photo opens the card; Message opens the 1:1 chat with the message box ready', async ({ page }) => {
  const asked = await openRoom(page)
  const face = run(page, 'Bob').getByTestId('room-run-face')
  // no layout shift: the photo keeps its 32px box
  expect(await face.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([32, 32])
  await face.click()
  await expect(card(page)).toBeVisible()
  await expect(card(page).getByTestId('person-card-name')).toHaveText('Bob')
  await expect(card(page).getByTestId('person-card-profile')).toHaveCount(0)
  // by the photo: under it, their left edges in line
  const [f, c] = [await face.boundingBox(), await card(page).boundingBox()]
  expect(c!.y).toBeGreaterThanOrEqual(f!.y + f!.height)
  expect(Math.abs(c!.x - f!.x)).toBeLessThan(12)
  await card(page).getByTestId('person-card-message').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
  expect(asked).toEqual(['bob'])
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByTestId('room-input')).toBeFocused()
})

test('the name and an @mention open the same card; a click outside and a scroll close it', async ({ page }) => {
  await openRoom(page)
  await run(page, 'Bob').getByTestId('room-run-name').click()
  await expect(card(page).getByTestId('person-card-name')).toHaveText('Bob')
  await page.getByTestId('room-input').click()
  await expect(card(page)).toHaveCount(0)
  const mention = page.getByTestId('room-mention-person')
  await expect(mention).toHaveText('@Bob')
  await mention.click()
  await expect(card(page).getByTestId('person-card-name')).toHaveText('Bob')
  await expect(card(page).getByTestId('person-card-message')).toBeVisible()
  await page.getByTestId('room-messages').evaluate((el) => {
    let box: Element | null = el
    while (box && getComputedStyle(box).overflowY !== 'auto' && getComputedStyle(box).overflowY !== 'scroll') box = box.parentElement
    ;(box ?? el).dispatchEvent(new Event('scroll'))
  })
  await expect(card(page)).toHaveCount(0)
})

test('yourself: no Message, Edit profile opens the profile settings', async ({ page }) => {
  await openRoom(page)
  await run(page, 'Olga').getByTestId('room-run-face').click()
  await expect(card(page).getByTestId('person-card-name')).toHaveText('Olga')
  await expect(card(page).getByTestId('person-card-message')).toHaveCount(0)
  await card(page).getByTestId('person-card-profile').click()
  await expect(page).toHaveURL(/\/settings\/profile$/)
})

test('an app and someone the directory does not list: no button, no card', async ({ page }) => {
  await openRoom(page)
  const gone = run(page, 'Zed')
  await expect(gone).toBeVisible()
  await expect(gone.getByTestId('room-run-face')).toHaveCount(0)
  await expect(gone.getByTestId('room-run-name')).toHaveCount(0)
  const app = page.getByTestId('room-run').filter({ has: page.getByTestId('app-sender') })
  await expect(app).toBeVisible()
  await expect(app.getByTestId('room-run-face')).toHaveCount(0)
  await app.getByTestId('app-tile').click()
  await expect(card(page)).toHaveCount(0)
})

test('the keyboard: Enter and Space open, the keyboard is on Message, Esc closes and goes back', async ({ page }) => {
  const asked = await openRoom(page)
  const face = run(page, 'Bob').getByTestId('room-run-face')
  await face.focus()
  await page.keyboard.press('Enter')
  await expect(card(page).getByTestId('person-card-message')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await expect(face).toBeFocused()
  await page.keyboard.press('Space')
  await expect(card(page).getByTestId('person-card-message')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
  expect(asked).toEqual(['bob'])
})

test('the member list: a row opens the card, Message closes the list and opens the 1:1 chat', async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-title').click()
  const rows = page.getByTestId('room-members')
  await expect(rows).toBeVisible()
  // someone the directory does not list: a row that opens nothing
  await expect(rows.getByTestId('room-member').filter({ hasText: 'Zed' }).getByTestId('room-member-person')).toHaveCount(0)
  const row = rows.getByTestId('room-member').filter({ hasText: 'Bob' })
  // the whole row: a click on its photo, not on the name
  await row.click({ position: { x: 24, y: 16 } })
  await expect(card(page).getByTestId('person-card-name')).toHaveText('Bob')
  // Esc closes the card, not the list
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await expect(rows).toBeVisible()
  await row.getByTestId('room-member-person').click()
  await card(page).getByTestId('person-card-message').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
  await expect(rows).toHaveCount(0)
})

test('a guest: Message only for the people of their place; a member sees the guest with the tag and Message', async ({ page }) => {
  await reset(page)
  // the guest's place is this room; the mock's directory gives a guest the person who invited them (olga), not bob
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: ROOM_ID }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  const gina = { id: 'gina', name: 'Gina' }
  const talk: MockMessage[] = [
    { id: mid(1), author: olga, body: 'Welcome @Gina.', mentions: ['gina'] },
    { id: mid(2), author: bob, body: 'Hello from someone outside her places.' },
    { id: mid(3), author: gina, body: 'Thank you.' },
  ]
  await routeRoom(page, { members: [olga, bob], messages: talk, me: gina })
  const asked = await routeDm(page, gina, olga)
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  // someone she cannot reach: no button (the server would refuse the 1:1 chat)
  await expect(run(page, 'Bob')).toBeVisible()
  await expect(run(page, 'Bob').getByTestId('room-run-face')).toHaveCount(0)
  // herself
  await run(page, 'Gina').getByTestId('room-run-name').click()
  await expect(card(page).getByTestId('guest-tag')).toBeVisible()
  await expect(card(page).getByTestId('person-card-message')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // a person of her place
  await run(page, 'Olga').getByTestId('room-run-face').click()
  await card(page).getByTestId('person-card-message').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
  expect(asked).toEqual(['olga'])

  // the member's side: the guest's card has the tag and Message
  const other = await page.context().browser()!.newContext({ serviceWorkers: 'block', locale: 'ko-KR' })
  const p2 = await other.newPage()
  await routeRoom(p2, { members: [bob, gina], messages: talk })
  const asked2 = await routeDm(p2, olga, gina)
  await signIn(p2)
  await p2.goto(`/rooms/${ROOM_ID}`)
  await run(p2, 'Gina').getByTestId('room-run-face').click()
  await expect(card(p2).getByTestId('guest-tag')).toBeVisible()
  await card(p2).getByTestId('person-card-message').click()
  await expect(p2).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
  expect(asked2).toEqual(['gina'])
  await other.close()
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the card is a bottom sheet; Message opens the 1:1 chat', async ({ page }) => {
    const asked = await openRoom(page)
    await run(page, 'Bob').getByTestId('room-run-face').tap()
    await expect(card(page)).toBeVisible()
    const sheet = await page.locator('[role="menu"]').filter({ has: card(page) }).boundingBox()
    expect(sheet!.x).toBe(0)
    expect(sheet!.width).toBe(390)
    expect(Math.round(sheet!.y + sheet!.height)).toBe(844)
    const button = await card(page).getByTestId('person-card-message').boundingBox()
    expect(button!.height).toBeGreaterThanOrEqual(44)
    await card(page).getByTestId('person-card-message').tap()
    await expect(page).toHaveURL(new RegExp(`/rooms/${DM_ID}$`))
    expect(asked).toEqual(['bob'])
  })
})
