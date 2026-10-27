import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { PushSubscriptionInput, NotificationEventType } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { Vault } from '../credentials/vault'
import { eventEnabled, getPreferences } from './preferences'
import { onPushCancellation, cancelPushUser } from './push-events'
import { readPushConfig, pushConfigKey, type PushConfig } from './push-config'
import { bounded, createPushTransport, validatePushSubscription, type PushSubscription, type PushTransport } from './push-transport'
export interface PushOptions {config:()=>PushConfig|null;transport:PushTransport;now:()=>number;requestTimeoutMs?:number}
type Subscription={id:string;user_id:string;session_id:string;secret_enc:string;key_version:number;config_key:string;created_at:string;endpoint_hash:string}
type Delivery={notification_id:string;subscription_id:string;attempts:number;expires_at:string}
const TTL_MS=86400_000,MAX_ATTEMPTS=3,MAX_SUBSCRIPTIONS=10
const services=new WeakMap<AppContext,PushService>()
export class PushService {
  private readonly o:PushOptions
  private readonly vault:Vault
  private readonly secrets:string
  private stopped=false
  private flight:{abort:AbortController;userId:string;sessionId:string;subscriptionId:string;notificationId:string;configKey:string}|null=null
  private work:Promise<void>|null=null
  private timer:ReturnType<typeof setInterval>|null=null
  private unlisten:()=>void
  constructor(readonly ctx:AppContext,options:Partial<PushOptions>={}){
    this.o={config:()=>readPushConfig(ctx),transport:createPushTransport(),now:Date.now,...options}
    this.secrets=path.join(ctx.config.dataDir,'secrets','push');this.vault=new Vault(this.secrets)
    this.unlisten=onPushCancellation(ctx,scope=>{
      const f=this.flight
      if(f&&(!scope.userId||f.userId===scope.userId)&&(!scope.sessionId||f.sessionId===scope.sessionId)&&!this.eligible(f.subscriptionId,f.notificationId,f.configKey))f.abort.abort()
    })
  }
  private iso(ms=this.o.now()){return new Date(ms).toISOString()}
  private session(userId:string,sessionId:string){return !!this.ctx.db.query(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.status='active' AND u.deleted_at IS NULL AND u.must_change_password=0 AND s.temp_login=0`).get(sessionId,userId,this.iso())}
  private requireSession(userId:string,sessionId:string){if(!this.session(userId,sessionId))throw new HttpError('unauthorized')}
  private enabled(userId:string){return !!this.ctx.db.query('SELECT 1 FROM push_preferences WHERE user_id=? AND enabled=1').get(userId)}
  settings(userId:string,sessionId:string){
    this.requireSession(userId,sessionId);const c=this.o.config()
    const sub=this.ctx.db.query('SELECT id,config_key FROM push_subscriptions WHERE user_id=? AND session_id=?').get(userId,sessionId) as {id:string;config_key:string}|null
    return{configured:!!c,enabled:this.enabled(userId),publicKey:c?.publicKey??null,subscriptionId:c&&sub?.config_key===pushConfigKey(c)?sub.id:null}
  }
  private safeSecrets(create=false){
    const realData=fs.realpathSync(this.ctx.config.dataDir),team=fs.realpathSync(this.ctx.config.teamRoot)
    if(realData===team||realData.startsWith(team+path.sep))throw new HttpError('unavailable')
    for(const dir of [this.ctx.config.dataDir,path.dirname(this.secrets),this.secrets]){
      if(create&&!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700})
      const st=fs.lstatSync(dir)
      if(st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o077)||(process.getuid&&st.uid!==process.getuid()))throw new HttpError('unavailable')
    }
  }
  subscribe(userId:string,sessionId:string,input:z.infer<typeof PushSubscriptionInput>){
    this.requireSession(userId,sessionId);if(input.consent!==true)throw new HttpError('validation')
    const config=this.o.config();if(!config)throw new HttpError('unavailable')
    validatePushSubscription(input);this.safeSecrets(true)
    const endpointHash=crypto.createHash('sha256').update(input.endpoint).digest('hex'),configKey=pushConfigKey(config)
    return this.ctx.db.transaction(()=>{
      const other=this.ctx.db.query('SELECT * FROM push_subscriptions WHERE endpoint_hash=?').get(endpointHash) as Subscription|null
      if(other&&(other.user_id!==userId||other.session_id!==sessionId))throw new HttpError('conflict')
      if(other&&other.config_key===configKey){
        const old=this.vault.decrypt(`${userId}|${sessionId}|${other.id}`,'web-push',other.secret_enc,other.key_version) as PushSubscription
        if(old.endpoint===input.endpoint&&old.keys.p256dh===input.keys.p256dh&&old.keys.auth===input.keys.auth)return{id:other.id}
      }
      const count=this.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=? AND session_id<>?').get(userId,sessionId) as {n:number}
      if(count.n>=MAX_SUBSCRIPTIONS)throw new HttpError('plan_limit')
      this.ctx.db.query('DELETE FROM push_subscriptions WHERE session_id=?').run(sessionId)
      const id=newId(),encrypted=this.vault.encrypt(`${userId}|${sessionId}|${id}`,'web-push',{endpoint:input.endpoint,keys:input.keys})
      this.ctx.db.query('INSERT INTO push_subscriptions(id,user_id,session_id,endpoint_hash,secret_enc,key_version,config_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,userId,sessionId,endpointHash,encrypted.enc,encrypted.keyVersion,configKey,this.iso())
      this.ctx.db.query('INSERT INTO push_preferences(user_id,enabled,enabled_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,enabled_at=CASE WHEN enabled=0 THEN excluded.enabled_at ELSE enabled_at END').run(userId,this.iso())
      return{id}
    })()
  }
  setEnabled(userId:string,sessionId:string,enabled:boolean,consent?:true){
    this.requireSession(userId,sessionId);if(enabled&&consent!==true)throw new HttpError('validation')
    if(enabled&&!this.o.config())throw new HttpError('unavailable')
    this.ctx.db.transaction(()=>{
      this.ctx.db.query('INSERT INTO push_preferences(user_id,enabled,enabled_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,enabled_at=excluded.enabled_at').run(userId,enabled?1:0,this.iso())
      if(!enabled)this.ctx.db.query('DELETE FROM push_subscriptions WHERE user_id=?').run(userId)
    })();cancelPushUser(this.ctx,userId);return this.settings(userId,sessionId)
  }
  unsubscribe(userId:string,sessionId:string,id:string){
    this.requireSession(userId,sessionId)
    if(!this.ctx.db.query('DELETE FROM push_subscriptions WHERE id=? AND user_id=? AND session_id=?').run(id,userId,sessionId).changes)throw new HttpError('not_found')
    cancelPushUser(this.ctx,userId)
  }
  /** Every invocation (including after async DNS) rechecks current DB/config, never an old captured auth object. */
  private eligible(id:string,notificationId:string,configKey:string){
    const c=this.o.config();if(this.stopped||!c||pushConfigKey(c)!==configKey)return null
    if(!this.ctx.db.query("SELECT 1 FROM push_deliveries WHERE subscription_id=? AND notification_id=? AND state IN ('pending','sending')").get(id,notificationId))return null
    const sub=this.ctx.db.query('SELECT * FROM push_subscriptions WHERE id=? AND config_key=?').get(id,configKey) as Subscription|null
    if(!sub||!this.session(sub.user_id,sub.session_id)||!this.enabled(sub.user_id))return null
    const row=this.ctx.db.query('SELECT event_type,created_at FROM notification_inbox WHERE id=? AND user_id=? AND suppressed=0 AND read_at IS NULL').get(notificationId,sub.user_id) as {event_type:NotificationEventType;created_at:string}|null
    const prefs=this.ctx.db.query('SELECT enabled_at FROM push_preferences WHERE user_id=?').get(sub.user_id) as {enabled_at:string}|null
    if(!row||row.created_at<sub.created_at||row.created_at<(prefs?.enabled_at??this.iso())||Date.parse(row.created_at)+TTL_MS<=this.o.now()||!eventEnabled(getPreferences(this.ctx.db,sub.user_id),row.event_type))return null
    return{sub,event:row.event_type}
  }
  private enqueue(config:PushConfig){
    const db=this.ctx.db,now=this.iso(),key=pushConfigKey(config)
    db.query('DELETE FROM push_subscriptions WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=push_subscriptions.session_id AND s.user_id=push_subscriptions.user_id AND s.expires_at>? AND u.status=\'active\' AND u.deleted_at IS NULL)').run(now)
    db.query("UPDATE push_deliveries SET state='pending',lease_until=NULL WHERE state='sending' AND lease_until<=?").run(now)
    db.query("UPDATE push_deliveries SET state='failed',lease_until=NULL WHERE state='pending' AND (expires_at<=? OR attempts>=?)").run(now,MAX_ATTEMPTS)
    db.query(`INSERT INTO push_deliveries(notification_id,subscription_id,next_at,expires_at)
      SELECT n.id,s.id,?,strftime('%Y-%m-%dT%H:%M:%fZ',n.created_at,'+1 day') FROM notification_inbox n JOIN push_subscriptions s ON s.user_id=n.user_id
      JOIN push_preferences p ON p.user_id=n.user_id AND p.enabled=1
      WHERE n.suppressed=0 AND n.read_at IS NULL AND n.created_at>=s.created_at AND n.created_at>=p.enabled_at AND n.created_at>? AND s.config_key=?
      AND NOT EXISTS(SELECT 1 FROM push_deliveries d WHERE d.notification_id=n.id AND d.subscription_id=s.id)
      ORDER BY n.created_at,n.id LIMIT 500 ON CONFLICT(notification_id,subscription_id) DO NOTHING`).run(now,this.iso(this.o.now()-TTL_MS),key)
  }
  tick():Promise<void>{
    if(this.work)return this.work
    if(this.stopped)return Promise.resolve()
    this.work=this.dispatch().catch(()=>{this.ctx.log.warn('push dispatch deferred')}).finally(()=>{this.work=null})
    return this.work
  }
  private async dispatch(){
    const config=this.o.config();if(!config)return
    this.enqueue(config);const started=performance.now(),key=pushConfigKey(config)
    // One in-flight transport, at most ten per tick and 30 s total; interval calls never overlap.
    for(let i=0;i<10&&!this.stopped&&performance.now()-started<29_000;i++){
      const row=this.ctx.db.query("SELECT notification_id,subscription_id,attempts,expires_at FROM push_deliveries WHERE state='pending' AND next_at<=? ORDER BY next_at,notification_id,subscription_id LIMIT 1").get(this.iso()) as Delivery|null
      if(!row)return
      const allowed=this.eligible(row.subscription_id,row.notification_id,key)
      if(!allowed){this.ctx.db.query("UPDATE push_deliveries SET state='cancelled' WHERE notification_id=? AND subscription_id=? AND state='pending'").run(row.notification_id,row.subscription_id);continue}
      const changed=this.ctx.db.query("UPDATE push_deliveries SET state='sending',attempts=attempts+1,lease_until=? WHERE notification_id=? AND subscription_id=? AND state='pending'").run(this.iso(this.o.now()+35_000),row.notification_id,row.subscription_id)
      if(!changed.changes)continue
      const abort=new AbortController();this.flight={abort,userId:allowed.sub.user_id,sessionId:allowed.sub.session_id,subscriptionId:row.subscription_id,notificationId:row.notification_id,configKey:key}
      let status=0
      try{
        this.safeSecrets()
        const sub=this.vault.decrypt(`${allowed.sub.user_id}|${allowed.sub.session_id}|${allowed.sub.id}`,'web-push',allowed.sub.secret_enc,allowed.sub.key_version) as PushSubscription
        const timeout=Math.min(this.o.requestTimeoutMs??10_000,Math.max(1,30_000-(performance.now()-started)))
        const timer=setTimeout(()=>abort.abort(),timeout)
        try{status=(await bounded(this.o.transport({subscription:sub,payload:{notificationId:row.notification_id,subscriptionId:row.subscription_id,code:allowed.event},config,signal:abort.signal,beforeSend:()=>!abort.signal.aborted&&!!this.eligible(row.subscription_id,row.notification_id,key),ttlSeconds:Math.max(0,Math.floor((Date.parse(row.expires_at)-this.o.now())/1000))}),abort.signal,timeout)).statusCode}
        finally{clearTimeout(timer)}
      }catch{/* No provider body, endpoint, key, or raw error is logged. */}
      finally{abort.abort();this.flight=null}
      if(this.stopped){this.ctx.db.query("UPDATE push_deliveries SET state='pending',next_at=?,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND state='sending'").run(this.iso(this.o.now()+30_000),row.notification_id,row.subscription_id);return}
      if(status===404||status===410){this.ctx.db.query('DELETE FROM push_subscriptions WHERE id=?').run(row.subscription_id);continue}
      if(!this.eligible(row.subscription_id,row.notification_id,key)){
        this.ctx.db.query("UPDATE push_deliveries SET state='cancelled',lease_until=NULL WHERE notification_id=? AND subscription_id=? AND state='sending'").run(row.notification_id,row.subscription_id);continue
      }
      const attempts=row.attempts+1,success=status>=200&&status<300,retry=status===0||status===429||status>=500
      const state=success?'sent':retry&&attempts<MAX_ATTEMPTS?'pending':'failed'
      this.ctx.db.query("UPDATE push_deliveries SET state=?,next_at=?,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND state='sending'").run(state,this.iso(this.o.now()+(attempts===1?30_000:120_000)),row.notification_id,row.subscription_id)
    }
  }
  start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref?.();void this.tick()}
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.flight?.abort.abort();this.unlisten();await this.work}
}
export function pushOf(ctx:AppContext){let s=services.get(ctx);if(!s){s=new PushService(ctx);services.set(ctx,s)}return s}
export function installPush(ctx:AppContext){const s=pushOf(ctx);s.start();ctx.onClose(()=>s.stop())}
