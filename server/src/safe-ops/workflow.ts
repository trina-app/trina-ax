import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from 'bun:sqlite'
import type { FileService, ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'

const scope = new AsyncLocalStorage<{db: Database; id: string; dataDir: string}>()
const refusal = () => new ToolError('Safe workflow limit or incomplete cleanup.', 'safe_ops_workflow')
export const WORKFLOW_LIMITS = { jobs:24, ioBytes:512*1024**2, cpuSeconds:600, wallMs:120_000, perTurn:4, perUserHour:8 }
const alive = (pid: number) => { try { process.kill(pid,0); return true } catch(e:any) { return e.code !== 'ESRCH' } }

/** Startup/admission reconciliation never reruns a converter. Debt stays charged until
 * BOTH its cgroup and staging directory are gone. Unknown/live owners fail closed. */
export function recoverWorkflows(db: Database) {
  const rows = db.query("SELECT id, owner_pid FROM safe_ops_workflows WHERE state IN ('running','debt')").all() as {id:string;owner_pid:number}[]
  for (const w of rows) {
    if (alive(w.owner_pid)) continue
    let clean = true
    for (const j of db.query("SELECT * FROM safe_ops_jobs WHERE workflow=? AND state!='clean'").all(w.id) as {id:string;cgroup:string;stage:string}[]) {
      try {
        if (fs.existsSync(j.cgroup)) {
          fs.writeFileSync(path.join(j.cgroup,'cgroup.kill'),'1')
          if (fs.readFileSync(path.join(j.cgroup,'cgroup.events'),'utf8').includes('populated 1')) throw refusal()
          fs.rmdirSync(j.cgroup)
        }
        fs.rmSync(j.stage,{recursive:true,force:true})
        db.query("UPDATE safe_ops_jobs SET state='clean' WHERE id=?").run(j.id)
      } catch { clean = false }
    }
    db.query('UPDATE safe_ops_workflows SET state=?, debt_bytes=? WHERE id=?').run(clean?'aborted':'debt',clean?0:128*1024**2,w.id)
  }
}
export async function withWorkflow<T>(files: FileService, c: ToolCtx, run: () => Promise<T>): Promise<T> {
  c.signal?.throwIfAborted()
  const db = files.db, id=crypto.randomUUID(), now=Date.now()
  recoverWorkflows(db)
  db.transaction(() => {
    if (db.query("SELECT 1 FROM safe_ops_workflows WHERE state IN ('running','debt') LIMIT 1").get()) throw refusal()
    const user = db.query('SELECT count(*) AS n FROM safe_ops_workflows WHERE user_id=? AND created>?').get(c.user.id,now-3600000) as {n:number}
    const turn = db.query('SELECT count(*) AS n FROM safe_ops_workflows WHERE user_id=? AND turn_id IS ? AND created>?').get(c.user.id,c.turnId,now-3600000) as {n:number}
    if (user.n>=WORKFLOW_LIMITS.perUserHour || turn.n>=WORKFLOW_LIMITS.perTurn) throw refusal()
    db.query("INSERT INTO safe_ops_workflows(id,user_id,turn_id,created,state,owner_pid) VALUES(?,?,?,?,'running',?)").run(id,c.user.id,c.turnId,now,process.pid)
  }).immediate()
  const original=c.signal, timeout=new AbortController()
  const timer=setTimeout(()=>timeout.abort(),WORKFLOW_LIMITS.wallMs)
  c.signal=original?AbortSignal.any([original,timeout.signal]):timeout.signal
  try {
    return await scope.run({db,id,dataDir:files.cfg.dataDir},run)
  } finally {
    clearTimeout(timer); c.signal=original
    db.query("UPDATE safe_ops_workflows SET state=CASE WHEN debt_bytes=0 THEN 'done' ELSE 'debt' END WHERE id=?").run(id)
  }
}

export function reserveJob(id: string, cgroup: string, fallbackStage: string, ioBytes: number) {
  const s=scope.getStore()
  if (!s) return {stage:fallbackStage, finish:(_clean:boolean)=>{}}
  const stage=path.join(s.dataDir,'safe-ops-jobs',id)
  s.db.transaction(()=>{
    const w=s.db.query('SELECT user_id,turn_id FROM safe_ops_workflows WHERE id=?').get(s.id) as {user_id:string;turn_id:string|null}
    const sum=s.db.query('SELECT sum(jobs) AS jobs,sum(io_bytes) AS io,sum(reserved_cpu) AS cpu FROM safe_ops_workflows WHERE user_id=? AND turn_id IS ? AND created>?').get(w.user_id,w.turn_id,Date.now()-3600000) as {jobs:number;io:number;cpu:number}
    if (sum.jobs+1>WORKFLOW_LIMITS.jobs || sum.io+ioBytes>WORKFLOW_LIMITS.ioBytes || sum.cpu+25>WORKFLOW_LIMITS.cpuSeconds) throw refusal()
    s.db.query('UPDATE safe_ops_workflows SET jobs=jobs+1,io_bytes=io_bytes+?,reserved_cpu=reserved_cpu+25,debt_bytes=debt_bytes+? WHERE id=?').run(ioBytes,128*1024**2,s.id)
    s.db.query("INSERT INTO safe_ops_jobs(id,workflow,cgroup,stage,state,reserved_bytes) VALUES(?,?,?,?,'running',?)").run(id,s.id,cgroup,stage,128*1024**2)
  }).immediate()
  return {stage,finish:(clean:boolean)=>{
    if(clean) s.db.transaction(()=>{
      s.db.query("UPDATE safe_ops_jobs SET state='clean' WHERE id=?").run(id)
      s.db.query('UPDATE safe_ops_workflows SET debt_bytes=debt_bytes-? WHERE id=?').run(128*1024**2,s.id)
    }).immediate()
    else s.db.query("UPDATE safe_ops_jobs SET state='debt' WHERE id=?").run(id)
  }}
}
