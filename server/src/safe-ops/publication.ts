import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import type { TeamFiles } from '../team-files/service'
import type { ToolCtx } from '../files/service'
import { authorize } from '../policy/authorize'
import { atLeast } from '../policy/access'
import { ToolError } from '../policy/errors'
import { fileEvent, sha256 } from '../files/store'
import { publishChanges } from '../team-files/changes'
import { addSources, readScope, sourceOf } from '../chat/read-scope'
import { assertStorageRoomForAI } from '../system/storage'
import { broker } from './broker'
import { waitForApproval } from './cancel'
import { snapshot, recheck, type SourceSnapshot } from './source'

export const policyGeneration = (db: Database) => (db.query('SELECT generation FROM safe_ops_policy WHERE id=1').get() as {generation:number}).generation
const changed = () => new ToolError('Publication approval or source changed.', 'safe_ops_changed')
function audience(ctx: AppContext, rel: string) {
  const rules=ctx.files.rules()
  return JSON.stringify((ctx.db.query("SELECT id FROM users WHERE status='active' AND deleted_at IS NULL ORDER BY id").all() as {id:string}[])
    .filter(u=>atLeast(rules.access(ctx.files.principal(u.id),rel.split('/')),'read')).map(u=>u.id))
}

/** Recovery is deliberately abort-only. An interrupted link may already be visible:
 * never publish it again or guess that a same-hash independent file belongs to us.
 * The journal and hash quarantine precede linkat and survive any later failure. */
export function recoverPublications(db: Database, root: string, own = false) {
  for(const row of db.query("SELECT id,destination,owner_pid FROM safe_ops_publications WHERE cleanup!='clean' OR state='approved'").all() as {id:string;destination:string;owner_pid:number}[]) {
    if (!own) { try { process.kill(row.owner_pid,0); continue } catch(e:any) { if(e.code!=='ESRCH') continue } }
    try {
      broker(root,['clean',row.destination,row.id])
      db.query("UPDATE safe_ops_publications SET state=CASE WHEN state='published' THEN state ELSE 'interrupted' END,cleanup='clean' WHERE id=?").run(row.id)
    } catch { db.query("UPDATE safe_ops_publications SET cleanup='debt' WHERE id=?").run(row.id) }
  }
}

export async function publishArtifact(
 ctx:AppContext, files:TeamFiles, c:ToolCtx, requested:string, data:Uint8Array, sources:SourceSnapshot[],
 approve:(target:string, sources:string[], binding:string)=>Promise<void>,
) {
 const db=ctx.db, bytes=Buffer.from(data), hash=sha256(bytes), id=crypto.randomUUID()
 // grep/search retain scope but do not capture immutable source versions. Require
 // an explicit read before deriving a published artifact from any such result.
 // Taking a fresh snapshot now would falsely bind old model context to new bytes.
 for (const rel of c.files.readPaths) {
   if (!c.files.allReads.has(rel)) throw changed()
 }
 // Model-authored text may derive from earlier reads in this turn, even without
 // explicit Markdown image/source references. Bind and recheck those versions too:
 // every agent's reads (the main AI writes from its sub-agents' reports and they
 // from its instructions), not only the calling agent's read-before-write state.
 sources=[...sources]
 let sourceBytes=sources.reduce((n,s)=>n+s.bytes.length,0)
 for(const [rel,expectedHash] of c.files.allReads) {
   const explicit=sources.find(s=>s.path===rel)
   if(explicit) { if(explicit.hash!==expectedHash) throw changed(); continue }
   if(sources.length>=32) throw new ToolError('Safe source limit.', 'safe_ops_workflow')
   const source=snapshot(ctx.files,c,rel,Math.max(0,32*1024**2-sourceBytes))
   const image=c.files.imageSources.get(rel)
   if(source.hash!==expectedHash || (image && source.identity!==image.identity)) throw changed()
   sourceBytes+=source.bytes.length; sources.push(source)
 }
 if(bytes.length>32*1024**2 || c.files.bytesWritten+bytes.length>ctx.engineConfig.maxWriteBytesPerTurn || c.files.filesWritten.size>=ctx.engineConfig.maxFilesWrittenPerTurn)
   throw new ToolError('Safe workflow write limit.', 'safe_ops_workflow')
 assertStorageRoomForAI(bytes.length)
 if(db.query("SELECT 1 FROM safe_ops_publications WHERE cleanup!='clean' LIMIT 1").get()) throw new ToolError('Publication cleanup debt.', 'safe_ops_workflow')
 c.user=ctx.files.principal(c.user.id)
 const out=authorize(files.fx,files.rules(),c.user,requested,'write',{mustExist:false,download:true})
 // Skill publication requires a different artifact-specific approval UI; not qualified in 1A.
 if(out.segs[0]==='skills') throw new ToolError('Choose an existing folder outside skills.', 'safe_ops_destination')
 let target=out.rel, conflictCopyOf:string|undefined
 if(out.exists) {
   const extension=path.posix.extname(out.rel)
   target=out.rel.slice(0,-extension.length)+` (conflict ${id})`+extension
   conflictCopyOf=out.rel
 }
 authorize(files.fx,files.rules(),c.user,target,'write',{mustExist:false})
 for(const s of sources) c.files.readPaths.add(s.path)
 // The approval's source set also includes the conversation's historical scope.
 const chat=c.turnId?(db.query('SELECT chat_id FROM turns WHERE id=?').get(c.turnId) as {chat_id:string}|null)?.chat_id:null
 if(chat) addSources(db,chat,[...c.files.readPaths].map(p=>sourceOf(db,files.rules(),p)))
 const provenance=JSON.stringify({sources:sources.map(({bytes,...s})=>({...s,scope:sourceOf(db,files.rules(),s.path)})),
   readVersions:[...c.files.allReads],imageVersions:[...c.files.imageSources],scope:chat?readScope(db,chat):null})
 const policy=policyGeneration(db), viewers=audience(ctx,target)
 const binding=JSON.stringify({id,hash,destination:target,audience:JSON.parse(viewers),policy})
 await waitForApproval(approve(target,sources.map(s=>s.path),binding),c.signal)
 // A one-use journal entry is durable BEFORE the filesystem disclosure. Rollback of
 // the final SQL transaction cannot erase it. It is never reused on a retry/restart.
 c.signal?.throwIfAborted()
 if(policy!==policyGeneration(db) || viewers!==audience(ctx,target)) throw changed()
 ctx.files.quarantine.add(bytes,'pptx')
 db.query("INSERT INTO safe_ops_publications(id,user_id,turn_id,destination,hash,size,policy,audience,provenance,state,cleanup,created,owner_pid) VALUES(?,?,?,?,?,?,?,?,?,'approved','clean',?,?)")
   .run(id,c.user.id,c.turnId,target,hash,bytes.length,policy,viewers,provenance,Date.now(),process.pid)
 // Record the possibly outstanding filesystem operation before starting it.
 db.query("UPDATE safe_ops_publications SET state='publishing',cleanup='pending' WHERE id=?").run(id)
 try {
   // BEGIN IMMEDIATE serializes policy mutation from every SQLite connection until
   // linkat commits. No await here. External filesystem writers get EEXIST, never overwrite.
   db.transaction(()=>{
     c.signal?.throwIfAborted(); c.user=ctx.files.principal(c.user.id)
     if(policy!==policyGeneration(db) || viewers!==audience(ctx,target) || sha256(bytes)!==hash) throw changed()
     if(chat && JSON.stringify(readScope(db,chat))!==JSON.stringify(JSON.parse(provenance).scope)) throw changed()
     for(const s of sources) recheck(ctx.files,c,s)
     authorize(files.fx,files.rules(),c.user,target,'write',{mustExist:false,download:true})
     const row=db.query('SELECT state,hash,destination,policy,audience FROM safe_ops_publications WHERE id=?').get(id) as any
     if(row.state!=='publishing'||row.hash!==hash||row.destination!==target||row.policy!==policy||row.audience!==viewers) throw changed()
     const result=broker(files.fx.root,['publish',target,id,hash],bytes)
     if(result===null) throw new ToolError('Destination changed; retry to create an explicit conflict copy.', 'safe_ops_conflict')
     const st=fs.lstatSync(path.join(files.fx.root,target))
     db.query('INSERT OR IGNORE INTO safe_ops_inodes(identity) VALUES(?)').run(`${st.dev}:${st.ino}`)
     db.query("UPDATE safe_ops_publications SET state='published',cleanup='clean' WHERE id=?").run(id)
     fileEvent(db,{turnId:c.turnId,userId:c.user.id,path:target,action:'create',size:bytes.length,sha256:hash,
       detail:{tool:'make_file',safeOpsJob:id,quarantined:true,...(conflictCopyOf?{conflictCopyOf}:{})}})
   }).immediate()
 } catch(e) {
   // No automatic retry, even if the helper died after linking the file.
   if(e instanceof ToolError && e.code==='safe_ops_conflict')
     db.query("UPDATE safe_ops_publications SET state='conflict',cleanup='clean' WHERE id=?").run(id)
   else recoverPublications(db,files.fx.root,true)
   throw e
 }
 c.files.bytesWritten+=bytes.length; c.files.filesWritten.add(target)
 publishChanges(ctx,[{path:target,action:'create',by:{id:c.user.id,name:c.user.name},turnId:c.turnId}])
 return {path:target,size:bytes.length,sha256:hash,...(conflictCopyOf?{conflictCopyOf}:{})}
}
