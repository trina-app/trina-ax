// make_file docx: a picture in a Word file (the 2026-11-17 scenario catalog, EDIT-06: asked for the contract with the
// company seal next to its (인), the AI said a picture cannot go into a Word file and made a PDF). Markdown images
// already become pictures in a .docx; the tool's description now says so, how to size one, and that a picture for an
// existing Word file goes into a new .docx with its text (the original stays, its layout does not carry over, and the
// AI says so). Covered: the description, and a seal of a set width on the (인) line with no caption.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')
// a valid 1x1 grey PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')

let A: CApp
beforeAll(async () => {
  A = await makeCApp('c-make-file-docx-picture')
  fs.mkdirSync(file('shared/도장'), { recursive: true })
  fs.writeFileSync(file('shared/도장/회사직인.png'), PNG)
})
afterAll(async () => { await A.close() })

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown>) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  return (await h({ jsonrpc: '2.0', id: ++rpcId, method, params })).result
}
function file(rel: string) { return path.join(A.team, ...rel.split('/')) }
function unzip(rel: string, part: string): string {
  const out = fs.mkdtempSync(path.join(A.data, 'unzip-'))
  const r = Bun.spawnSync(['unzip', '-o', '-q', file(rel), '-d', out])
  if (r.exitCode !== 0) throw new Error('unzip failed')
  const p = path.join(out, part)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

describe('the description', () => {
  test('a picture (a seal, a logo, a photo) goes into a Word file: sized, and a new .docx for an existing one', async () => {
    const tools = (await rpc('tools/list', {})).tools as { name: string; description: string }[]
    const d = tools.find((t) => t.name === 'make_file')!.description
    expect(d).toContain('Pictures in Word')
    expect(d).toContain('![](shared/stamps/seal.png){width=3cm}')
    expect(d).toContain('make a new .docx')
    expect(d).toContain('not its layout, fonts, headers or footers: say so')
    expect(d).toContain('Never say a picture cannot go into a Word file')
    // what pandoc does not do in PowerPoint is not promised (a width is ignored there)
    expect(d).toContain('PowerPoint fits a picture to the slide and takes no width')
  })
})

describe.skipIf(!pandoc)('a seal beside the (인) line', () => {
  test('the .docx holds the picture at the width asked', async () => {
    const r = await rpc('tools/call', { name: 'make_file', arguments: {
      format: 'docx', output: 'users/alice/계약서-직인.docx',
      content: '# 물품공급계약서\n\n공급자 가나다오피스 주식회사 대표이사 김지우 (인) ![](shared/도장/회사직인.png){width=2cm}\n',
    } })
    expect(r.isError).toBeFalsy()
    const doc = unzip('users/alice/계약서-직인.docx', 'word/document.xml')
    expect(doc).toContain('(인)')
    expect(doc).toContain('<w:drawing>')
    // 2 cm = 720000 EMU (pandoc rounds down by one)
    expect(doc).toMatch(/<wp:extent cx="(719999|720000)"/)
    // on the line of its text, so no caption paragraph under it
    expect(doc).not.toContain('ImageCaption')
  })
})
