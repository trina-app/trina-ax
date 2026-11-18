// Folding the Chats list (docs/decisions/20261116-collapsible-chat-sections.md; QA TC-3770..3782): every section and
// my own folders fold, on the phone's Chats tab (390) and in the computer's Chats panel (1440), with one fold key each,
// kept on the account (prefs.listFolds), so a reload and the other width keep it. Folded, a section says what waits in
// it: bold, with one pill (how many of its rooms are unread, "@" for a mention; muted rooms left out); on a computer
// the room on screen stays under its folded section, as in Slack's sidebar. The pill reads the rooms' own counts
// (roomCounts, docs/decisions/20261116-mentions-only-no-count.md): a channel at "Mentions only" (every channel's default)
// adds no number for a plain message, only bold, so the rooms here are at "All messages" unless a step says otherwise.
// A named group is a private channel (d927951c8), so a group DM here has no name.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const level = (l: 'all' | 'mentions' | 'off') => ({ own: l === 'mentions' ? null : l, byDefault: 'mentions', level: l })
const room = (name: string, o: Record<string, unknown> = {}) => ({
  id: uuidv7(), kind: 'team', name, groupId: uuidv7(), memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false,
  notify: o.muted ? level('off') : level('all'), ...o,
})
type R = ReturnType<typeof room>
const setRooms = async (page: Page, rooms: R[]) => expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
const send = (page: Page, method: 'post' | 'put', url: string, data: unknown) => page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
const folds = async (page: Page) => ((await (await page.request.get('/api/me')).json()) as { user: { prefs: { listFolds?: Record<string, string> } } }).user.prefs.listFolds ?? {}

async function start(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await reset(page)
  await signIn(page)
}

const phoneSection = (page: Page, key: string) => page.getByTestId('rooms-page').locator(`[data-testid="rooms-section"][data-section="${key}"]`)
const panelSection = (page: Page, key: string) => page.getByTestId('chats-panel').locator(`[data-testid="chats-panel-section"][data-section="${key}"]`)

test.describe('a phone (390)', () => {
  test('a section folds, says what waits in it, and stays folded after a reload and on a computer', async ({ page }) => {
    await start(page, 390)
    const design = room('디자인', { activityAt: ago(1) }), dev = room('개발', { activityAt: ago(2) }), sales = room('영업', { activityAt: ago(3), muted: true })
    await setRooms(page, [design, dev, sales])
    await page.goto('/rooms')
    const team = phoneSection(page, 'team')
    await expect(team.getByTestId('rooms-row')).toHaveCount(3)
    const fold = team.getByTestId('panel-section-fold')
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await fold.click()
    // folded and all read: no rows, no pill, not bold
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await expect(team.getByTestId('rooms-row')).toHaveCount(0)
    await expect(team.getByTestId('rooms-section-pill')).toHaveCount(0)
    await expect(team).not.toHaveAttribute('data-unread', '')
    // a plain message in a channel at "Mentions only": the header turns bold, with no number
    await setRooms(page, [{ ...design, unreadCount: 1, lastSeq: 1, notify: level('mentions') }, dev, sales])
    await expect(team).toHaveAttribute('data-unread', '')
    await expect(team.getByTestId('rooms-section-pill')).toHaveCount(0)
    // a message arrives in 개발 (no mention, All messages): the header turns bold with "1", without a reload
    await setRooms(page, [design, { ...dev, unreadCount: 1, lastSeq: 1 }, sales])
    await expect(team.getByTestId('rooms-section-pill')).toHaveAttribute('data-kind', 'unread')
    await expect(team.getByTestId('rooms-section-pill').locator('[aria-hidden]')).toHaveText('1')
    await expect(team).toHaveAttribute('data-unread', '')
    // the pill's words are part of the fold button's name
    await expect(fold).toHaveAccessibleName(/1/)
    // a muted room's message lights nothing more; a mention shows "@"
    await setRooms(page, [design, { ...dev, unreadCount: 1, lastSeq: 1 }, { ...sales, unreadCount: 4, lastSeq: 4, mentioned: true }])
    await expect(team.getByTestId('rooms-section-pill')).toHaveAttribute('data-kind', 'unread')
    await setRooms(page, [{ ...design, unreadCount: 2, lastSeq: 2, mentioned: true }, { ...dev, unreadCount: 1, lastSeq: 1 }, sales])
    await expect(team.getByTestId('rooms-section-pill')).toHaveAttribute('data-kind', 'mention')
    await expect(team.getByTestId('rooms-section-pill')).toHaveText(`@${t['rooms.mentionedYou']}`)
    // kept on the account
    await expect.poll(() => folds(page)).toEqual({ 'section:chats:team': 'folded' })
    await page.reload()
    await expect(phoneSection(page, 'team').getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect(phoneSection(page, 'team').getByTestId('rooms-row')).toHaveCount(0)
    // the same account on a computer: the Chats panel's 팀 대화방 is folded too
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByTestId('rail-chats').click()
    await expect(panelSection(page, 'team').getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect(panelSection(page, 'team').getByTestId('chats-panel-section-pill')).toHaveAttribute('data-kind', 'mention')
  })

  test('my own folder folds with its pill, and opens again with the keyboard', async ({ page }) => {
    await start(page, 390)
    const bot1 = room('알림 봇', { activityAt: ago(1) }), bot2 = room('배포 봇', { activityAt: ago(2) }), other = room('전체 공지', { activityAt: ago(3) })
    await setRooms(page, [bot1, bot2, other])
    const f = (await (await send(page, 'post', '/api/nav-folders', { kind: 'rooms', name: '🤖 Bots' })).json()) as { id: string }
    for (const r of [bot1, bot2]) expect((await send(page, 'put', `/api/rooms/${r.id}/folder`, { folderId: f.id })).ok()).toBeTruthy()
    await page.goto('/rooms')
    const bots = phoneSection(page, 'folder')
    await expect(bots.getByTestId('panel-section-name')).toHaveText('🤖 Bots')
    await expect(bots.getByTestId('rooms-row')).toHaveCount(2)
    await bots.getByTestId('panel-section-fold').click()
    await expect(bots.getByTestId('rooms-row')).toHaveCount(0)
    // the other sections stay open
    await expect(phoneSection(page, 'team').getByTestId('rooms-row')).toHaveCount(1)
    await setRooms(page, [{ ...bot1, unreadCount: 3, lastSeq: 3 }, { ...bot2, unreadCount: 1, lastSeq: 1 }, other])
    await expect(bots.getByTestId('rooms-section-pill')).toHaveAttribute('data-kind', 'unread')
    await expect(bots.getByTestId('rooms-section-pill').locator('[aria-hidden]')).toHaveText('2')
    await expect.poll(() => folds(page)).toEqual({ [`room-folder:${f.id}`]: 'folded' })
    // the keyboard: focus the header, Enter opens it
    await bots.getByTestId('panel-section-fold').focus()
    await page.keyboard.press('Enter')
    await expect(bots.getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'true')
    await expect(bots.getByTestId('rooms-row')).toHaveCount(2)
    await page.keyboard.press(' ')
    await expect(bots.getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('a computer (1440)', () => {
  test('a folded section keeps the room on screen; the folder folds on the phone too', async ({ page }) => {
    await start(page, 1440)
    const design = room('디자인', { activityAt: ago(1) }), dev = room('개발', { activityAt: ago(2) }), sales = room('영업', { activityAt: ago(3) })
    await setRooms(page, [design, dev, sales])
    const f = (await (await send(page, 'post', '/api/nav-folders', { kind: 'rooms', name: '우리 팀' })).json()) as { id: string }
    expect((await send(page, 'put', `/api/rooms/${sales.id}/folder`, { folderId: f.id })).ok()).toBeTruthy()
    await page.goto(`/rooms/${dev.id}`)
    const team = panelSection(page, 'team')
    await expect(team.getByTestId('sidebar-room-row')).toHaveCount(2)
    await team.getByTestId('panel-section-fold').click()
    // only the open room stays under the folded header
    await expect(team.getByTestId('sidebar-room-row').locator('span[title]')).toHaveText(['개발'])
    await setRooms(page, [{ ...design, unreadCount: 5, lastSeq: 5 }, dev, sales])
    await expect(team.getByTestId('chats-panel-section-pill').locator('[aria-hidden]')).toHaveText('1')
    // the folder, folded here, is folded on the phone list
    const folder = page.getByTestId('chats-panel').getByTestId('room-folder')
    await folder.getByTestId('room-folder-fold').click()
    await expect(folder.getByTestId('sidebar-room-row')).toHaveCount(0)
    await expect.poll(() => folds(page)).toEqual({ 'section:chats:team': 'folded', [`room-folder:${f.id}`]: 'folded' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/rooms')
    await expect(phoneSection(page, 'folder').getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect(phoneSection(page, 'team').getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect(phoneSection(page, 'team').getByTestId('rooms-section-pill').locator('[aria-hidden]')).toHaveText('1')
  })

  test('folds chosen in this browser before (no account copy yet) are sent to the account once', async ({ page }) => {
    await start(page, 1440)
    await setRooms(page, [room('디자인'), room('', { kind: 'group', name: null, peers: [{ id: 'bob', name: 'Bob' }, { id: 'sora', name: 'Sora' }] })])
    const me = ((await (await page.request.get('/api/me')).json()) as { user: { id: string } }).user.id
    // group chats are listed in Direct messages (docs/decisions/20261116-sidebar-channels-dms.md), so the section is 'dm'
    await page.evaluate((id) => localStorage.setItem(`mycel.trina.groupFolds.${id}`, JSON.stringify({ 'section:chats:dm': 'folded' })), me)
    await page.reload()
    await page.getByTestId('rail-chats').click()
    await expect(panelSection(page, 'dm').getByTestId('panel-section-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => folds(page)).toEqual({ 'section:chats:dm': 'folded' })
  })
})
