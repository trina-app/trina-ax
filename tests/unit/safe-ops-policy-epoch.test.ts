import { test, expect } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeCApp } from '../lib/c-app'
import { AuthService } from '../../server/src/auth/service'
import { snapshot, recheck } from '../../server/src/safe-ops/source'
import { policyGeneration, publishArtifact } from '../../server/src/safe-ops/publication'
import { withWorkflow } from '../../server/src/safe-ops/workflow'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { ConnectedFolders } from '../../server/src/team-files/connected'
import { componentC } from '../../server/src/team-files/component'
import { FakeServices, MCP_KEY } from '../lib/fake-services'

// Every column is deliberately classified. Adding a schema field requires an audit.
const policy: Record<string, string> = {
  users: 'id username password_hash role status must_change_password deleted_at temp_password_expires_at',
  groups: 'id folder_id', group_members: 'group_id user_id', folders: 'id path',
  folder_rules: 'id folder_id subject_type subject_id access',
  integrations: 'id scope owner_user_id kind slug url auth auth_header secret_enc key_version account write_policy status tools_json version',
  integration_access: 'integration_id subject_type subject_id', connected_folders: 'id name source',
}
const bookkeeping: Record<string, string> = {
  users: 'name email locale created_at prefs last_seen_at locale_follows_team password_reset_by password_reset_at temp_password_failures',
  groups: 'name description', group_members: '', folders: 'created_at', folder_rules: 'updated_by updated_at',
  integrations: 'created_by name notes last_error tools_updated_at last_used_at created_at updated_at',
  integration_access: '', connected_folders: 'created_by created_at last_sync_at last_status last_error files bytes',
}

test('R2-2: all policy trigger columns audited; no-op updates never advance epoch', async () => {
  const a = await makeCApp('epoch-columns')
  try {
    const db = a.ctx.db
    for (const [table, fields] of Object.entries(policy)) {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name).sort()
      expect(columns).toEqual((fields + ' ' + bookkeeping[table]).trim().split(/\s+/).sort())
      const sql = (db.query('SELECT sql FROM sqlite_master WHERE name=?').get(`safe_ops_${table}_update`) as {sql:string}).sql
      expect([...sql.matchAll(/OLD\.(\w+) IS NOT NEW\./g)].map(m => m[1]).sort()).toEqual(fields.split(' ').sort())
      const epoch = policyGeneration(db)
      for (const col of columns) db.exec(`UPDATE ${table} SET ${col}=${col}`)
      expect(policyGeneration(db)).toBe(epoch)
    }
    // Bookkeeping with genuinely different values, including NULL transitions.
    const epoch = policyGeneration(db)
    db.exec("UPDATE users SET last_seen_at='later',name=name||'!',email='synthetic@example.test',prefs='{}',locale='en',locale_follows_team=1,password_reset_at='later',password_reset_by='bob',temp_password_failures=2,created_at='earlier'")
    db.exec("UPDATE groups SET name=name||'!',description='changed'; UPDATE folders SET created_at='earlier'; UPDATE folder_rules SET updated_by='bob',updated_at='later'")
    expect(policyGeneration(db)).toBe(epoch)
  } finally { await a.close() }
})

test('R2-2: real createSession and heartbeat during workflow do not invalidate its source', async () => {
  const a = await makeCApp('epoch-auth')
  try {
    const c = a.toolCtx('alice'), rel = 'users/alice/source.txt', auth = new AuthService(a.ctx)
    fs.writeFileSync(path.join(a.team, rel), 'unchanged private workflow source')
    await withWorkflow(a.ctx.files, c, async () => {
      const source = snapshot(a.ctx.files, c, rel, 1024), epoch = policyGeneration(a.ctx.db)
      const sessions = Array.from({length: 8}, () => auth.createSession('bob', 'web', null))
      auth.now = () => Date.now() + 61_000
      const resolved = await Promise.all(sessions.map(s => auth.resolve(new Request('http://team.localhost', {headers:{authorization:'Bearer '+s.token}}), {ip:'127.0.0.1',via:'test'})))
      expect(resolved.every(Boolean)).toBe(true)
      expect(policyGeneration(a.ctx.db)).toBe(epoch)
      expect(() => recheck(a.ctx.files, c, source)).not.toThrow()
    })
  } finally { await a.close() }
})

test('R2-2: real connector calls and connected-folder sync concurrent with workflow do not bump', async () => {
  const a = await makeCApp('epoch-connectors'), fake = new FakeServices()
  const svc = integrationsOf(a.ctx, {net:fake.net()})
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-home-'))), src = path.join(home, 'share')
  fs.mkdirSync(src, {recursive:true}); fs.writeFileSync(path.join(src,'item.txt'), 'synced synthetic text')
  const cf = new ConnectedFolders(a.ctx, {home,linuxRoots:[home]})
  try {
    const created = await a.json('/api/integrations', {as:'bob',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'mcp',name:'Tasks',url:fake.base+'/mcp-key',auth:'bearer',secret:MCP_KEY})})
    expect(created.status).toBe(201)
    const connected = cf.add({name:'epoch-share',source:src,actor:'carol'})
    const c = a.toolCtx('alice'), rel = 'users/alice/source.txt'
    fs.writeFileSync(path.join(a.team,rel), 'unchanged source during connectors')
    await withWorkflow(a.ctx.files,c,async () => {
      const source = snapshot(a.ctx.files,c,rel,1024), epoch = policyGeneration(a.ctx.db)
      await Promise.all([svc.callTool(svc.forCall('bob',created.body.id),'search_tasks',{q:'synthetic'}), cf.sync(connected.id)])
      expect((a.ctx.db.query('SELECT last_used_at FROM integrations WHERE id=?').get(created.body.id) as any).last_used_at).not.toBeNull()
      expect((a.ctx.db.query('SELECT files FROM connected_folders WHERE id=?').get(connected.id) as any).files).toBe(1)
      expect(policyGeneration(a.ctx.db)).toBe(epoch)
      expect(() => recheck(a.ctx.files,c,source)).not.toThrow()
      a.ctx.db.query('UPDATE integrations SET version=version+1 WHERE id=?').run(created.body.id)
      expect(policyGeneration(a.ctx.db)).toBeGreaterThan(epoch)
      expect(() => recheck(a.ctx.files,c,source)).toThrow()
    })
  } finally { fake.stop(); await a.close(); fs.rmSync(home,{recursive:true,force:true}) }
})

test('R2-2: actual permission API revoke/restore during approval refuses publication', async () => {
  const a = await makeCApp('epoch-revoke-restore')
  try {
    const c = a.toolCtx('alice'), rel = 'shared/source.txt'
    fs.writeFileSync(path.join(a.team,rel), 'unchanged source')
    const source = snapshot(a.ctx.files,c,rel,1024)
    const folder = a.ctx.db.query("SELECT id FROM folders WHERE path='shared'").get() as {id:string}
    const before = policyGeneration(a.ctx.db)
    await expect(withWorkflow(a.ctx.files,c,() => publishArtifact(a.ctx,componentC(a.ctx).files,c,'shared/output.pptx',Buffer.from('new deck'),[source],async () => {
      for (const access of ['none','write']) {
        const r = await a.json(`/api/admin/folders/${folder.id}/rules`, {as:'carol',method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rules:[{subjectType:'everyone',subjectId:null,access}]})})
        expect(r.status).toBe(200)
      }
    }))).rejects.toThrow()
    expect(policyGeneration(a.ctx.db)).toBeGreaterThan(before + 1)
    expect(() => recheck(a.ctx.files,c,source)).toThrow()
    expect(fs.existsSync(path.join(a.team,'shared/output.pptx'))).toBe(false)
  } finally { await a.close() }
})

test('R2-2: independent writers preserve every ABA increment while bookkeeping interleaves', async () => {
  const a = await makeCApp('epoch-writers')
  try {
    const before = policyGeneration(a.ctx.db), dbfile = path.join(a.data,'app.db')
    const script = path.join(a.data,'writer.ts')
    fs.writeFileSync(script, `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[2]); db.exec('PRAGMA busy_timeout=10000'); for(let i=0;i<20;i++){ db.transaction(()=>{ db.exec(process.argv[3]==='policy' ? "UPDATE users SET status='disabled' WHERE id='bob'; UPDATE users SET status='active' WHERE id='bob'" : "UPDATE users SET last_seen_at=random() WHERE id='alice'") }).immediate() } db.close()`)
    const children = ['policy','bookkeeping'].map(kind => Bun.spawn([process.execPath,script,dbfile,kind],{stdout:'ignore',stderr:'pipe'}))
    expect(await Promise.all(children.map(p => p.exited))).toEqual([0,0])
    expect(policyGeneration(a.ctx.db)).toBe(before+40)
    const rolled = policyGeneration(a.ctx.db)
    expect(() => a.ctx.db.transaction(() => { a.ctx.db.exec("UPDATE users SET role='admin' WHERE id='bob'"); throw new Error('rollback') })()).toThrow('rollback')
    expect(policyGeneration(a.ctx.db)).toBe(rolled)
  } finally { await a.close() }
})
