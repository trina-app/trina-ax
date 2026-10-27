import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { harness, withOwner, type Harness } from './a-lib'
import { PushService, type PushOptions } from '../../server/src/notifications/push-service'
import { notificationsOf } from '../../server/src/notifications/service'
const generateVAPIDKeys=()=>{const e=crypto.createECDH('prime256v1');e.generateKeys();return {publicKey:e.getPublicKey().toString('base64url'),privateKey:e.getPrivateKey().toString('base64url')}}
let h: Harness, p: PushService
const nowBase=Date.now(); let now=nowBase
const key=()=>{const e=crypto.createECDH('prime256v1');e.generateKeys();return e.getPublicKey().toString('base64url')}
const input=()=>({consent:true as const,endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-device',keys:{p256dh:key(),auth:crypto.randomBytes(16).toString('base64url')}})
async function setup(options: Partial<PushOptions> = {}) {
  now=nowBase; h=await harness('web-push');await withOwner(h)
  const sid=(h.ctx.db.query("SELECT id FROM sessions WHERE user_id='olga'").get() as {id:string}).id
  const keys=generateVAPIDKeys()
  p=new PushService(h.ctx,{config:()=>({enabled:true,subject:'mailto:push@example.test',...keys}),now:()=>now,transport:async()=>({statusCode:201}),...options})
  return sid
}
function event(id:string){notificationsOf(h.ctx).connectionReconnect('olga',id,new Date(now).toISOString())}
afterEach(async()=>{await p?.stop();await h?.close()})
test('disabled by default, explicit session-bound opt-in, encrypted storage and idempotent send',async()=>{
  const sent: unknown[]=[];const sid=await setup({transport:async i=>{sent.push(i.payload);return {statusCode:201}}})
  expect(p.settings('olga',sid).enabled).toBe(false)
  const b=input(),sub=p.subscribe('olga',sid,b);expect(p.subscribe('olga',sid,b)).toEqual(sub)
  const raw=JSON.stringify(h.ctx.db.query('SELECT * FROM push_subscriptions').all());expect(raw).not.toContain(b.endpoint);expect(raw).not.toContain(b.keys.auth)
  now+=10;event('episode');await p.tick();await p.tick()
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({subscriptionId:sub.id,code:'connection.reconnect'})
  expect(Object.keys(sent[0] as object).sort()).toEqual(['code','notificationId','subscriptionId'])
})
test('off removes subscriptions and deliveries; old notifications are not replayed when opting in again',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:201}}})
  p.subscribe('olga',sid,input());now+=10;event('before-off')
  p.setEnabled('olga',sid,false);await p.tick();expect(calls).toBe(0)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({n:0})
  now+=10;p.subscribe('olga',sid,input());await p.tick();expect(calls).toBe(0)
})
test('retries are bounded and inbox survives provider errors',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:503}}})
  p.subscribe('olga',sid,input());now+=10;event('retry');await p.tick();await p.tick();expect(calls).toBe(1)
  now+=31_000;await p.tick();now+=121_000;await p.tick();now+=999_000;await p.tick()
  expect(calls).toBe(3);expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'failed'})
  expect(notificationsOf(h.ctx).list('olga',{}).items).toHaveLength(1)
})
test('revoked session cascades subscriptions and no delayed transport can reauthorize it',async()=>{
  let admitted=0,finish!:()=>void;const sid=await setup({transport:async i=>{await new Promise<void>(r=>finish=r);if(i.beforeSend())admitted++;return{statusCode:201}}})
  p.subscribe('olga',sid,input());now+=10;event('revoke');const tick=p.tick()
  await Bun.sleep(10);h.auth.revokeSession(sid);finish();await tick
  expect(admitted).toBe(0);expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({n:0})
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_deliveries').get()).toEqual({n:0})
})

test('410 removes expired provider subscription and cascades delivery rows',async()=>{
  const sid=await setup({transport:async()=>({statusCode:410})});p.subscribe('olga',sid,input());now+=10;event('gone');await p.tick()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({n:0})
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_deliveries').get()).toEqual({n:0})
  expect(notificationsOf(h.ctx).list('olga',{}).items).toHaveLength(1)
})
test('runtime loop delivers new inbox records and stops boundedly even with an uncooperative transport',async()=>{
  let entered=0;const sid=await setup({transport:async()=>{entered++;return new Promise(()=>{})},requestTimeoutMs:30})
  p.subscribe('olga',sid,input());now+=10;event('bounded');p.start();await Bun.sleep(10)
  expect(entered).toBe(1);const start=performance.now();await p.stop();expect(performance.now()-start).toBeLessThan(200)
  expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({state:'pending',attempts:1})
  await p.tick();expect(entered).toBe(1)
})
test('event preference and account changes during transport preparation prevent later admission',async()=>{
  let admitted=0,finish!:()=>void;const sid=await setup({transport:async i=>{await new Promise<void>(r=>finish=r);if(i.beforeSend())admitted++;return{statusCode:201}}})
  p.subscribe('olga',sid,input());now+=10;event('preference');const tick=p.tick();await Bun.sleep(5)
  notificationsOf(h.ctx).setPreferences('olga',{connectionReconnect:false});finish();await tick
  expect(admitted).toBe(0);expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'cancelled'})
  now+=86400_000;await p.tick();expect(admitted).toBe(0)
})
test('an expired sending lease is recovered with attempts retained, never budget reset',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:503}}});const sub=p.subscribe('olga',sid,input())
  now+=10;event('lease');const notification=notificationsOf(h.ctx).list('olga',{}).items[0]!
  h.ctx.db.query("INSERT INTO push_deliveries(notification_id,subscription_id,state,attempts,next_at,lease_until,expires_at) VALUES(?,?,'sending',2,?,?,?)")
    .run(notification.id,sub.id,new Date(now-1).toISOString(),new Date(now-1).toISOString(),new Date(now+10000).toISOString())
  await p.tick();await p.tick();expect(calls).toBe(1)
  expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({state:'failed',attempts:3})
})

test('turning an event preference off cancels its queued retry permanently across a later opt-in',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:503}}})
  p.subscribe('olga',sid,input());now+=10;event('muted-retry');await p.tick()
  notificationsOf(h.ctx).setPreferences('olga',{connectionReconnect:false})
  notificationsOf(h.ctx).setPreferences('olga',{connectionReconnect:true})
  now+=31_000;await p.tick();expect(calls).toBe(1)
  expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'cancelled'})
})

test('TTL expiration prevents any further provider attempt after a transient failure',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:503}}});p.subscribe('olga',sid,input())
  now+=10;event('ttl');await p.tick();now+=86400_001;await p.tick()
  expect(calls).toBe(1);expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({state:'failed',attempts:1})
})
test('a disabled user is rechecked after asynchronous preparation, even without relying on logout hooks',async()=>{
  let admitted=0,finish!:()=>void;const sid=await setup({transport:async i=>{await new Promise<void>(r=>finish=r);if(i.beforeSend())admitted++;return{statusCode:201}}})
  p.subscribe('olga',sid,input());now+=10;event('disabled');const tick=p.tick();await Bun.sleep(5)
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id='olga'").run();finish();await tick
  expect(admitted).toBe(0);expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'cancelled'})
})

test('durably cancelled delivery cannot revive after preparation',async()=>{
  let admitted=0,finish!:()=>void;const sid=await setup({transport:async i=>{await new Promise<void>(r=>finish=r);if(i.beforeSend())admitted++;return{statusCode:201}}})
  p.subscribe('olga',sid,input());now+=10;event('cancel-state');const work=p.tick();await Bun.sleep(5)
  h.ctx.db.query("UPDATE push_deliveries SET state='cancelled'").run();finish();await work
  expect(admitted).toBe(0);expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'cancelled'})
})
test('read inbox entries are not enqueued for push',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:201}}});p.subscribe('olga',sid,input());now+=10;event('already-read')
  const n=notificationsOf(h.ctx),one=n.list('olga',{}).items[0]!;n.read('olga',one.id);await p.tick()
  expect(calls).toBe(0);expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_deliveries').get()).toEqual({n:0})
})

test('shutdown cannot revive a durable cancellation',async()=>{
  const sid=await setup({transport:async()=>new Promise(()=>{})});p.subscribe('olga',sid,input());now+=10;event('stop-cancel')
  const work=p.tick();await Bun.sleep(5);h.ctx.db.query("UPDATE push_deliveries SET state='cancelled'").run();await p.stop();await work
  expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'cancelled'})
})
test('preference and queued cancellation commit together or both roll back on storage failure',async()=>{
  const sid=await setup({transport:async()=>({statusCode:503})});p.subscribe('olga',sid,input());now+=10;event('atomic-off');await p.tick()
  h.ctx.db.exec("CREATE TRIGGER fail_push_cancel BEFORE UPDATE ON push_deliveries BEGIN SELECT RAISE(ABORT,'synthetic'); END")
  expect(()=>notificationsOf(h.ctx).setPreferences('olga',{connectionReconnect:false})).toThrow()
  expect(notificationsOf(h.ctx).preferences('olga').connectionReconnect).toBe(true)
  expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({state:'pending'})
  h.ctx.db.exec('DROP TRIGGER fail_push_cancel')
})

test('an unexpired final-attempt lease stays sending while another tick checks the queue',async()=>{
  let calls=0;const sid=await setup({transport:async()=>{calls++;return{statusCode:201}}}),sub=p.subscribe('olga',sid,input())
  now+=10;event('active-lease');const item=notificationsOf(h.ctx).list('olga',{}).items[0]!
  h.ctx.db.query("INSERT INTO push_deliveries(notification_id,subscription_id,state,attempts,next_at,lease_until,expires_at) VALUES(?,?,'sending',3,?,?,?)")
    .run(item.id,sub.id,new Date(now).toISOString(),new Date(now+30000).toISOString(),new Date(now+60000).toISOString())
  await p.tick();expect(calls).toBe(0)
  expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({state:'sending',attempts:3})
})
