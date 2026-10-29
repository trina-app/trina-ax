import { test, expect, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { makeCApp } from '../lib/c-app'
import { SearchAdmission } from '../../server/src/files/search-admission'
import { SemanticIndex } from '../../server/src/search/semantic'
import { sha256 } from '../../server/src/files/store'

test('R3: empty-ledger live search blocks first quarantine on an independent connection in both passes', async () => {
  const a = await makeCApp('r3-empty-search'), q = a.ctx.files.quarantine
  const bytes = Buffer.from('R3_EMPTY_ALLOWED'), abs = path.join(a.team, 'shared/live.txt')
  fs.writeFileSync(abs, bytes)
  const other = new Database(path.join(a.data, 'app.db')), spawn = Bun.spawn.bind(Bun)
  let passes = 0
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], opts: any) => {
    if (argv[0] === a.ctx.files.cfg.rg && !argv.includes('--files') && !argv.includes('*.txt')) {
      passes++
      expect(opts.cwd).toBe(a.team)
      expect(() => other.query('INSERT INTO safe_ops_artifacts(hash,size,kind) VALUES(?,?,?)').run(sha256(bytes), bytes.length, 'image')).toThrow('safe_ops_search_busy')
      expect(() => q.add(bytes, 'pptx')).toThrow('active search')
      // Copy/rename/replacement cannot introduce registered output while the
      // ledger is empty: registration necessarily precedes publication.
      fs.copyFileSync(abs, abs + '.tmp'); fs.renameSync(abs + '.tmp', abs)
    }
    return spawn(argv, opts)
  }) as typeof Bun.spawn)
  try {
    const result = await a.ctx.files.grep(a.toolCtx('bob'), {path:'shared', pattern:'R3_EMPTY', output_mode:'content'})
    expect(result.text).toContain('R3_EMPTY_ALLOWED'); expect(passes).toBe(2)
    expect(fs.existsSync(path.join(a.data, 'search-inputs'))).toBe(false)
    expect(other.query('SELECT * FROM safe_ops_empty_searches').all()).toEqual([])
    q.add(bytes, 'image')
    passes = 0; spy.mockRestore()
    const next = await a.ctx.files.grep(a.toolCtx('bob'), {path:'shared', pattern:'R3_EMPTY', output_mode:'content'})
    expect(next.text).toBe('No matches')
  } finally { spy.mockRestore(); other.close(); await a.close() }
})

test('R3: empty admission loses to existing quarantine; dead owners have no automatic expiry', async () => {
  const a = await makeCApp('r3-empty-crash'), q = a.ctx.files.quarantine, dbfile = path.join(a.data, 'app.db')
  const script = path.join(a.data, 'lease.ts')
  fs.writeFileSync(script, `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[2]); db.query('INSERT INTO safe_ops_empty_searches(lease,owner_pid) VALUES(?,?)').run('orphan',process.pid)`)
  try {
    expect(Bun.spawnSync([process.execPath, script, dbfile]).exitCode).toBe(0)
    expect(() => q.add(Buffer.from('first artifact'), 'image')).toThrow('active search')
    // This test knows its child exited and started no consumers. Production
    // recovery instead requires offline shutdown of all service descendants.
    a.ctx.db.exec("DELETE FROM safe_ops_empty_searches WHERE lease='orphan'")
    q.add(Buffer.from('first artifact'), 'image')
    const lease = new SearchAdmission(q)
    expect(lease.emptyLedger()).toBe(false)
    expect(() => a.ctx.db.query('INSERT INTO safe_ops_empty_searches(lease,owner_pid) VALUES(?,?)').run('forged',process.pid)).toThrow('safe_ops_quarantined')
    lease.close()
  } finally { await a.close() }
})

test('R3: cancelled and invalid-pattern live searches release only after rg exits', async () => {
  const a = await makeCApp('r3-empty-cancel')
  try {
    fs.writeFileSync(path.join(a.team,'shared/live.txt'), 'normal text')
    const c = a.toolCtx('bob'); c.signal = AbortSignal.abort()
    await a.ctx.files.grep(c, {path:'shared',pattern:'normal'}).catch(() => {})
    await expect(a.ctx.files.grep(a.toolCtx('bob'), {path:'shared',pattern:'['})).rejects.toThrow('invalid pattern')
    expect(a.ctx.db.query('SELECT * FROM safe_ops_empty_searches').all()).toEqual([])
  } finally { await a.close() }
})

test('R3: replaced Office source cannot relabel cached quarantined text for grep or embedding', async () => {
  const a = await makeCApp('r3-office-source'), rel = 'shared/old.docx', abs = path.join(a.team,rel)
  const original = Buffer.from('synthetic original document before quarantine'), marker = 'R3_OLD_QUARANTINED_SOURCE'
  const office = a.ctx.files.office as typeof a.ctx.files.office & {extract: (rel:string, bytes:Buffer)=>Promise<string>}
  const extract = office.extract, stamp = new Date(1700000000000)
  fs.writeFileSync(abs,original); fs.utimesSync(abs,stamp,stamp)
  office.extract = async () => marker
  let index: SemanticIndex | undefined
  try {
    await office.update(rel)
    a.ctx.files.quarantine.add(original,'pptx')
    fs.unlinkSync(abs); fs.writeFileSync(abs,'replacement clean document'); fs.utimesSync(abs,stamp,stamp)
    office.extract = async () => 'replacement clean extracted text'
    const result = await a.ctx.files.grep(a.toolCtx('bob'), {path:'shared',pattern:marker,output_mode:'content'})
    expect(result.text).not.toContain(marker)
    let embedded = false
    index = new SemanticIndex({dataDir:a.data,root:a.team,office,quarantine:a.ctx.files.quarantine,
      embedder:async()=>async texts => { embedded ||= texts.some(t=>t.includes(marker)); return texts.map(()=>new Float32Array(384)) }})
    await index.refresh(30000)
    expect(embedded).toBe(false)
  } finally { index?.db.close(); office.extract=extract; await a.close() }
})

test('R3: mismatched text/provenance from concurrent cache writers is refused before consumption', async () => {
  const a = await makeCApp('r3-office-cache-race'), rel='shared/report.docx',abs=path.join(a.team,rel)
  const office=a.ctx.files.office as typeof a.ctx.files.office & {extract:(rel:string,bytes:Buffer)=>Promise<string>}
  const original=Buffer.from('source A'),extract=office.extract,lease=new SearchAdmission(a.ctx.files.quarantine)
  fs.writeFileSync(abs,original);office.extract=async()=>'text A'
  try {
    await office.update(rel)
    expect(office.admittedText(rel,original,lease)?.bytes.toString()).toBe('text A')
    fs.writeFileSync(office.cachePath(rel),'text from another extraction')
    expect(office.admittedText(rel,original,lease)).toBeNull()
    fs.writeFileSync(office.cachePath(rel),'text A')
    expect(office.admittedText(rel,Buffer.from('replacement source'),lease)).toBeNull()
  } finally { lease.close();office.extract=extract;await a.close() }
})

test('R3: every actual policy column changes and restores its epoch; bookkeeping values do neither', async () => {
  const a=await makeCApp('r3-epoch-every-column'),db=a.ctx.db
  const policy:Record<string,string>={
    users:'id username password_hash role status must_change_password deleted_at temp_password_expires_at',
    groups:'id folder_id',group_members:'group_id user_id',folders:'id path',
    folder_rules:'id folder_id subject_type subject_id access',
    integrations:'id scope owner_user_id kind slug url auth auth_header secret_enc key_version account write_policy status tools_json version',
    integration_access:'integration_id subject_type subject_id',connected_folders:'id name source',
  }
  const epoch=()=> (db.query('SELECT generation FROM safe_ops_policy WHERE id=1').get() as {generation:number}).generation
  try {
    db.exec("INSERT INTO integrations(id,scope,owner_user_id,kind,name,slug,url,auth,status,created_at,updated_at) VALUES('r3','personal','alice','mcp','R3','r3','http://synthetic.invalid','none','connected','now','now'); INSERT INTO integration_access(integration_id,subject_type,subject_id) VALUES('r3','user','alice'); INSERT INTO connected_folders(id,name,source) VALUES('r3','r3','/synthetic')")
    // Change keys in rollback-only transactions without cascading fixture rows.
    // FK enforcement is independently tested by the database suite.
    db.exec('PRAGMA foreign_keys=OFF')
    for(const [table,fields] of Object.entries(policy)) {
      const row=db.query(`SELECT rowid AS rid,* FROM ${table} LIMIT 1`).get() as Record<string,any>
      const columns=(db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name)
      for(const column of columns) {
        const before=epoch(),old=row[column],bearing=fields.split(' ').includes(column)
        let value:any=typeof old==='number'?old+1:old===null?'r3-value':old+'-r3'
        const alternatives:Record<string,string[]>={role:['member','admin'],status:table==='users'?['active','disabled']:['connected','error'],kind:['mcp','http'],auth:['none','bearer'],write_policy:['ask','deny'],subject_type:['user','group'],access:['none','write'],scope:['personal','team']}
        if(alternatives[column])value=alternatives[column].find(v=>v!==old)
        const scope=table==='integrations' && column==='scope'
        db.exec('BEGIN')
        try {
          db.query(`UPDATE ${table} SET ${column}=?${scope?',owner_user_id=NULL':''} WHERE rowid=?`).run(value,row.rid)
          expect(epoch(),table+'.'+column+' change').toBe(before+Number(bearing))
          db.query(`UPDATE ${table} SET ${column}=?${scope?",owner_user_id='alice'":''} WHERE rowid=?`).run(old,row.rid)
          expect(epoch(),table+'.'+column+' restore').toBe(before+2*Number(bearing))
        } finally {db.exec('ROLLBACK')}
        expect(epoch()).toBe(before)
      }
    }
  } finally {db.exec('PRAGMA foreign_keys=ON');await a.close()}
})
