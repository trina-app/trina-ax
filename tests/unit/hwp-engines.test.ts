// Actual Claude/Codex launch adapters, gate and MCP bridge; deterministic fake model processes, real native renderer.
import { beforeAll, afterAll, expect, test, setDefaultTimeout } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness } from '../lib/b-harness'
setDefaultTimeout(30000)
const previousHwpOptIn = process.env.MYCEL_HWP_PREVIEW
beforeAll(() => { process.env.MYCEL_HWP_PREVIEW = '1' })
afterAll(() => { if (previousHwpOptIn === undefined) delete process.env.MYCEL_HWP_PREVIEW; else process.env.MYCEL_HWP_PREVIEW = previousHwpOptIn })
for (const engine of ['claude-code','codex'] as const) test(`hwp_render image reaches ${engine} through its real launch and MCP bridge`, async () => {
  const h=await startHarness({name:`hwp-${engine}`,turnTimeoutMs:20000})
  const socket=await h.ws('alice',{windowId:'hwp-engine-window'})
  try {
    await socket.next('hello')
    const source='users/alice/page.hwp'
    fs.copyFileSync(path.join(import.meta.dir,'../fixtures/hwp/agreement.hwp'),path.join(h.team,source))
    const chat=await h.api('alice').call(API.createChat,{body:{engine}})
    const result=await ask(h,socket,'alice',chat.id,'@fake '+JSON.stringify({tool:'hwp_render',args:{source,page:1,format:'png'},inspectImages:true,sayResult:true}))
    expect(result.done.status).toBe('done')
    const received=JSON.parse(result.done.content)
    expect(received.images).toEqual([{mimeType:'image/png',magic:'89504e470d0a1a0a'}])
    expect(JSON.parse(received.text)).toMatchObject({page:1,pageCount:1,engine:'rhwp-0.8.7'})
    expect(h.ctx.db.query("SELECT ok FROM tool_events WHERE tool='hwp_render'").all()).toEqual([{ok:1}])
  } finally {socket.close();await h.close()}
})
