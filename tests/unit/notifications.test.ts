import { afterEach, expect, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { notificationsOf } from '../../server/src/notifications/service'
let h: Harness
async function setup() { h = await harness('notifications'); await withOwner(h); return notificationsOf(h.ctx) }
function terminal(id = 'turn-1', status = 'done', at = new Date().toISOString()) {
  h.ctx.db.query('INSERT OR IGNORE INTO chats(id,user_id,title) VALUES(?,?,?)').run(id, 'olga', 'PRIVATE TITLE MUST NOT COPY')
  h.ctx.db.query('INSERT INTO turns(id,chat_id,user_id,engine,status,ended_at,schedule_id,scheduled_for,error) VALUES(?,?,?,?,?,?,?,?,?)').run(id, id, 'olga', 'claude-code', status, at, 'schedule-1', id, 'SECRET ERROR MUST NOT COPY')
}
afterEach(async () => { await h?.close() })
test('terminal reconcile deduplicates, metadata is generic, read is own-user and link is rechecked', async () => {
  const n = await setup(); terminal(); n.reconcile(); n.reconcile()
  let page = n.list('olga', {}); expect(page.items).toHaveLength(1); expect(page.unreadCount).toBe(1)
  const one = page.items[0]!; expect(one.eventType).toBe('schedule.success'); expect(one.chatId).toBe('turn-1')
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE TITLE|SECRET ERROR/)
  expect(n.list('other', {}).items).toHaveLength(0)
  expect(() => n.read('other', one.id)).toThrow()
  expect(n.read('olga', one.id).readAt).toBeTruthy(); expect(n.list('olga', {}).unreadCount).toBe(0)
  h.ctx.db.query("UPDATE chats SET deleted_at=? WHERE id='turn-1'").run(new Date().toISOString())
  page = n.list('olga', {}); expect(page.items[0]!.chatId).toBeNull(); expect(page.items[0]!.link).toBeNull()
})
test('failed hook is reconciled after restart; opt-out tombstones never reappear on opt-in', async () => {
  const n = await setup(); terminal()
  h.ctx.db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON notification_inbox BEGIN SELECT RAISE(ABORT,'synthetic'); END")
  expect(() => n.afterTurn('turn-1')).not.toThrow(); expect(n.list('olga', {}).items).toHaveLength(0)
  h.ctx.db.exec('DROP TRIGGER fail_inbox'); n.reconcile(); expect(n.list('olga', {}).items).toHaveLength(1)
  n.setPreferences('olga', { scheduleFailure: false }); terminal('turn-2', 'error'); n.reconcile()
  n.setPreferences('olga', { scheduleFailure: true }); n.reconcile(); expect(n.list('olga', {}).items).toHaveLength(1)
  terminal('turn-3', 'interrupted'); n.reconcile(); expect(n.list('olga', {}).items).toHaveLength(2)
})
test('retention, cursor validation, disabled users and reconnect event IDs stay private', async () => {
  const n = await setup(); terminal('old', 'done', new Date(Date.now() - 31 * 86400_000).toISOString())
  n.reconcile(); expect(n.list('olga', {}).items).toHaveLength(0)
  n.connectionReconnect('olga', 'opaque-episode-1'); n.connectionReconnect('olga', 'opaque-episode-1')
  expect(n.list('olga', {}).items).toHaveLength(1)
  expect(() => n.list('olga', { cursor: 'invalid' })).toThrow()
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id='olga'").run()
  n.connectionReconnect('olga', 'opaque-episode-2'); expect(n.list('olga', {}).items).toHaveLength(0)
})

test('more than one reconciliation page is settled before preferences change', async () => {
  const n = await setup()
  n.setPreferences('olga', { scheduleFailure: false })
  h.ctx.db.transaction(() => { for (let i = 0; i < 505; i++) terminal(`backlog-${i}`, 'error') })()
  n.setPreferences('olga', { scheduleFailure: true }); n.reconcile()
  expect(n.list('olga', {}).items).toHaveLength(0)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM notification_inbox WHERE suppressed=1').get()).toEqual({ n: 505 })
})
test('skipped budget occurrence has a durable generic failure without a chat and expires once', async () => {
  const n = await setup(), at = new Date().toISOString()
  h.ctx.db.query('INSERT INTO schedule_outcomes VALUES(?,?,?,?,?,?)').run('skip-id','olga','s','due','budget_exceeded',at)
  n.reconcile(); n.reconcile()
  expect(n.list('olga', {}).items).toMatchObject([{ eventType: 'schedule.failure', chatId: null, link: null }])
  n.connectionReconnect('olga', 'old-connection', new Date(Date.now() - 31 * 86400_000).toISOString())
  expect(n.list('olga', {}).items).toHaveLength(1)
})

test('a real context restart reconciles a persisted missed terminal event without a second copy', async () => {
  await setup(); terminal('missed-during-crash')
  await h.close()
  h = await harness('notifications', {}, { reuse: true })
  const n = notificationsOf(h.ctx)
  expect(n.list('olga', {}).items).toMatchObject([{ sourceId: 'missed-during-crash' }])
  n.reconcile(); expect(n.list('olga', {}).items).toHaveLength(1)
})
