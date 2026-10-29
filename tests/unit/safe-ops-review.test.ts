import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { extractText } from '../../server/src/files/extract'
import { withWorkflow, reserveJob, recoverWorkflows, WORKFLOW_LIMITS } from '../../server/src/safe-ops/workflow'
import { policyGeneration, publishArtifact } from '../../server/src/safe-ops/publication'
import { Quarantine } from '../../server/src/safe-ops/quarantine'
import { SAFE_OPS_TEXT } from '../../server/src/safe-ops/strings'
let A:CApp
beforeAll(async()=>{A=await makeCApp('safe-review')})
afterAll(async()=>{await A.close()})
const qbytes=Buffer.from('synthetic generated PowerPoint bytes')

test('quarantine survives flag-off, new service, copies, renamed extensions; no parser or cache',async()=>{
 const rel='users/alice/generated.pptx', abs=path.join(A.team,rel)
 fs.writeFileSync(abs,qbytes);A.ctx.files.quarantine.add(qbytes,'pptx')
 delete process.env.MYCEL_SAFE_OPS_1A
 expect(new Quarantine(A.ctx.db,A.team).hasFile(abs)).toBe(true)
 const parser=spyOn(A.ctx.files.office as any,'extract').mockRejectedValue(new Error('legacy parser invoked'))
 try {
  componentC(A.ctx).files.extractText(rel); await A.ctx.files.office.idle()
  expect(parser).not.toHaveBeenCalled()
  expect(fs.existsSync(A.ctx.files.office.cachePath(rel))).toBe(false)
  for(const name of ['generated.pptx','copy.txt']) {
   fs.writeFileSync(path.join(A.team,'users/alice',name),qbytes)
   const r=await A.ctx.files.call('read',{file_path:'users/alice/'+name},A.toolCtx('alice'))
   expect(r.isError).toBe(true);expect(r.text).toContain(SAFE_OPS_TEXT.quarantined.ko)
  }
  const search=await A.ctx.files.grep(A.toolCtx('alice'),{pattern:'synthetic',path:'users/alice',head_limit:20})
  expect(search.text).not.toContain('generated.pptx');expect(search.text).not.toContain('copy.txt')
 } finally {parser.mockRestore()}
 await expect(extractText(rel,qbytes,{pandoc:'/not-called',pdftotext:null,quarantine:A.ctx.files.quarantine})).rejects.toThrow('download-only')
})
test('file routes deny preview, content and inline but permit authorized attachment download',async()=>{
 const p=encodeURIComponent('users/alice/generated.pptx')
 for(const url of [`/api/files/content?path=${p}`,`/api/files/preview?path=${p}`,`/api/files/download?path=${p}&preview=true`,`/api/files/download?path=${p}&disposition=inline`]) {
  const r=await A.json(url,{as:'alice'});expect(r.status).toBe(503);expect(r.body.error.params.reason).toBe('quarantined')
 }
 const r=await A.req(`/api/files/download?path=${p}&disposition=attachment`,{as:'alice'})
 expect(r.status).toBe(200);expect(r.headers.get('content-disposition')).toContain('attachment');expect(Buffer.from(await r.arrayBuffer())).toEqual(qbytes)
 expect((await A.req(`/api/files/download?path=${p}`,{as:'bob'})).status).toBe(404)
})
test('normalized images never reach OCR or thumbnail consumers',async()=>{
 const image=Buffer.from([255,216,255,217,1])
 A.ctx.files.quarantine.add(image,'image')
 fs.writeFileSync(path.join(A.team,'users/alice/normalized.jpg'),image)
 await expect(extractText('normalized.jpg',image,{pandoc:null,pdftotext:null,ocr:'/not-called',quarantine:A.ctx.files.quarantine})).rejects.toThrow('download-only')
 const r=await A.json('/api/files/download?path=users/alice/normalized.jpg&disposition=inline',{as:'alice'})
 expect(r.status).toBe(503)
})
test('approval binds final hash, target, audience and monotonic policy generation; revocation rejects',async()=>{
 const c=A.toolCtx('alice',A.turn('alice',A.chat('alice'))), generation=policyGeneration(A.ctx.db)
 let bound:any
 await expect(publishArtifact(A.ctx,componentC(A.ctx).files,c,'users/alice/revoked.pptx',qbytes,[],async(target,sources,binding)=>{
  bound=JSON.parse(binding)
  expect(bound.destination).toBe(target);expect(bound.hash).toHaveLength(64);expect(bound.audience).toEqual(['alice']);expect(bound.policy).toBe(generation)
  // Revoke AND restore: a value-only policy stamp would miss this ABA change.
  A.ctx.db.query("UPDATE users SET status='disabled' WHERE id='alice'").run()
  A.ctx.db.query("UPDATE users SET status='active' WHERE id='alice'").run()
 })).rejects.toThrow()
 expect(bound).toBeDefined();expect(fs.existsSync(path.join(A.team,'users/alice/revoked.pptx'))).toBe(false)
})
test('model-authored output rechecks an earlier read even without explicit source references',async()=>{
 const rel='users/alice/earlier.txt',c=A.toolCtx('alice',A.turn('alice',A.chat('alice')))
 fs.writeFileSync(path.join(A.team,rel),'earlier authorized source')
 await A.ctx.files.read(c,{file_path:rel})
 fs.writeFileSync(path.join(A.team,rel),'replacement')
 let approved=false
 await expect(publishArtifact(A.ctx,componentC(A.ctx).files,c,'users/alice/derived.pptx',qbytes,[],async()=>{approved=true})).rejects.toThrow()
 expect(approved).toBe(false)
 expect(fs.existsSync(path.join(A.team,'users/alice/derived.pptx'))).toBe(false)
})
test('workflow admission spans awaited stages and charges cumulative jobs',async()=>{
 const c=A.toolCtx('bob',A.turn('bob',A.chat('bob')))
 let release!:()=>void, started!:()=>void
 const ready=new Promise<void>(r=>started=r)
 const p=withWorkflow(A.ctx.files,c,async()=>{started();await new Promise<void>(r=>release=r)})
 await ready
 await expect(withWorkflow(A.ctx.files,A.toolCtx('carol'),async()=>{})).rejects.toThrow()
 release();await p
 await withWorkflow(A.ctx.files,c,async()=>{
  for(let i=0;i<WORKFLOW_LIMITS.jobs;i++) reserveJob(crypto.randomUUID(),'/unused',path.join(A.data,'unused'),1).finish(true)
  expect(()=>reserveJob(crypto.randomUUID(),'/unused',path.join(A.data,'unused'),1)).toThrow()
 })
 const sum=A.ctx.db.query('SELECT sum(reserved_cpu) AS cpu,sum(debt_bytes) AS debt FROM safe_ops_workflows WHERE user_id=?').get('bob') as any
 expect(sum.cpu).toBe(600);expect(sum.debt).toBe(0)
})
test('cleanup debt fails closed, remains charged, and dead-owner recovery clears only proven cleanup',async()=>{
 const c=A.toolCtx('dana',A.turn('dana',A.chat('dana'))),stage=path.join(A.data,'safe-ops-jobs')
 await withWorkflow(A.ctx.files,c,async()=>{reserveJob(crypto.randomUUID(),path.join(A.data,'missing-cgroup'),stage,20).finish(false)})
 expect((A.ctx.db.query("SELECT debt_bytes FROM safe_ops_workflows WHERE state='debt'").get() as any).debt_bytes).toBe(128*1024**2)
 await expect(withWorkflow(A.ctx.files,A.toolCtx('erin'),async()=>{})).rejects.toThrow()
 A.ctx.db.query("UPDATE safe_ops_workflows SET owner_pid=2147483647 WHERE state='debt'").run()
 recoverWorkflows(A.ctx.db)
 await withWorkflow(A.ctx.files,A.toolCtx('erin'),async()=>{})
})
test('download-only and unhealthy notices cover ko/en/id',()=>{
 for(const key of ['quarantined','workflow'] as const)for(const lang of ['ko','en','id'] as const) expect(SAFE_OPS_TEXT[key][lang].length).toBeGreaterThan(20)
})
