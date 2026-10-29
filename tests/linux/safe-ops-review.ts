// Synthetic local-only broker regressions, run as axserver by safe-ops-entrypoint.
import fs from 'node:fs'
import { spyOn } from 'bun:test'
import { setupServerCgroups } from '../../server/src/system/cgroups'
import { normalizeImage } from '../../server/src/safe-ops/runner'
import { qualifiedEnvelope } from '../../server/src/safe-ops/envelope'
import { withWorkflow } from '../../server/src/safe-ops/workflow'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeCApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { publishArtifact, recoverPublications } from '../../server/src/safe-ops/publication'
import { broker } from '../../server/src/safe-ops/broker'
import { snapshot, recheck } from '../../server/src/safe-ops/source'
import { openDb } from '../../server/src/db'
const assert=(v:unknown,msg='assertion failed')=>{if(!v)throw new Error(msg)}
let failed=0, passed=0
async function check(name:string,f:()=>Promise<void>|void){try{await f();passed++;console.log(JSON.stringify({name,ok:true}))}catch(e){failed++;console.log(JSON.stringify({name,ok:false,error:String(e)}))}}
const app=await makeCApp('safe-review-linux'),files=componentC(app.ctx).files
const bytes=Buffer.from('synthetic final artifact - never parsed'),rel='users/alice/race.pptx'
try {
 await check('independent writer wins destination race; no overwrite; next approval uses explicit conflict copy',async()=>{
  const c=app.toolCtx('alice',app.turn('alice',app.chat('alice')))
  let denied=false
  try {await publishArtifact(app.ctx,files,c,rel,bytes,[],async()=>{
   const child=spawnSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'human edit',{flag:'wx'})",path.join(app.team,rel)],{env:{PATH:process.env.PATH}})
   assert(child.status===0)
  })}catch{denied=true}
  assert(denied);assert(fs.readFileSync(path.join(app.team,rel),'utf8')==='human edit')
  assert(!app.ctx.files.quarantine.hasFile(path.join(app.team,rel)),'known conflict must not quarantine the independent writer')
  let target=''
  const made=await publishArtifact(app.ctx,files,c,rel,bytes,[],async(t)=>{target=t})
  assert(made.path===target&&target!==rel&&made.conflictCopyOf===rel)
  assert(fs.readFileSync(path.join(app.team,target)).equals(bytes));assert(fs.statSync(path.join(app.team,target)).mode%512===256)
  const r=await app.ctx.files.call('read',{file_path:target},c);assert(r.isError===true)
  await app.ctx.files.office.update(target);assert(!fs.existsSync(app.ctx.files.office.cachePath(target)))
 })
 await check('same-device bind mount is rejected by openat2 NO_XDEV',()=>{
  const a=fs.statSync('/tmp/safe-fix-mount/root'),b=fs.statSync('/tmp/safe-fix-mount/root/nested')
  assert(a.dev===b.dev,'fixture must be a same-device bind')
  let refused=false;try{broker('/tmp/safe-fix-mount/root',['snapshot','nested/source','1024'])}catch{refused=true};assert(refused)
 })
 await check('native source rejects symlink, replacement and moves',()=>{
  const p='users/alice/source.txt',abs=path.join(app.team,p);fs.writeFileSync(abs,'first')
  const c=app.toolCtx('alice'),s=snapshot(app.ctx.files,c,p,1024)
  fs.renameSync(abs,abs+'.moved');let refused=false;try{recheck(app.ctx.files,c,s)}catch{refused=true};assert(refused)
  fs.writeFileSync(abs,'second');refused=false;try{recheck(app.ctx.files,c,s)}catch{refused=true};assert(refused)
  fs.symlinkSync(abs,abs+'.link');refused=false;try{broker(app.team,['snapshot',p+'.link','1024'])}catch{refused=true};assert(refused)
 })
 for(const phase of ['before','after']) await check(`process crash ${phase} publication; recovery never republishes and removes temporary debt`,async()=>{
  // Child has its own fixture/db. Only the broker call is wrapped to terminate the
  // server process at the two durable boundaries; the real native linkat runs.
  const child=spawnSync(process.execPath,['tests/linux/safe-ops-crash.ts',phase],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:30000})
  assert(child.status===73,child.stderr)
  const meta=JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {data:string;team:string;target:string;id:string}
  const db=openDb(path.join(meta.data,'app.db'))
  try {
   const before=fs.existsSync(path.join(meta.team,meta.target))
   assert(before===(phase==='after'))
   recoverPublications(db,meta.team);recoverPublications(db,meta.team)
   const row=db.query('SELECT state,cleanup,provenance,hash,policy,audience FROM safe_ops_publications WHERE id=?').get(meta.id) as any
   assert(row.state==='interrupted'&&row.cleanup==='clean')
   assert(JSON.parse(row.provenance).sources[0].identity&&row.hash.length===64&&row.audience&&row.policy>0)
   assert(fs.existsSync(path.join(meta.team,meta.target))===before)
   assert(fs.readdirSync(path.dirname(path.join(meta.team,meta.target))).every(n=>!n.startsWith('.mycel-tmp-safe-')))
  }finally{db.close();fs.rmSync(path.dirname(meta.data),{recursive:true,force:true})}
 })
 await check('live engine and converter share a verified hard envelope; missing engine refused',async()=>{
  const state=setupServerCgroups({mode:'prod'});assert(state.state==='delegated')
  if(state.state!=='delegated')return
  const engine=Bun.spawn(['/usr/bin/sleep','60'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'})
  try {
   const cap=qualifiedEnvelope(state.conv.dir,engine.pid)
   assert(cap.memory<=4*1024**3&&cap.pids<=512&&cap.cpu<=4)
   const c=app.toolCtx('alice',app.turn('alice',app.chat('alice')));c.files.enginePid=engine.pid
   const image=await withWorkflow(app.ctx.files,c,()=>normalizeImage('png',fs.readFileSync('/fixtures/synthetic.png')))
   assert(image[0]===255)
   let rejected=false;try{qualifiedEnvelope(state.conv.dir,2147483647)}catch{rejected=true};assert(rejected)
   // Read-back failure, injected only into this local test process.
   const read=fs.readFileSync
   const mock=spyOn(fs,'readFileSync').mockImplementation((p:any,...args:any[])=>String(p).endsWith('/memory.max')?'max\n':(read as any)(p,...args))
   rejected=false;try{qualifiedEnvelope(state.conv.dir,engine.pid)}catch{rejected=true}finally{mock.mockRestore()};assert(rejected)
  }finally{engine.kill('SIGKILL');await engine.exited}
 })
 await check('actual converter cleanup failure retains debt and makes runner unhealthy',async()=>{
  assert(setupServerCgroups({mode:'prod'}).state==='delegated')
  const c=app.toolCtx('alice',app.turn('alice',app.chat('alice')))
  c.files.enginePid=process.pid
  const original=fs.rmdirSync, failedDirs:string[]=[]
  const mock=spyOn(fs,'rmdirSync').mockImplementation((p:any,...args:any[])=>{
   if(String(p).includes('/safe-ops-1a/')) {failedDirs.push(String(p));throw new Error('synthetic cleanup I/O failure')}
   return (original as any)(p,...args)
  })
  let denied=false
  try {await withWorkflow(app.ctx.files,c,()=>normalizeImage('png',fs.readFileSync('/fixtures/synthetic.png')))}catch{denied=true}finally{mock.mockRestore()}
  assert(denied&&failedDirs.length===1)
  const debt=app.ctx.db.query("SELECT debt_bytes FROM safe_ops_workflows WHERE state='debt'").get() as any
  assert(debt.debt_bytes===128*1024**2)
  denied=false;try{await normalizeImage('png',fs.readFileSync('/fixtures/synthetic.png'))}catch{denied=true};assert(denied)
  for(const d of failedDirs) original(d)
  fs.rmSync(path.join(app.data,'safe-ops-jobs'),{recursive:true,force:true})
 })
}finally{await app.close()}
console.log(`SAFE_OPS_REVIEW_RESULT ${passed} passed, ${failed} failed`)
process.exit(failed?1:0)
