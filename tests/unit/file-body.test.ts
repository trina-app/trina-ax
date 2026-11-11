// fileBody (server/src/team-files/download.ts): the body of a whole-file download or a download resumed to the end.
// Linux keeps Bun.file (sendfile); elsewhere (macOS) never sendfile, because XNU's sendfile can park the server's only
// JS thread in the kernel while a client reads slowly (QA TC-222): a file up to WHOLE_MAX is read whole (it keeps its
// Content-Length), a bigger one goes as our stream. All three must send exactly the same bytes, and a client that stops
// reading must not stop the server from answering others. (The freeze itself needs a file that is not in memory and a
// macOS kernel short of buffers; it was reproduced by hand, see the plan of fix/slow-download-freeze.)
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileBody, SENDFILE, streamFile, WHOLE_MAX } from '../../server/src/team-files/download'

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-filebody-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))

function makeFile(name: string, size: number): { abs: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) % 256)
  const abs = path.join(W, name)
  fs.writeFileSync(abs, bytes)
  return { abs, bytes }
}

const KINDS = {
  'Bun.file (Linux)': { sendfile: true },
  'read whole (macOS, up to WHOLE_MAX)': { sendfile: false },
  'stream (macOS, bigger files)': { sendfile: false, wholeMax: 0 },
} as const

describe('fileBody', () => {
  test('sendfile (Bun.file) only on Linux; elsewhere bytes in memory up to 256 MB, then a stream', async () => {
    expect(SENDFILE).toBe(process.platform === 'linux')
    expect(WHOLE_MAX).toBe(256 * 1024 * 1024)
    const { abs } = makeFile('kind.bin', 10)
    expect(await fileBody(abs, 0, 10, KINDS['Bun.file (Linux)'])).toBeInstanceOf(Blob)
    expect(await fileBody(abs, 0, 10, KINDS['read whole (macOS, up to WHOLE_MAX)'])).toBeInstanceOf(Uint8Array)
    expect(await fileBody(abs, 0, 10, KINDS['stream (macOS, bigger files)'])).toBeInstanceOf(ReadableStream)
  })

  for (const [kind, o] of Object.entries(KINDS)) {
    test(`exact bytes for a whole file and a tail: ${kind}`, async () => {
      // several read pieces, not a multiple of one
      const { abs, bytes } = makeFile(`exact-${o.sendfile}-${'wholeMax' in o}.bin`, 9 * 1024 * 1024 + 123)
      const whole = new Uint8Array(await new Response(await fileBody(abs, 0, bytes.length, o)).arrayBuffer())
      expect(whole.length).toBe(bytes.length)
      expect(Buffer.from(whole).equals(Buffer.from(bytes))).toBe(true)
      const start = 1024 * 1024 + 5
      const tail = new Uint8Array(await new Response(await fileBody(abs, start, bytes.length, o)).arrayBuffer())
      expect(Buffer.from(tail).equals(Buffer.from(bytes.subarray(start)))).toBe(true)
    })
  }

  test('without sendfile the body never runs past the size the caller announced (the file grew after the stat)', async () => {
    for (const o of [KINDS['read whole (macOS, up to WHOLE_MAX)'], KINDS['stream (macOS, bigger files)']]) {
      const { abs, bytes } = makeFile(`grows-${'wholeMax' in o}.bin`, 5000)
      const body = await fileBody(abs, 0, bytes.length, o)
      fs.appendFileSync(abs, new Uint8Array(3000).fill(1))
      const got = new Uint8Array(await new Response(body).arrayBuffer())
      expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true)
    }
  })

  test('a link is refused like a range (opened without following links)', async () => {
    const { abs } = makeFile('target.bin', 100)
    const link = path.join(W, 'link.bin')
    fs.symlinkSync(abs, link)
    await expect(fileBody(link, 0, 100, KINDS['read whole (macOS, up to WHOLE_MAX)'])).rejects.toThrow()
    await expect(fileBody(link, 0, 100, KINDS['stream (macOS, bigger files)'])).rejects.toThrow()
  })

  test('streamFile: a whole file keeps its headers and its Content-Length over a real socket', async () => {
    const { abs, bytes } = makeFile('report.pdf', 300_000)
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => streamFile({ abs, name: 'report.pdf', req, disposition: 'attachment' }) })
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-length')).toBe('300000')
      expect(r.headers.get('accept-ranges')).toBe('bytes')
      expect(r.headers.get('content-disposition')).toStartWith('attachment;')
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
      const head = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'HEAD' })
      expect(head.headers.get('content-length')).toBe('300000')
    } finally { server.stop(true) }
  })

  for (const kind of ['read whole (macOS, up to WHOLE_MAX)', 'stream (macOS, bigger files)'] as const) {
    test(`over a real socket, ${kind}: a client that stops reading does not stop the server answering others`, async () => {
      const { abs, bytes } = makeFile(`big-${kind.length}.bin`, 48 * 1024 * 1024)
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(req) {
          if (new URL(req.url).pathname === '/health') return new Response('ok')
          return new Response(await fileBody(abs, 0, bytes.length, KINDS[kind]))
        },
      })
      const stuck = net.connect(server.port!, '127.0.0.1')
      try {
        await new Promise<void>((ok) => stuck.once('connect', () => ok()))
        stuck.write('GET /file HTTP/1.1\r\nHost: x\r\n\r\n')
        // read the head only, then stop reading (the socket and the server's send buffer fill up)
        await new Promise<void>((ok) => stuck.once('data', () => { stuck.pause(); ok() }))
        await Bun.sleep(300)
        for (let i = 0; i < 5; i++) {
          const t = performance.now()
          expect(await (await fetch(`http://127.0.0.1:${server.port}/health`)).text()).toBe('ok')
          expect(performance.now() - t).toBeLessThan(1000)
        }
        // a client that reads gets the whole file, the same bytes
        const full = await fetch(`http://127.0.0.1:${server.port}/file`)
        expect(Buffer.from(await full.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
      } finally {
        stuck.destroy()
        server.stop(true)
      }
    })
  }
})
