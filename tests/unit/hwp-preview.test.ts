import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { HWP_LIMITS as L } from '@mycel/shared/hwp'
import { NativeHwpEngine, HwpError, fontIdentity, type HwpEngine } from '../../server/src/files/hwp-engine'
import { HwpPreviews } from '../../server/src/files/hwp-preview'
import { preflight } from '../../server/src/files/hwp-preflight'
import { sha256 } from '../../server/src/files/store'
import { makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { makeHandler } from '../../server/src/mcp/protocol'
import { toolRegistry } from '../../server/src/tools/registry'
import { runIsolated } from '../../server/src/tools/isolate'

setDefaultTimeout(30000)
const previousHwpOptIn = process.env.MYCEL_HWP_PREVIEW
beforeAll(() => { process.env.MYCEL_HWP_PREVIEW = '1' })
afterAll(() => { if (previousHwpOptIn === undefined) delete process.env.MYCEL_HWP_PREVIEW; else process.env.MYCEL_HWP_PREVIEW = previousHwpOptIn })
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp', name))
let app: CApp
beforeAll(async () => { app = await makeCApp('hwp'); fs.writeFileSync(path.join(app.team, 'users/alice/test.hwp'), fixture('agreement.hwp')) })
afterAll(async () => { await app.close() })
const engine = new NativeHwpEngine()
for (const name of ['agreement.hwp','agreement.hwpx','notice.hwpx','synthetic-form.hwp','two-pages.hwp']) {
  test(`native isolated PNG: ${name}`, async () => {
    const r = await engine.render(fixture(name), name.endsWith('hwpx') ? 'hwpx' : 'hwp', 1)
    expect(r.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(r.meta.pageCount).toBe(name === 'two-pages.hwp' ? 2 : 1)
    expect(r.meta.width).toBeGreaterThan(100)
    expect(r.meta.sourceHash).toBe(sha256(fixture(name)))
    expect(r.meta.warnings).toContain('font_substitution')
  })
}
test('Noto internal metadata resolves the naming/weight ambiguity', () => {
  expect(fontIdentity(fs.readFileSync(path.join(import.meta.dir, '../../resources/hwp/fonts/NotoSansKR-Regular.ttf')))).toEqual({family:'Noto Sans KR',postscript:'NotoSansKR-Regular',weight:400})
})
for (const name of ['malformed-xml.hwpx','huge-table.hwpx','oversize-claim.hwpx']) test(`reject ${name}`, async () => {
  await expect(engine.render(fixture(name), 'hwpx', 1)).rejects.toBeInstanceOf(HwpError)
})
test('corrupt, truncated, huge, password and distribution documents fail closed', async () => {
  for (const bytes of [Buffer.from('junk'), fixture('agreement.hwp').subarray(0,150), Buffer.alloc(L.inputBytes+1)]) {
    await expect(engine.render(bytes,'hwp',1)).rejects.toBeInstanceOf(HwpError)
  }
  for (const [flag,reason] of [[2,'locked'],[4,'distribution']] as const) {
    const c = XLSX.CFB.read(fixture('agreement.hwp'), {type:'buffer'})
    const h = c.FileIndex.find((e: {name:string}) => e.name === 'FileHeader')!.content as Buffer
    h.writeUInt32LE(h.readUInt32LE(36) | flag,36)
    const b = Buffer.from(XLSX.CFB.write(c,{type:'buffer'}))
    expect(() => preflight(b,'hwp')).toThrow(reason)
    await expect(engine.render(b,'hwp',1)).rejects.toMatchObject({reason})
  }
})
test('page numbers are 1-based and bounded', async () => {
  for (const page of [0,2,201]) await expect(engine.render(fixture('agreement.hwp'),'hwp',page)).rejects.toMatchObject({reason:'limit'})
  const second = await engine.render(fixture('two-pages.hwp'),'hwp',2)
  expect(second.meta.page).toBe(2)
})
test('watchdog timeout and active cancellation terminate the converter', async () => {
  expect((await runIsolated({cmd:'/bin/sleep',args:['5'],timeoutMs:10,curatedFonts:true})).killed).toBe('timeout')
  const ctrl = new AbortController()
  const p = runIsolated({cmd:'/bin/sleep',args:['5'],signal:ctrl.signal,curatedFonts:true})
  setTimeout(()=>ctrl.abort(),30)
  expect((await p).killed).toBe('aborted')
  await expect(engine.render(fixture('agreement.hwp'),'hwp',1,ctrl.signal)).rejects.toMatchObject({reason:'cancelled'})
})
test('write and edit refuse HWP/HWPX including new mixed-case names', async () => {
  for (const [index, suffix] of ['hwp','hwpx','HWP','HwPx'].entries()) {
    const rel = `users/alice/refused-${index}.${suffix}`
    const r = await app.ctx.files.call('write',{file_path:rel,content:'plain text'},app.toolCtx('alice'))
    expect(r.isError).toBe(true); expect(fs.existsSync(path.join(app.team,rel))).toBe(false)
    fs.writeFileSync(path.join(app.team,rel),fixture('agreement.hwp'))
    const t=app.toolCtx('alice');t.files.readHashes.set(rel,sha256(fixture('agreement.hwp')))
    expect((await app.ctx.files.call('edit',{file_path:rel,old_string:'x',new_string:'y'},t)).isError).toBe(true)
    expect(sha256(fs.readFileSync(path.join(app.team,rel)))).toBe(sha256(fixture('agreement.hwp')))
  }
})

const fake = (hook?:()=>Promise<void>): HwpEngine & { calls:number } => ({identity:'fake-pinned-fonts',calls:0,async render(b,_ext,page){this.calls++;await hook?.();return {bytes:Buffer.from('png'),meta:{page,pageCount:2,width:100,height:200,sourceHash:sha256(b),engine:'fake',fonts:'fake',warnings:['layout_approximation']}}}})
test('authorized cache hits, guessed IDs, denied source and invalidation', async () => {
  const f = fake(), cache=new HwpPreviews(componentC(app.ctx).files,f), source='users/alice/test.hwp'
  const first=await cache.page('alice',source,1)
  expect((await cache.page('alice',source,1,undefined,first.id)).id).toBe(first.id)
  expect(f.calls).toBe(1)
  await expect(cache.page('bob',source,1,undefined,first.id)).rejects.toThrow()
  await expect(cache.page('alice',source,1,undefined,crypto.randomUUID())).rejects.toMatchObject({reason:'changed'})
  cache.invalidate()
  expect((await cache.page('alice',source,1)).id).not.toBe(first.id)
  fs.writeFileSync(path.join(app.team,source),fixture('synthetic-form.hwp'))
  expect((await cache.page('alice',source,1)).meta.sourceHash).toBe(sha256(fixture('synthetic-form.hwp')))
  fs.renameSync(path.join(app.team,source),path.join(app.team,'users/alice/moved.hwp'))
  await expect(cache.page('alice',source,1)).rejects.toThrow()
  fs.renameSync(path.join(app.team,'users/alice/moved.hwp'),path.join(app.team,source))
})
test('revoked access, replaced source and cancellation during rendering return no page', async () => {
  const source='users/alice/test.hwp'
  let finish!:()=>void
  let gate = new Promise<void>(resolve=>finish=resolve)
  const cache=new HwpPreviews(componentC(app.ctx).files,fake(()=>gate))
  const p=cache.page('alice',source,1)
  app.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run('alice')
  finish();await expect(p).rejects.toThrow()
  app.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run('alice')
  gate=new Promise<void>(resolve=>finish=resolve)
  const p2=cache.page('alice',source,1)
  fs.writeFileSync(path.join(app.team,source),fixture('agreement.hwp'))
  finish();await expect(p2).rejects.toMatchObject({reason:'changed'})
  gate=new Promise<void>(resolve=>finish=resolve)
  const ctrl=new AbortController(), p3=cache.page('alice',source,1,ctrl.signal)
  ctrl.abort();finish();await expect(p3).rejects.toMatchObject({reason:'cancelled'})
})
test('one active render per person and server; no unbounded queue', async () => {
  let finish!:()=>void
  const cache=new HwpPreviews(componentC(app.ctx).files,fake(()=>new Promise<void>(resolve=>finish=resolve)))
  const p=cache.page('alice','users/alice/test.hwp',1)
  await expect(cache.page('alice','users/alice/test.hwp',2)).rejects.toMatchObject({reason:'busy'})
  fs.writeFileSync(path.join(app.team,'users/bob/test.hwp'),fixture('agreement.hwp'))
  await expect(cache.page('bob','users/bob/test.hwp',1)).rejects.toMatchObject({reason:'busy'})
  finish();await p
})
for (const name of ['claude','codex']) test(`${name}: shared MCP contract carries image and metadata (fake engine)`, async () => {
  const c=componentC(app.ctx), old=c.hwp
  c.hwp=new HwpPreviews(c.files,fake())
  try {
    const turn=app.turn('alice',app.chat('alice')), t=app.toolCtx('alice',turn)
    const handler=makeHandler(app.ctx.files,app.ctx.db,t)
    const listed=await handler({jsonrpc:'2.0',id:1,method:'tools/list'})
    expect(listed.result.tools.some((x:{name:string})=>x.name==='hwp_render')).toBe(true)
    const r=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'hwp_render',arguments:{source:'users/alice/test.hwp',page:1,format:'png'}}})
    expect(r.result.content[1]).toMatchObject({type:'image',mimeType:'image/png',data:Buffer.from('png').toString('base64')})
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({page:1,pageCount:2,width:100,height:200,sourceHash:sha256(fixture('agreement.hwp'))})
    expect(t.files.readPaths.has('users/alice/test.hwp')).toBe(true)
    const viaTurn=app.ctx.services.turnTools!.find(x=>x.name==='hwp_render')!
    const r2=await viaTurn.call({source:'users/alice/test.hwp',page:1,format:'png'},{files:t} as any)
    expect(r2.content[1].type).toBe('image')
    expect((await toolRegistry(app.ctx.files).call('hwp_render',{source:'users/alice/test.hwp',page:0,format:'png'},t)).isError).toBe(true)
  } finally { c.hwp=old }
})
test('HTTP route: unauthorized, denied, valid PNG and no browser cache', async () => {
  const url='/api/files/hwp-preview?path=users%2Falice%2Ftest.hwp&page=1'
  expect((await app.req(url)).status).toBe(401)
  expect((await app.req(url,{as:'bob'})).status).toBe(404)
  const r=await app.json(url,{as:'alice'})
  expect(r.status).toBe(200);expect(r.res.headers.get('cache-control')).toContain('no-store')
  expect(r.body.page).toBe(1)
  expect(Buffer.from(r.body.png,'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
})

test('symlinks, hardlinks, traversal and a deleted cached source are refused', async () => {
  const source='users/alice/test.hwp', dir=path.join(app.team,'users/alice')
  const cache=new HwpPreviews(componentC(app.ctx).files,fake())
  fs.symlinkSync(path.join(dir,'test.hwp'),path.join(dir,'symlink.hwp'))
  await expect(cache.page('alice','users/alice/symlink.hwp',1)).rejects.toThrow()
  fs.linkSync(path.join(dir,'test.hwp'),path.join(dir,'hardlink.hwp'))
  await expect(cache.page('alice','users/alice/hardlink.hwp',1)).rejects.toThrow()
  fs.unlinkSync(path.join(dir,'hardlink.hwp'))
  await expect(cache.page('alice','../test.hwp',1)).rejects.toThrow()
  const r=await cache.page('alice',source,1)
  fs.unlinkSync(path.join(dir,'test.hwp'))
  await expect(cache.page('alice',source,1,undefined,r.id)).rejects.toThrow()
  fs.writeFileSync(path.join(dir,'test.hwp'),fixture('agreement.hwp'))
})

test('renderer isolation denies unrelated files, system fonts and network; stdout and disk are capped', async () => {
  const os=await import('node:os'), root=fs.mkdtempSync(path.join(os.tmpdir(),'hp-iso-'))
  const work=path.join(root,'work');fs.mkdirSync(work)
  const outside=path.join(root,'outside');fs.writeFileSync(outside,'private')
  const other = path.join(process.platform === 'darwin' ? '/private/var/tmp' : '/tmp', 'hwp-unrelated-' + crypto.randomUUID())
  fs.writeFileSync(other, 'synthetic private file')
  const script=path.join(work,'probe.js')
  const font=process.platform==='darwin'?'/System/Library/Fonts/Apple Color Emoji.ttc':'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  fs.writeFileSync(script,`import fs from 'node:fs'; for(const p of ${JSON.stringify([outside,font,other])}){try {fs.readFileSync(p);process.exit(9)}catch{}} try{await fetch('https://1.1.1.1',{signal:AbortSignal.timeout(500)});process.exit(8)}catch{} console.log('denied')`)
  try {
    const r=await runIsolated({cmd:process.execPath,args:[script],workDir:work,curatedFonts:true,timeoutMs:2000})
    expect(r.code).toBe(0);expect(r.stdout.toString().trim()).toBe('denied')
    fs.writeFileSync(script,"console.log('x'.repeat(10000))")
    expect((await runIsolated({cmd:process.execPath,args:[script],workDir:work,maxStdout:100,curatedFonts:true})).killed).toBe('output')
    fs.writeFileSync(script,"await Bun.write('output',new Uint8Array(1024*1024));await Bun.sleep(5000)")
    expect((await runIsolated({cmd:process.execPath,args:[script],workDir:work,maxWorkBytes:10000,curatedFonts:true})).killed).toBe('disk')
  } finally {fs.rmSync(root,{recursive:true,force:true});fs.rmSync(other,{force:true})}
})

test('startup rejects absent and tampered binaries before any document is processed', async () => {
  const os=await import('node:os'), dir=fs.mkdtempSync(path.join(os.tmpdir(),'hp-pin-'))
  try {
    await expect(new NativeHwpEngine(dir).ready).rejects.toMatchObject({reason:'engine'})
    fs.mkdirSync(path.join(dir,'native/bin/hwp'),{recursive:true})
    fs.writeFileSync(path.join(dir,'native/bin/hwp',`rhwp-${process.platform}-${process.arch}`),'not the pinned executable')
    await expect(new NativeHwpEngine(dir).ready).rejects.toMatchObject({reason:'engine'})
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
