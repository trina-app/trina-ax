// The one menu list in the browser (docs/decisions/20261126-shared-menus.md; components/menus/entityMenu.tsx), at 1440
// and 390 px: an AI chat's title menu, a room header's "⋯" and a project page's name menu (a phone: the top bar's "···")
// list their items in the same order (pin, notifications, copy link, rename, move, people and tools, then hide, leave,
// delete), leave and delete in the danger style; a project's card menu on the Projects list (1440: a phone has rows);
// moving a project to the trash says so with 실행 취소, which brings it back (lib/destructive.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'
import { DICTS } from '../../src/i18n'

test.use({ serviceWorkers: 'block' })

const t = DICTS.ko
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const GROUP = '019a5f00-0000-7000-8000-0000000c0001'
const ROOMS: MockRoomSpec[] = [{ id: GROUP, kind: 'group', name: '디자인 리뷰', peers: [{ id: 'sora', name: '김소라' }, { id: 'minsu', name: '이민수' }], ago: 3, last: '시안 2차 올렸어요' }]

/** the open menu's items, by test id */
const menuIds = (page: Page) => page.getByRole('menu').getByRole('menuitem').evaluateAll((es) => es.map((e) => e.getAttribute('data-testid')))
const item = (page: Page, id: string): Locator => page.getByRole('menu').getByTestId(id)

for (const vp of [{ name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`at ${vp.name} px`, () => {
    test.use(vp.use)

    test("an AI chat's title menu: pin, copy link, rename, move, delete; delete in the danger style", async ({ page }) => {
      await reset(page)
      await signIn(page)
      const r = await post(page, '/api/chats', { title: '분기 예산 정리' })
      expect(r.ok()).toBeTruthy()
      const { id } = (await r.json()) as { id: string }
      await page.goto(`/c/${id}`)
      await page.getByTestId('chat-menu').click()
      await expect(item(page, 'chat-pin')).toBeVisible()
      expect(await menuIds(page)).toEqual(['chat-pin', 'chat-copy-link', 'chat-rename', 'chat-project-move', 'chat-delete'])
      await expect(item(page, 'chat-pin')).toHaveText(t['chat.pin'])
      await expect(item(page, 'chat-copy-link')).toHaveText(t['rooms.menu.copyLink'])
      await expect(item(page, 'chat-rename')).toHaveText(t['chat.rename'])
      await expect(item(page, 'chat-delete')).toHaveClass(/text-danger/)
      // delete: its confirm, then "채팅을 삭제했어요." with 실행 취소
      await item(page, 'chat-delete').click()
      await page.getByTestId('dialog-confirm').click()
      await expect(page.getByText(t['chat.deleted'])).toBeVisible()
      expect(t['chat.deleted']).toBe('채팅을 삭제했어요.')
      await expect(page.getByRole('button', { name: t['common.undo'] })).toBeVisible()
    })

    test("a room header's ⋯: search first, then pin, section, notifications, copy link, rename, make a project, invite, apps, leave", async ({ page }) => {
      await reset(page)
      await routeRooms(page, ROOMS)
      await signIn(page)
      await page.goto(`/rooms/${GROUP}`)
      await expect(page.getByTestId('room-title')).toHaveText('디자인 리뷰')
      await page.getByTestId('room-menu').click()
      await expect(item(page, 'room-menu-pin')).toBeVisible()
      // a phone's header has 이름 바꾸기 too now (docs/decisions/20261126-shared-menus.md, superseding QA TC-257's rule)
      expect(await menuIds(page)).toEqual(['room-menu-search', 'room-menu-pin', 'row-section-move', 'room-menu-notify', 'room-menu-link', 'room-menu-rename', 'room-menu-make-project', 'room-menu-invite', 'room-menu-apps', 'room-menu-leave'])
      await expect(item(page, 'room-menu-leave')).toHaveClass(/text-danger/)
      await expect(item(page, 'room-menu-link')).toHaveText(t['rooms.menu.copyLink'])
    })

    test("a project's name menu: copy link, rename, project settings, leave, delete (move to trash); the trash says so with 실행 취소, which brings it back", async ({ page }) => {
      await reset(page)
      await signIn(page)
      // a team project with a member (Bob): one that goes to the trash with its folder
      const r = await post(page, '/api/projects', { name: 'Acme 런칭', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '짧게 답해 주세요.' })
      expect(r.status()).toBe(201)
      const { id } = (await r.json()) as { id: string }
      await page.goto(`/projects/${id}`)
      await page.getByTestId('project-menu').click()
      await expect(item(page, 'project-copy-link')).toBeVisible()
      const ids = await menuIds(page)
      expect(ids).toEqual(['project-copy-link', 'project-rename', 'project-edit', 'project-leave', 'project-delete'])
      await expect(item(page, 'project-leave')).toHaveClass(/text-danger/)
      await expect(item(page, 'project-rename')).toHaveText(t['chat.rename'])
      await expect(item(page, 'project-edit')).toHaveText(t['projects.settings'])
      await expect(item(page, 'project-delete')).toHaveText(t['files.moveToTrash'])
      await expect(item(page, 'project-delete')).toHaveClass(/text-danger/)
      await item(page, 'project-delete').click()
      await page.getByTestId('dialog-confirm').click()
      await expect(page.getByText(t['projects.trashedToast'].replace('{name}', 'Acme 런칭'))).toBeVisible()
      await expect(page.getByTestId('project-in-trash')).toBeVisible()
      await page.getByRole('button', { name: t['common.undo'] }).click()
      await expect(page.getByTestId('project-in-trash')).toHaveCount(0)
      await expect(page.getByTestId('project-menu')).toBeVisible()
    })
  })
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  test("a project's card menu on the list: copy link, rename, members, leave, delete, in the name menu's order; leave in the danger style", async ({ page }) => {
    await reset(page)
    await signIn(page)
    expect((await post(page, '/api/projects', { name: 'Acme 영업', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }] })).status()).toBe(201)
    await page.goto('/projects')
    const card = page.getByTestId('project-card').filter({ has: page.getByRole('link', { name: /^Acme 영업/ }) })
    await card.hover()
    await card.getByTestId('project-card-menu').click()
    await expect(item(page, 'project-card-copy-link')).toBeVisible()
    expect(await menuIds(page)).toEqual(['project-card-copy-link', 'project-card-rename', 'project-card-members', 'project-card-leave', 'project-card-delete'])
    await expect(item(page, 'project-card-leave')).toHaveClass(/text-danger/)
  })
})
