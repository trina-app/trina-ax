import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type https from 'node:https'
import { harness, withOwner, addMember, type Harness } from '../unit/a-lib'
import { createPushTransport, validatePushEndpoint, type PushSend } from '../../server/src/notifications/push-transport'
import { readPushConfig, pushConfigPath } from '../../server/src/notifications/push-config'
import { pushOf } from '../../server/src/notifications/push-service'
import { notificationsOf } from '../../server/src/notifications/service'
const pair=()=>{const e=crypto.createECDH('prime256v1');e.generateKeys();return{publicKey:e.getPublicKey().toString('base64url'),privateKey:e.getPrivateKey().toString('base64url')}}
function sendInput():PushSend{return{config:{enabled:true,subject:'mailto:push@example.test',...pair()},subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/synthetic',keys:{p256dh:pair().publicKey,auth:crypto.randomBytes(16).toString('base64url')}},payload:{notificationId:'opaque-event',subscriptionId:'opaque-subscription',code:'schedule.success'},signal:new AbortController().signal,beforeSend:()=>true,ttlSeconds:60}}
let h:Harness|undefined
afterEach(async()=>{await h?.close();h=undefined})

test('endpoint allowlist refuses private/IP/credentials/redirect-shaped/noncanonical inputs',()=>{
  for(const endpoint of ['http://fcm.googleapis.com/fcm/send/x','https://127.0.0.1/x','https://169.254.169.254/latest/meta-data','https://fcm.googleapis.com.evil.test/x','https://user@fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com:444/fcm/send/x','https://fcm.googleapis.com/fcm/send/x#fragment','https://fcm.googleapis.com/fcm/send/x?redirect=http://localhost','https://web.push.apple.com/ x','https://fcm.googleapis.com./fcm/send/x'])expect(()=>validatePushEndpoint(endpoint)).toThrow()
  for(const endpoint of ['https://fcm.googleapis.com/fcm/send/x','https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/x'])expect(validatePushEndpoint(endpoint).protocol).toBe('https:')
})
test('DNS public-IP check, pinned lookup, encrypted payload, redirect refusal and post-DNS revocation use no sockets',async()=>{
  let calls=0,pinned:unknown,body:Buffer|null=null
  const request=((options:any,cb:any)=>{
    calls++;options.lookup(options.hostname,{},(_e:any,a:any,f:any)=>{pinned={address:a,family:f}})
    const req=new EventEmitter() as any;req.destroy=()=>{};req.end=(b:Buffer)=>{body=b;queueMicrotask(()=>cb({statusCode:302,destroy(){}}))};return req
  }) as unknown as typeof https.request
  const input=sendInput()
  const blocked=createPushTransport({request,lookup:async()=>[{address:'127.0.0.1',family:4}]})
  await expect(blocked(input)).rejects.toThrow();expect(calls).toBe(0)
  const valid=createPushTransport({request,lookup:async()=>[{address:'8.8.8.8',family:4}]})
  expect(await valid(input)).toEqual({statusCode:302});expect(calls).toBe(1);expect(pinned).toEqual({address:'8.8.8.8',family:4})
  expect(body).toBeInstanceOf(Buffer);expect(body!.toString()).not.toContain('opaque-event')
  let allowed=true
  const revoked=createPushTransport({request,lookup:async()=>{allowed=false;return[{address:'8.8.8.8',family:4}]}})
  await expect(revoked({...input,beforeSend:()=>allowed})).rejects.toThrow();expect(calls).toBe(1)
})
test('abort while DNS is unresolved returns without sending later',async()=>{
  let resolve!: (a:{address:string;family:number}[])=>void,calls=0
  const transport=createPushTransport({lookup:()=>new Promise(r=>resolve=r),request:(()=>{calls++;throw new Error()}) as typeof https.request})
  const abort=new AbortController(),work=transport({...sendInput(),signal:abort.signal})
  abort.abort();await expect(work).rejects.toThrow();resolve([{address:'8.8.8.8',family:4}]);await Bun.sleep(5);expect(calls).toBe(0)
})
test('HTTP explicit consent, session/account isolation, safe config and logout cascade',async()=>{
  h=await harness('push-http');const owner=await withOwner(h),alice=await addMember(h,owner,{username:'alice'}),bob=await addMember(h,owner,{username:'bob'})
  // Stop the production dispatcher before installing synthetic config: every HTTP assertion below is offline.
  await pushOf(h.ctx).stop()
  expect((await alice.client.call('GET','/api/push'))).toMatchObject({configured:false,enabled:false,publicKey:null,subscriptionId:null})
  const configFile=pushConfigPath(h.ctx);fs.mkdirSync(path.dirname(configFile),{recursive:true,mode:0o700});fs.writeFileSync(configFile,JSON.stringify(sendInput().config),{mode:0o600})
  expect(readPushConfig(h.ctx)).not.toBeNull();fs.chmodSync(configFile,0o644);expect(readPushConfig(h.ctx)).toBeNull();fs.chmodSync(configFile,0o600)
  const sub=sendInput().subscription
  expect((await alice.client.raw('POST','/api/push/subscriptions',sub)).status).toBe(400)
  const made=await alice.client.call('POST','/api/push/subscriptions',{consent:true,...sub})
  expect((await alice.client.call('GET','/api/push')).subscriptionId).toBe(made.id)
  const status=await alice.client.raw('GET','/api/push');expect(status.headers.get('cache-control')).toBe('no-store')
  expect((await bob.client.call('GET','/api/push')).subscriptionId).toBeNull()
  expect((await bob.client.raw('POST','/api/push/subscriptions',{consent:true,...sub})).status).toBe(409)
  for(const other of [bob.client,owner])expect((await other.raw('DELETE',`/api/push/subscriptions/${made.id}`)).status).toBe(404)
  const second=h.client();await second.login('alice',alice.password)
  expect((await second.raw('DELETE',`/api/push/subscriptions/${made.id}`)).status).toBe(404)
  notificationsOf(h.ctx).connectionReconnect(alice.id,'push-check')
  const item=(await alice.client.call('GET','/api/notifications')).items[0]
  expect((await alice.client.raw('GET',`/api/notifications/${item.id}`)).headers.get('cache-control')).toBe('no-store')
  expect((await bob.client.raw('GET',`/api/notifications/${item.id}`)).status).toBe(404)
  await alice.client.call('POST','/api/auth/logout')
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({n:0})
  expect((await alice.client.raw('GET','/api/push')).status).toBe(401)
})
