// A download sends the file that its permission check saw (server/src/team-files/download.ts, place.ts openChecked).
// A personal folder is written by its person's dev environment runs too, at any time, so between the check and the
// sending a name can come to mean something else. The rule these tests keep: a link placed under a personal folder is
// never followed (not in the last name, not in a folder on the way), a hard link is refused, and the bytes that go out
// are read from the one descriptor that was checked, whatever happens to the name meanwhile.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { fileBody, lentDescriptors, streamFile } from '../../server/src/team-files/download'
import { openChecked } from '../../server/src/team-files/place'

const CHECKED = 'the file that was checked\n'.repeat(400)
const OTHER = 'a file that was never checked\n'.repeat(400)

let a: CApp
/** a folder outside the team folder, with a file named like the one in the personal folder */
let elsewhere: string
let n = 0

const mine = (rel: string) => path.join(a.team, 'users/alice', rel)
const url = (rel: string) => `/api/files/download?path=${encodeURIComponent('users/alice/' + rel)}`
/** a fresh folder in the personal folder with report.txt in it; returns the folder's name */
function folder(): string {
  const name = `case-${++n}`
  fs.mkdirSync(mine(name), { recursive: true })
  fs.writeFileSync(mine(`${name}/report.txt`), CHECKED)
  return name
}
/** the permission check of the download endpoint, as its own step */
const check = (rel: string) => componentC(a.ctx).files.fileForDownload('alice', 'users/alice/' + rel)
type Checked = ReturnType<typeof check>
const send = (f: Checked, o: { via?: string; range?: string } = {}) =>
  streamFile({ abs: f.abs, seen: f.st, name: f.name, req: new Request('http://team.localhost/x', { headers: o.range ? { range: o.range } : {} }), disposition: 'attachment', via: o.via })

/** the name now means a link to the other file */
function fileBecomesLink(dir: string) {
  fs.rmSync(mine(`${dir}/report.txt`))
  fs.symlinkSync(path.join(elsewhere, 'report.txt'), mine(`${dir}/report.txt`))
}
/** the folder on the way now is a link to the other folder; the checked file lives on under another name */
function folderBecomesLink(dir: string) {
  fs.renameSync(mine(dir), mine(`${dir}-kept`))
  fs.symlinkSync(elsewhere, mine(dir))
}
const CHANGES = { 'the file becomes a link': fileBecomesLink, 'a folder on the way becomes a link': folderBecomesLink } as const
const openCount = () => fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length

beforeAll(async () => {
  a = await makeCApp('download-checked-descriptor')
  elsewhere = path.join(a.data, 'elsewhere')
  fs.mkdirSync(elsewhere, { recursive: true })
  fs.writeFileSync(path.join(elsewhere, 'report.txt'), OTHER)
  fs.mkdirSync(mine(''), { recursive: true })
}, 120_000)
afterAll(async () => { await a?.close() }, 120_000)

describe('what is there when the download is asked for', () => {
  test('a regular file: whole, a range, and HEAD, with the same headers as before', async () => {
    const dir = folder()
    const whole = await a.req(url(`${dir}/report.txt`), { as: 'alice' })
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe(String(CHECKED.length))
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-disposition')).toStartWith('attachment;')
    expect(whole.headers.get('content-type')).toStartWith('text/plain')
    expect(await whole.text()).toBe(CHECKED)
    const part = await a.req(url(`${dir}/report.txt`), { as: 'alice', headers: { range: 'bytes=5-104' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 5-104/${CHECKED.length}`)
    expect(part.headers.get('content-length')).toBe('100')
    expect(await part.text()).toBe(CHECKED.slice(5, 105))
    const head = await a.req(url(`${dir}/report.txt`), { as: 'alice', method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(CHECKED.length))
    expect(head.headers.get('etag')).toBe(whole.headers.get('etag'))
  })

  test('a name stored in decomposed letters downloads (the path of the open file is compared as it is on disk)', async () => {
    const dir = folder()
    const stored = '분기 보고서.txt'.normalize('NFD')
    fs.writeFileSync(mine(`${dir}/${stored}`), CHECKED)
    for (const asked of [stored, stored.normalize('NFC')]) {
      const r = await a.req(url(`${dir}/${asked}`), { as: 'alice' })
      expect(r.status).toBe(200)
      expect(await r.text()).toBe(CHECKED)
    }
  })

  test('a link as the last name is refused', async () => {
    const dir = folder()
    fs.symlinkSync(path.join(elsewhere, 'report.txt'), mine(`${dir}/link.txt`))
    const r = await a.req(url(`${dir}/link.txt`), { as: 'alice' })
    expect(r.status).not.toBe(200)
    expect(await r.text()).not.toContain('never checked')
  })

  test('a folder on the way that is a link is refused', async () => {
    const dir = folder()
    fs.symlinkSync(elsewhere, mine(`${dir}/sub`))
    const r = await a.req(url(`${dir}/sub/report.txt`), { as: 'alice' })
    expect(r.status).not.toBe(200)
    expect(await r.text()).not.toContain('never checked')
  })

  test('a hard-linked file is refused', async () => {
    const dir = folder()
    fs.linkSync(path.join(elsewhere, 'report.txt'), mine(`${dir}/second-name.txt`))
    try {
      const r = await a.req(url(`${dir}/second-name.txt`), { as: 'alice' })
      expect(r.status).not.toBe(200)
      expect(await r.text()).not.toContain('never checked')
    } finally { fs.rmSync(mine(`${dir}/second-name.txt`)) }
  })
})

describe('the name changes between the check and the open', () => {
  for (const [what, change] of Object.entries(CHANGES)) {
    for (const via of [undefined, 'relay']) {
      test(`${what}: refused${via ? ' (through the team address)' : ''}`, async () => {
        const dir = folder()
        const f = check(`${dir}/report.txt`)
        change(dir)
        const r = await send(f, { via }).then((res) => res.text(), (e: unknown) => e)
        expect(r).toBeInstanceOf(Error)
      })
    }
    test(`${what}: a range is refused too`, async () => {
      const dir = folder()
      const f = check(`${dir}/report.txt`)
      change(dir)
      const r = await send(f, { range: 'bytes=0-99' }).then((res) => res.text(), (e: unknown) => e)
      expect(r).toBeInstanceOf(Error)
    })
  }

  test('another file is put under the name: refused (asking again sends the new file)', async () => {
    const dir = folder()
    const f = check(`${dir}/report.txt`)
    fs.writeFileSync(mine(`${dir}/new.txt`), OTHER)
    fs.renameSync(mine(`${dir}/new.txt`), mine(`${dir}/report.txt`))
    await expect(send(f)).rejects.toThrow()
    const again = await send(check(`${dir}/report.txt`))
    expect(await again.text()).toBe(OTHER)
  })
})

describe('the name changes after the open, before the body is read', () => {
  for (const [what, change] of Object.entries(CHANGES)) {
    for (const via of [undefined, 'relay']) {
      test(`${what}: the body is still the checked file${via ? ' (through the team address)' : ''}`, async () => {
        const dir = folder()
        const res = await send(check(`${dir}/report.txt`), { via })
        change(dir)
        expect(res.headers.get('content-length')).toBe(String(CHECKED.length))
        expect(await res.text()).toBe(CHECKED)
      })
    }
    test(`${what}: a range is still of the checked file`, async () => {
      const dir = folder()
      const res = await send(check(`${dir}/report.txt`), { range: 'bytes=5-104' })
      change(dir)
      expect(res.status).toBe(206)
      expect(await res.text()).toBe(CHECKED.slice(5, 105))
    })

    // every kind of body (file-body.test.ts), whatever this system would pick
    const KINDS = { 'Bun.file (Linux)': { sendfile: true }, 'read whole': { sendfile: false }, 'stream': { sendfile: false, wholeMax: 0 }, 'through the team address': { relayed: true } } as const
    for (const [kind, o] of Object.entries(KINDS)) {
      test(`${what}: ${kind}, whole and resumed to the end`, async () => {
        for (const start of [0, 7]) {
          const dir = folder()
          const f = check(`${dir}/report.txt`)
          const body = await fileBody(openChecked(f.abs, f.st).fd, start, CHECKED.length, o)
          change(dir)
          expect(await new Response(body).text()).toBe(CHECKED.slice(start))
        }
      })
    }

    test(`${what}: over a real socket, as a Bun.file body`, async () => {
      const dir = folder()
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch() {
          const f = check(`${dir}/report.txt`)
          const body = await fileBody(openChecked(f.abs, f.st).fd, 0, CHECKED.length, { sendfile: true })
          change(dir)
          return new Response(body, { headers: { 'content-length': String(CHECKED.length) } })
        },
      })
      try {
        const r = await fetch(`http://127.0.0.1:${server.port}/`)
        expect(r.headers.get('content-length')).toBe(String(CHECKED.length))
        expect(await r.text()).toBe(CHECKED)
      } finally { server.stop(true) }
    })
  }
})

describe('descriptors', () => {
  test('an answer without a body, a refused one and a body that was read leave nothing open', async () => {
    const dir = folder()
    const f = check(`${dir}/report.txt`)
    fs.writeFileSync(mine(`${dir}/empty.txt`), '')
    const empty = check(`${dir}/empty.txt`)
    const etag = (await send(f)).headers.get('etag')!
    await Bun.sleep(50)
    const before = openCount()
    const lent = lentDescriptors()
    for (let i = 0; i < 40; i++) {
      const req = (init: RequestInit) => streamFile({ abs: f.abs, seen: f.st, name: f.name, req: new Request('http://team.localhost/x', init), disposition: 'attachment', via: 'relay' })
      expect((await req({ method: 'HEAD' })).body).toBeNull()
      expect((await req({ headers: { 'if-none-match': etag } })).status).toBe(304)
      await expect(req({ headers: { range: 'bytes=999999-' } })).rejects.toThrow()
      expect(await (await send(empty)).text()).toBe('')
      expect(await (await req({})).text()).toBe(CHECKED)
      expect(await (await req({ headers: { range: 'bytes=0-9' } })).text()).toBe(CHECKED.slice(0, 10))
      await (await req({})).body!.cancel()
      expect(await new Response(await fileBody(openChecked(f.abs, f.st).fd, 0, CHECKED.length, { sendfile: false })).text()).toBe(CHECKED)
    }
    expect(lentDescriptors()).toBe(lent)
    expect(openCount() - before).toBeLessThan(10)
  })

  test('a Bun.file body borrows one descriptor, given back a little later', async () => {
    const dir = folder()
    const f = check(`${dir}/report.txt`)
    const lent = lentDescriptors()
    const body = await fileBody(openChecked(f.abs, f.st).fd, 0, CHECKED.length, { sendfile: true })
    expect(body).toBeInstanceOf(Blob)
    expect(lentDescriptors()).toBe(lent + 1)
    expect(await new Response(body).text()).toBe(CHECKED)
  })
})
