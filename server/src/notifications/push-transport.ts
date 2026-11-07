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
/** Microsoft Edge subscribes through the Windows Push Notification Service: one DNS label under notify.windows.com
 * (wns2-xxxx.notify.windows.com), never an IP literal, a deeper name or a lookalike suffix. */
export const WNS_HOST=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$/
/** WNS's only address shape: /w/ and a single `token`: base64 (and base64url) letters, and only the escapes base64
 * needs in a query (%2B %2F %3D), never an escaped control or other byte; no `&`, second parameter or fragment. */
export const WNS_SEARCH=/^\?token=(?:[A-Za-z0-9_+\/=-]|%2[BbFf]|%3[Dd]){16,4000}$/
/** A push service address the server sends to: https on the default port, no user, password or fragment, canonical as
 * the browser gave it, at most 4096 characters; Google's, Mozilla's and Apple's hosts with no query, or WNS with exactly
 * /w/?token=… (the only query any of them may carry; the transport sends it as given). Every address is still resolved
 * and checked to be public right before each send (postPinned). */
export function validatePushEndpoint(raw:string):URL {
  let u:URL
  try {u=new URL(raw)}catch{throw new HttpError('validation')}
  // `#` anywhere: an empty fragment leaves u.hash '' but is still a fragment
  if(raw!==u.href||/[\x00-\x20#]/.test(raw)||u.protocol!=='https:'||u.port||u.username||u.password||u.hash||raw.length>4096)throw new HttpError('validation')
  if(WNS_HOST.test(u.hostname)){
    if(u.pathname!=='/w/'||!WNS_SEARCH.test(u.search)||[...u.searchParams.keys()].join()!=='token')throw new HttpError('validation')
    return u
  }
  if(u.search||!HOSTS.has(u.hostname)||u.pathname==='/')throw new HttpError('validation')
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
/** Why a send got no status: our code is the message; phase, the system error code and the address families tried say
 * why. It never holds an address, token, endpoint or body, so a caller may log it. */
export interface PushFailureDetail {phase?:'dns'|'connect'|'tls'|'request';code?:string;families?:string}
export type PushErrorCode='push_transport_failed'|'push_timeout'|'push_cancelled'|'push_address_refused'
export class PushSendError extends Error {
  constructor(message:PushErrorCode,readonly detail:PushFailureDetail={}){super(message);this.name='PushSendError'}
}
/** A system error code such as ECONNREFUSED. A runtime message is never kept: it names the address. */
export const errorCode=(e:unknown)=>{const c=(e as {code?:unknown}|null)?.code;return typeof c==='string'&&/^[A-Za-z0-9_]{1,48}$/.test(c)?c:'unknown'}
/** What a caller may log about a failed send (see PushFailureDetail). */
export function pushFailure(e:unknown):{outcome:string}&PushFailureDetail{
  if(e instanceof PushSendError)return{outcome:e.message,...e.detail}
  if(e instanceof Error&&/^push_[a-z_]{1,40}$/.test(e.message))return{outcome:e.message}
  return{outcome:'push_error',code:errorCode(e)}
}
/** Only encryption/signing is delegated to web-push. Our transport controls DNS, TLS, redirects and cancellation. */
export function createPushTransport(o:{lookup?:PushLookup;request?:typeof https.request}={}):PushTransport {
  return async input=>{
    validatePushSubscription(input.subscription)
    const u=validatePushEndpoint(input.subscription.endpoint)
    if(input.signal.aborted||!input.beforeSend())throw new PushSendError('push_cancelled')
    return postPinned({url:u,signal:input.signal,beforeSend:input.beforeSend,lookup:o.lookup??(host=>dns.lookup(host,{all:true,verbatim:true})),request:o.request,
      prepare:()=>{const details=webpush.generateRequestDetails(input.subscription,JSON.stringify(input.payload),{vapidDetails:input.config,TTL:Math.max(0,Math.min(86400,input.ttlSeconds)),urgency:'normal',topic:crypto.createHash('sha256').update(input.payload.notificationId).digest('base64url').slice(0,32),contentEncoding:'aes128gcm'});return{headers:details.headers,body:details.body}}})
  }
}
/** IPv4 first, then the families alternate, resolver order kept within each. The resolver often lists IPv6 first, and a
 * machine with no IPv6 route (most office Macs, many cloud VMs) then failed every send; now it reaches a working
 * address on the first try, and an IPv6-only machine on the second. */
export function connectOrder<T extends {family:number}>(addresses:readonly T[]):T[]{
  const v4=addresses.filter(a=>a.family!==6),v6=addresses.filter(a=>a.family===6),out:T[]=[]
  for(let i=0;i<Math.max(v4.length,v6.length);i++)for(const a of [v4[i],v6[i]])if(a)out.push(a)
  return out
}
/** Connect-phase failures: the TCP handshake did not finish, so no byte of the request left this machine and the next
 * checked address may be tried. connect_timeout is our own per-address timer. */
const CONNECT_FAILURES=new Set(['ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL','ECONNREFUSED','ETIMEDOUT','EAFNOSUPPORT','connect_timeout'])
export const PUSH_CONNECT_TIMEOUT_MS=3000,PUSH_TIMEOUT_MS=10_000
/** One POST to a public HTTPS host (Web Push providers, the native push gateway): every resolved address must be
 * public, each socket is pinned to a checked address, no redirect is followed, no body is read or logged; the status
 * alone is returned. prepare() runs after DNS; beforeSend() is checked again right before every socket opens.
 * The checked addresses are tried one after another (connectOrder), each with a short connect timeout, all within one
 * overall bound. Only a failure before the TCP connection is up moves to the next address; once it is up the request
 * may have been written, so any failure is final for this attempt and a push is never sent twice. */
export async function postPinned(o:{url:URL;signal:AbortSignal;beforeSend:()=>boolean;lookup:PushLookup;request?:typeof https.request;
  prepare?:()=>{headers:Record<string,string>;body:Buffer};headers?:Record<string,string>;body?:Buffer;connectTimeoutMs?:number;timeoutMs?:number}):Promise<{statusCode:number}>{
  const u=o.url
  if(u.protocol!=='https:'||u.port||u.username||u.password)throw new PushSendError('push_address_refused')
  const addresses=await bounded(o.lookup(u.hostname).catch(e=>{throw new PushSendError('push_transport_failed',{phase:'dns',code:errorCode(e)})}),o.signal,3000)
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)||isLocalAddress(a.address)))throw new PushSendError('push_address_refused')
  const order=connectOrder(addresses)
  const prepared=o.prepare?o.prepare():{headers:o.headers??{},body:o.body??Buffer.alloc(0)}
  return new Promise<{statusCode:number}>((resolve,reject)=>{
    let finished=false,req:ReturnType<typeof https.request>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined,next=0,phase:'connect'|'tls'|'request'='connect'
    const families:number[]=[],detail=(code?:string):PushFailureDetail=>({phase,...(code?{code}:{}),families:families.join(',')})
    const finish=(error?:Error,statusCode?:number)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(connectTimer);o.signal.removeEventListener('abort',abort);req?.destroy();error?reject(error):resolve({statusCode:statusCode??0})}
    const abort=()=>finish(new PushSendError('push_cancelled',detail()))
    const timer=setTimeout(()=>finish(new PushSendError('push_timeout',detail())),o.timeoutMs??PUSH_TIMEOUT_MS)
    o.signal.addEventListener('abort',abort,{once:true})
    const attempt=(last?:string)=>{
      const a=order[next++]
      if(!a)return finish(new PushSendError('push_transport_failed',detail(last)))
      // The last check occurs AFTER DNS/encryption and immediately before opening each socket/writing headers.
      if(o.signal.aborted||!o.beforeSend())return finish(new PushSendError('push_cancelled',detail()))
      families.push(a.family);phase='connect'
      let over=false,socket:{connecting?:boolean}|undefined
      const failed=(code:string)=>{
        if(over||finished)return;over=true;clearTimeout(connectTimer)
        if(phase==='connect'&&CONNECT_FAILURES.has(code)){const r=req;req=undefined;r?.destroy();attempt(code);return}
        finish(new PushSendError('push_transport_failed',detail(code)))
      }
      // Only while the socket itself says it is still connecting; without that, the overall bound decides.
      connectTimer=setTimeout(()=>{if(phase==='connect'&&socket?.connecting===true)failed('connect_timeout')},o.connectTimeoutMs??PUSH_CONNECT_TIMEOUT_MS)
      try {
        // path with its query: a WNS address is /w/?token=… (the other providers' and the gateway's have none)
        const r=req=(o.request??https.request)({protocol:'https:',hostname:u.hostname,port:443,servername:u.hostname,path:u.pathname+u.search,method:'POST',headers:prepared.headers,agent:false,
          // Pin this checked address, including when the runtime asks for all addresses. TLS still verifies the provider name.
          lookup:((_host:unknown,opts:any,cb:any)=>opts?.all?cb(null,[a]):cb(null,a.address,a.family)) as any},res=>{
          // No redirects, no provider body retained or logged. Status alone drives bounded retry/removal.
          const statusCode=res.statusCode??0;res.destroy();if(!over){over=true;finish(undefined,statusCode)}
        })
        r.on('socket',(s:any)=>{
          if(over||finished)return;socket=s
          s?.once?.('connect',()=>{if(!over&&!finished){phase='tls';clearTimeout(connectTimer)}})
          s?.once?.('secureConnect',()=>{if(!over&&!finished)phase='request'})
        })
        // 'on', not 'once': a destroyed request may still report "socket hang up", which must not go unhandled.
        r.on('error',e=>failed(errorCode(e)))
        r.end(prepared.body)
      }catch(e){if(!over){over=true;finish(new PushSendError('push_transport_failed',detail(errorCode(e))))}}
    }
    if(o.signal.aborted){abort();return}
    attempt()
  })
}
/** Reject timeout/abort even if an injected DNS/transport promise ignores AbortSignal; no late continuation sends.
 * A PushSendError passes through with its detail; any other failure becomes push_transport_failed. */
export function bounded<T>(promise:Promise<T>,signal:AbortSignal,ms:number):Promise<T>{
  return new Promise((resolve,reject)=>{
    let done=false
    const finish=(fn:()=>void)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn()}
    const abort=()=>finish(()=>reject(new PushSendError('push_cancelled')))
    const timer=setTimeout(()=>finish(()=>reject(new PushSendError('push_timeout'))),ms)
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    promise.then(value=>finish(()=>resolve(value)),e=>finish(()=>reject(e instanceof PushSendError?e:new PushSendError('push_transport_failed',{code:errorCode(e)}))))
  })
}
