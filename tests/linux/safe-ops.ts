import fs from 'node:fs'
import path from 'node:path'
import { setupServerCgroups } from '../../server/src/system/cgroups'
import { normalizeImage, pptxAst, renderPptx, validatePptx } from '../../server/src/safe-ops/runner'
import { referencePptx } from '../../server/src/safe-ops/reference'
import { makeCApp } from '../lib/c-app'
import { makeHandler } from '../../server/src/mcp/protocol'
const checks: { name: string; ok: boolean; detail?: string }[] = []
async function check(name: string, f: () => Promise<void> | void) {
  try {
    await f()
    checks.push({ name, ok: true })
  } catch (e) {
    checks.push({ name, ok: false, detail: String(e) })
  }
  console.log(JSON.stringify(checks.at(-1)))
}
function assert(v: unknown, msg = 'assertion failed'): asserts v {
  if (!v) throw new Error(msg)
}
const state = setupServerCgroups({ mode: 'prod' })
assert(state.state === 'delegated', JSON.stringify(state))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==',
  'base64',
)
await check('PNG decode under effective job limits', async () => {
  const b = await normalizeImage('png', png)
  assert(b[0] === 0xff && b[1] === 0xd8)
})
await check('HEIC primary image decode and normalization', async () => {
  const b = await normalizeImage('heic', fs.readFileSync('/fixtures/synthetic.heic'))
  assert(b[0] === 0xff && b[1] === 0xd8 && !b.includes(Buffer.from('Exif')) && b.length <= 1024 ** 2)
})
await check('WebP decode and normalization', async () => {
  const b = await normalizeImage('webp', fs.readFileSync('/fixtures/synthetic.webp'))
  assert(b[0] === 255 && b[1] === 216)
})
await check('format mismatch refused', async () => {
  let refused = false
  try {
    await normalizeImage('jpeg', png)
  } catch {
    refused = true
  }
  assert(refused)
})
await check('corrupt image refused', async () => {
  let refused = false
  try {
    await normalizeImage('png', Buffer.from('bad'))
  } catch {
    refused = true
  }
  assert(refused)
})
await check('cancel before admission', async () => {
  const c = new AbortController()
  c.abort()
  let refused = false
  try {
    await normalizeImage('png', png, c.signal)
  } catch {
    refused = true
  }
  assert(refused)
})
await check('bounded reference PPTX and actual slide/notes count', async () => {
  const ast = await pptxAst('/usr/bin/pandoc', '## One\n\nBody\n\n::: notes\nNote\n:::\n\n## Two\n\nBody')
  const b = await renderPptx('/usr/bin/pandoc', ast.toString(), 2, { 'reference.pptx': referencePptx() })
  const d = JSON.parse((await validatePptx(b)).toString())
  assert(
    d.slides.length === 2 && d.notes === 1 && d.slides.every((s: any) => s.layout === 'Title and Content'),
    JSON.stringify(d),
  )
})
const originalNative = process.env.MYCEL_NATIVE_BIN
if (fs.existsSync('/opt/safe1a-probe/mycel-safeops')) {
  process.env.MYCEL_NATIVE_BIN = '/opt/safe1a-probe'
  await check('private mount/network view, Landlock execution, seccomp namespace/listen', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 19728, fetch: () => new Response('synthetic') })
    try {
      const report = JSON.parse((await normalizeImage('png', Buffer.from('probe'))).toString())
      assert(
        Object.values(report).every((v) => v === true),
        JSON.stringify(report),
      )
    } finally {
      listener.stop(true)
    }
  })
  await check('hard per-job memory cap kills runaway helper', async () => {
    let refused = false
    try {
      await normalizeImage('png', Buffer.from('memory'))
    } catch {
      refused = true
    }
    assert(refused)
  })
  await check('hard scratch quota stops a full-disk writer', async () => {
    assert((await normalizeImage('png', Buffer.from('disk'))).toString() === 'disk-limited')
  })
  await check('cancellation kills a running helper', async () => {
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 100)
    try {
      let refused = false
      try {
        await normalizeImage('png', Buffer.from('spin'), abort.signal)
      } catch {
        refused = true
      }
      assert(refused)
    } finally {
      clearTimeout(timer)
    }
  })
  await check('wall timeout kills a running helper', async () => {
    const start = Date.now()
    let refused = false
    try {
      await normalizeImage('png', Buffer.from('spin'))
    } catch {
      refused = true
    }
    assert(refused && Date.now() - start < 25000)
  })
  process.env.MYCEL_NATIVE_BIN = originalNative
}
await check('ineffective aggregate limit fails closed', async () => {
  if (state.state !== 'delegated') throw new Error('no cgroup')
  fs.writeFileSync(path.join(state.conv.dir, 'memory.swap.max'), 'max')
  let refused = false
  try {
    await normalizeImage('png', png)
  } catch {
    refused = true
  }
  fs.writeFileSync(path.join(state.conv.dir, 'memory.swap.max'), '0')
  assert(refused)
})
await check('every per-job cgroup is reaped', () => {
  if (state.state === 'delegated')
    assert(
      fs.readdirSync(path.join(state.conv.dir, 'safe-ops-1a'), { withFileTypes: true }).filter((e) => e.isDirectory())
        .length === 0,
    )
})
await check('broker publishes a validated Korean PPTX and retains image provenance', async () => {
  const app = await makeCApp('safe-linux')
  try {
    app.ctx.files.cfg.ocr = null
    fs.copyFileSync('/fixtures/synthetic.png', path.join(app.team, 'users/alice/image.png'))
    const turn = app.turn('alice', app.chat('alice')),
      ctx = app.toolCtx('alice', turn)
    ctx.files.enginePid=process.pid // local synthetic engine for the direct broker test
    const handler = makeHandler(app.ctx.files, app.ctx.db, ctx)
    const result = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'make_file',
        arguments: {
          format: 'pptx',
          content: '## 합성 자료\n\n![그림](users/alice/image.png)',
          output: 'users/alice/safe.pptx',
          expected_slides: 1,
          expected_layouts: ['Title and Content'],
        },
      },
    })
    assert(!result.result.isError, JSON.stringify(result))
    assert(ctx.files.readPaths.has('users/alice/image.png'))
    const bytes = fs.readFileSync(path.join(app.team, 'users/alice/safe.pptx'))
    const deck = JSON.parse((await validatePptx(bytes)).toString())
    assert(deck.slides.length === 1 && deck.slides[0].title === '합성 자료')
    const image = await handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'read',
        arguments: { file_path: 'users/alice/image.png' },
      },
    })
    assert(image.result.content.some((c: any) => c.type === 'image' && c.mimeType === 'image/jpeg'))
    assert(ctx.files.imageSources.has('users/alice/image.png'))
  } finally {
    await app.close()
  }
})
console.log('SAFE_OPS_RESULT ' + JSON.stringify(checks))
process.exit(checks.some((c) => !c.ok) ? 1 : 0)
