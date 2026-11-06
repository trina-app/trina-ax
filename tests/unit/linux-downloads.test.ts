// scripts/linux/downloads.ts cachedDownload: a pinned download tries again after a network error or an HTTP 5xx answer
// (a socket reset on a large file failed a release build), stops at once on other HTTP errors, and checks the hash
// after the download. Fake fetch, temp cache folder; no real network.
import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cachedDownload } from '../../scripts/linux/downloads'

const body = new TextEncoder().encode('pinned bytes')
const sha256 = crypto.createHash('sha256').update(body).digest('hex')
const table = { 'x.bin': { url: 'https://example.test/x.bin', sha256 } } as never
const dirs: string[] = []
const cacheDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function fake(answers: (() => Response)[]) {
  let n = 0
  const f = (async () => { const a = answers[Math.min(n++, answers.length - 1)]!; return a() }) as unknown as typeof fetch
  return { f, calls: () => n }
}
const reset = () => { throw Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'ECONNRESET' }) }

test('a network reset, then the file: the download succeeds on the next try', async () => {
  const dir = cacheDir(); const k = fake([reset, () => new Response(body)])
  const f = await cachedDownload('x.bin', { table, cacheDir: dir, fetchImpl: k.f, waitMs: 1 })
  expect(fs.readFileSync(f)).toEqual(Buffer.from(body))
  expect(k.calls()).toBe(2)
  expect(fs.existsSync(`${f}.part`)).toBe(false)
})

test('an HTTP 503, then the file: the download succeeds', async () => {
  const k = fake([() => new Response('busy', { status: 503 }), () => new Response(body)])
  await cachedDownload('x.bin', { table, cacheDir: cacheDir(), fetchImpl: k.f, waitMs: 1 })
  expect(k.calls()).toBe(2)
})

test('the network fails every time: the error comes after the last try', async () => {
  const k = fake([reset])
  await expect(cachedDownload('x.bin', { table, cacheDir: cacheDir(), fetchImpl: k.f, tries: 3, waitMs: 1 })).rejects.toThrow('closed unexpectedly')
  expect(k.calls()).toBe(3)
})

test('an HTTP 404 stops at once', async () => {
  const k = fake([() => new Response('no', { status: 404 })])
  await expect(cachedDownload('x.bin', { table, cacheDir: cacheDir(), fetchImpl: k.f, waitMs: 1 })).rejects.toThrow('HTTP 404')
  expect(k.calls()).toBe(1)
})

test('a wrong file is not downloaded again: the hash error comes at once and the file is removed', async () => {
  const dir = cacheDir(); const k = fake([() => new Response('other bytes')])
  await expect(cachedDownload('x.bin', { table, cacheDir: dir, fetchImpl: k.f, waitMs: 1 })).rejects.toThrow('SHA-256')
  expect(k.calls()).toBe(1)
  expect(fs.existsSync(path.join(dir, 'x.bin'))).toBe(false)
})
