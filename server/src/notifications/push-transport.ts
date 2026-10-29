import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import webpush from 'web-push'
import type { PushEventType } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { isPublicAddress, isLocalAddress } from '../tools/web-fetch'
import type { PushConfig } from './push-config'
export interface PushSubscription { endpoint:string;keys:{p256dh:string;auth:string} }
export interface PushPayload { notificationId:string;subscriptionId:string;code:PushEventType }
export interface PushSend {subscription:PushSubscription;payload:PushPayload;config:PushConfig;signal:AbortSignal;beforeSend:()=>boolean;ttlSeconds:number}
export type PushTransport=(input:PushSend)=>Promise<{statusCode:number}>
const HOSTS=new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'])
export function validatePushEndpoint(raw:string):URL {
  let u:URL
  try {u=new URL(raw)}catch{throw new HttpError('validation')}
  if(raw!==u.href||/[\x00-\x20]/.test(raw)||u.protocol!=='https:'||u.port||u.username||u.password||u.hash||u.search||!HOSTS.has(u.hostname)||u.pathname==='/'||raw.length>4096)throw new HttpError('validation')
  if(u.hostname==='fcm.googleapis.com'&&!u.pathname.startsWith('/fcm/send/'))throw new HttpError('validation')
  if(u.hostname==='updates.push.services.mozilla.com'&&!u.pathname.startsWith('/wpush/v2/'))throw new HttpError('validation')
  return u
}
export function validatePushSubscription(input:PushSubscription) {
  validatePushEndpoint(input.endpoint)
  try {
    for(const value of [input.keys.p256dh,input.keys.auth])if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error()
    const publicKey=Buffer.from(input.keys.p256dh,'base64url'),auth=Buffer.from(input.keys.auth,'base64url')
    if(publicKey.length!==65||auth.length!==16||publicKey[0]!==4)throw new Error()
    crypto.ECDH.convertKey(publicKey,'prime256v1')
  }catch{throw new HttpError('validation')}
}
export type PushLookup=(host:string)=>Promise<{address:string;family:number}[]>
/** Only encryption/signing is delegated to web-push. Our transport controls DNS, TLS, redirects and cancellation. */
export function createPushTransport(o:{lookup?:PushLookup;request?:typeof https.request}={}):PushTransport {
  return async input=>{
    validatePushSubscription(input.subscription)
    const u=validatePushEndpoint(input.subscription.endpoint)
    if(input.signal.aborted||!input.beforeSend())throw new Error('push_cancelled')
    const addresses=await bounded((o.lookup??(host=>dns.lookup(host,{all:true,verbatim:true})))(u.hostname),input.signal,3000)
    if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)||isLocalAddress(a.address)))throw new Error('push_address_refused')
    const selected=addresses[0]!
    const details=webpush.generateRequestDetails(input.subscription,JSON.stringify(input.payload),{vapidDetails:input.config,TTL:Math.max(0,Math.min(86400,input.ttlSeconds)),urgency:'normal',topic:crypto.createHash('sha256').update(input.payload.notificationId).digest('base64url').slice(0,32),contentEncoding:'aes128gcm'})
    // The last check occurs AFTER DNS/encryption and immediately before opening any socket/writing headers.
    if(input.signal.aborted||!input.beforeSend())throw new Error('push_cancelled')
    return new Promise<{statusCode:number}>((resolve,reject)=>{
      let finished=false,req:ReturnType<typeof https.request>|undefined
      const finish=(error?:Error,statusCode?:number)=>{if(finished)return;finished=true;clearTimeout(timer);input.signal.removeEventListener('abort',abort);req?.destroy();error?reject(error):resolve({statusCode:statusCode??0})}
      const abort=()=>finish(new Error('push_cancelled'))
      const timer=setTimeout(()=>finish(new Error('push_timeout')),10_000)
      input.signal.addEventListener('abort',abort,{once:true})
      if(input.signal.aborted){abort();return}
      try {
        req=(o.request??https.request)({protocol:'https:',hostname:u.hostname,port:443,servername:u.hostname,path:u.pathname,method:'POST',headers:details.headers,agent:false,
          // Pin the verified address, including when Node asks for all addresses. TLS still verifies the provider name.
          lookup:((_host:unknown,opts:any,cb:any)=>opts?.all?cb(null,[selected]):cb(null,selected.address,selected.family)) as any},res=>{
          // No redirects, no provider body retained or logged. Status alone drives bounded retry/removal.
          const statusCode=res.statusCode??0;res.destroy();finish(undefined,statusCode)
        })
        req.once('error',()=>finish(new Error('push_transport_failed')))
        req.end(details.body)
      }catch{finish(new Error('push_transport_failed'))}
    })
  }
}
/** Reject timeout/abort even if an injected DNS/transport promise ignores AbortSignal; no late continuation sends. */
export function bounded<T>(promise:Promise<T>,signal:AbortSignal,ms:number):Promise<T>{
  return new Promise((resolve,reject)=>{
    let done=false
    const finish=(fn:()=>void)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn()}
    const abort=()=>finish(()=>reject(new Error('push_cancelled')))
    const timer=setTimeout(()=>finish(()=>reject(new Error('push_timeout'))),ms)
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    promise.then(value=>finish(()=>resolve(value)),()=>finish(()=>reject(new Error('push_transport_failed'))))
  })
}
