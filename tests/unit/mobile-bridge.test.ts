import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FileTransfers, type TransferIO } from '../../mobile/src/bridge'
import { googleOAuthUrl, MAX_FILE_BYTES, parseMessage, sameTeam, safeFileName, type FileMessage } from '../../mobile/src/protocol'
const base = { v: 1 as const, nonce: 'a'.repeat(64), generation: 1, id: 'transfer-123' }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const begin = (s: string): FileMessage => ({ ...base, type: 'file-begin', name: 'report.txt', mime: 'text/plain', size: Buffer.byteLength(s), sha256: hash(s) })
const chunk = (s: string, seq: number): FileMessage => ({ ...base, type: 'file-chunk', b64: Buffer.from(s).toString('base64'), seq })
function fixture(blockWrite = false) {
  let content = '', shared = 0, removed = 0, release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const io: TransferIO = {
    async create() { content = '' }, async append(_id, b64) { if (blockWrite) await gate; content += Buffer.from(b64, 'base64').toString() },
    async inspect() { return { size: Buffer.byteLength(content), sha256: hash(content) } },
    async share() { shared++ }, async remove() { content = ''; removed++ },
  }
  return { transfers: new FileTransfers(io, 100), release, shared: () => shared, removed: () => removed }
}
test('protocol accepts v1 bounded messages and rejects malformed/oversized structures', () => {
  expect(parseMessage(JSON.stringify(begin('hello')))).toEqual(begin('hello'))
  for (const value of [null, [], { ...begin('a'), v: 2 }, { ...begin('a'), size: MAX_FILE_BYTES + 1 },
    { ...begin('a'), sha256: 'bad' }, { ...chunk('a', 0), seq: -1 }, { ...chunk('a', 0), b64: '**' },
    { ...begin('a'), name: '../secret' }, { ...base, type: 'arbitrary-execute' }]) expect(parseMessage(JSON.stringify(value))).toBeNull()
})
test('origin checks reject opaque URLs, credentials and external origins; OAuth has an exact endpoint', () => {
  expect(sameTeam('https://team.example', 'https://team.example/files')).toBe(true)
  for (const u of ['https://evil.example', 'data:text/plain,a', 'about:blank', 'blob:https://team.example/id', 'https://x@team.example']) expect(sameTeam('https://team.example', u)).toBe(false)
  expect(googleOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?state=opaque')).toBe(true)
  for (const u of ['javascript:alert(1)', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://accounts.google.com/evil', 'https://u@accounts.google.com/o/oauth2/v2/auth']) expect(googleOAuthUrl(u)).toBe(false)
  expect(safeFileName('../../file.txt')).not.toContain('/')
})
test('async writes are serialized before end/hash/share and the cache is removed after share', async () => {
  const f = fixture(true)
  await f.transfers.receive(begin('firstsecond'))
  const first = f.transfers.receive(chunk('first', 0))
  const second = f.transfers.receive(chunk('second', 1))
  const end = f.transfers.receive({ ...base, type: 'file-end', seq: 2 })
  await Promise.resolve()
  expect(f.shared()).toBe(0)
  f.release(); await Promise.all([first, second, end])
  expect(f.shared()).toBe(1)
  expect(f.removed()).toBe(1)
})
test('duplicate/out-of-order chunks and wrong hash never reach sharing', async () => {
  for (const mode of ['sequence', 'hash'] as const) {
    const f = fixture()
    await f.transfers.receive(begin('expected'))
    if (mode === 'sequence') await expect(f.transfers.receive(chunk('expected', 2))).rejects.toThrow()
    else {
      await f.transfers.receive(chunk('tampered', 0))
      await expect(f.transfers.receive({ ...base, type: 'file-end', seq: 1 })).rejects.toThrow()
    }
    expect(f.shared()).toBe(0)
    expect(f.removed()).toBeGreaterThan(0)
  }
})
test('reset during an asynchronous write prevents queued end from sharing', async () => {
  const f = fixture(true)
  await f.transfers.receive(begin('a'))
  const pending = f.transfers.receive(chunk('a', 0)).catch(() => {})
  const end = f.transfers.receive({ ...base, type: 'file-end', seq: 1 }).catch(() => {})
  const cleared = f.transfers.clear()
  f.release(); await Promise.all([pending, end, cleared])
  expect(f.shared()).toBe(0)
  expect(f.removed()).toBeGreaterThan(0)
})

test('exact declared length, byte cap, duplicate begin and empty files are enforced', async () => {
  const f = fixture()
  await f.transfers.receive(begin('a'))
  await expect(f.transfers.receive(begin('a'))).rejects.toThrow()
  await expect(f.transfers.receive(chunk('too many bytes', 0))).rejects.toThrow()
  expect(f.shared()).toBe(0)
  await f.transfers.clear()
  await f.transfers.receive(begin(''))
  await f.transfers.receive({ ...base, type: 'file-end', seq: 0 })
  expect(f.shared()).toBe(1)
})

test('idle expiry removes a partially received file', async () => {
  const f = fixture()
  await f.transfers.receive(begin('a'))
  await Bun.sleep(130)
  await expect(f.transfers.receive(chunk('a', 0))).rejects.toThrow()
  expect(f.shared()).toBe(0)
  expect(f.removed()).toBeGreaterThan(0)
})
