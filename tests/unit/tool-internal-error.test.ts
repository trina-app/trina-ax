// A tool call's error that is not a refusal (tools/internal-error.ts; WSL QA 2026-11-28: save_work_file, copy_files and
// make_file answered "internal error" five times with nothing in the server log, and the AI sent the user to Admin ›
// System › Storage on a disk 1% used). Covers: the error is logged once with the tool, the turn and a reference the AI
// is given; a temporary failure (EAGAIN, ENOMEM, a locked database) is named as one; the storage sentence appears only
// as measured (room: "not a storage problem"; full: "may be the cause"; not measured: nothing); a batch item's reason
// is logged too; a converter whose start is refused for want of memory or processes is started again.
import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { ToolRegistry } from '../../server/src/tools/registry'
import { internalErrorText, internalWhy, setInternalErrorLog, storageLine, transientCode } from '../../server/src/tools/internal-error'
import { spawnRetrying, spawnShortOf } from '../../server/src/tools/isolate'
import { configureStorageGuard } from '../../server/src/system/storage'
import { setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { silentLogger, type Logger } from '../../server/src/log'

const GiB = 1024 ** 3
const lines: { msg: string; fields?: Record<string, unknown> }[] = []
const capture: Logger = { debug() {}, info() {}, warn: (msg, fields) => { lines.push({ msg, fields }) }, error: (msg, fields) => { lines.push({ msg, fields }) }, child: () => capture }
const disk = (freeGiB: number) => configureStorageGuard({ root: '/', statfs: () => ({ bsize: 4096, blocks: 100 * GiB / 4096, bfree: freeGiB * GiB / 4096, bavail: freeGiB * GiB / 4096 }) as any, enforce: () => true })
const errno = (code: string, message = `${code}: failed`) => Object.assign(new Error(message), { code })

afterEach(() => { lines.length = 0; setInternalErrorLog(silentLogger); configureStorageGuard(null); setLimitsPlatformForTests(null); setPlanForTests(undefined) })

test('a tool that throws: logged with tool, turn and reference; the AI gets the reference, the kind and the storage as measured', async () => {
  setInternalErrorLog(capture)
  setLimitsPlatformForTests('linux'); setPlanForTests(null)
  disk(99)
  const r = new ToolRegistry()
  r.register({ name: 'boom', description: 'x', input: z.object({}), run: () => { throw errno('EAGAIN', 'posix_spawn failed: EAGAIN') } })
  const out = await r.call('boom', {}, { user: { id: 'u1' } as any, turnId: 't1' } as any)
  expect(out.isError).toBe(true)
  expect(out.text).toContain('a temporary problem on the server (EAGAIN)')
  expect(out.text).toContain('not a storage problem')
  expect(out.text).not.toMatch(/may be the cause/)
  expect(out.summary).toContain('internal: posix_spawn failed')
  expect(lines).toHaveLength(1)
  const ref = /ref ([0-9a-f]{8})/.exec(out.text)![1]
  expect(lines[0]!.fields).toMatchObject({ tool: 'boom', ref, turnId: 't1', userId: 'u1', code: 'EAGAIN' })
  expect(String((lines[0]!.fields!.err as Error).message)).toContain('posix_spawn')
})

test('the storage sentence only as measured: full says so, not measured says nothing', () => {
  setLimitsPlatformForTests('linux'); setPlanForTests(null)
  disk(0.1)
  expect(storageLine()).toMatch(/full, which may be the cause/)
  configureStorageGuard(null)
  expect(storageLine()).toBe('')
  const plain = internalErrorText('write', new Error('something odd'))
  expect(plain).toContain('an unexpected error on the server')
  expect(plain).not.toMatch(/storage/i)
  expect(plain).toContain('Try the same call once more')
})

test('temporary failures are told apart from other errors', () => {
  expect(transientCode(errno('ENOMEM'))).toBe('ENOMEM')
  expect(transientCode(errno('EBUSY'))).toBe('EBUSY')
  expect(transientCode(errno('SQLITE_BUSY_SNAPSHOT'))).toBe('SQLITE_BUSY')
  expect(transientCode(new Error('database is locked'))).toBe('SQLITE_BUSY')
  expect(transientCode(errno('ENOENT'))).toBeNull()
  expect(transientCode(new TypeError('x is undefined'))).toBeNull()
})

test('a batch item\'s reason is logged and carries the reference', () => {
  setInternalErrorLog(capture)
  const why = internalWhy('copy_files', errno('EMFILE'), { turnId: 't2' })
  expect(why).toMatch(/^a temporary problem on the server \(EMFILE, ref [0-9a-f]{8}\); try it again$/)
  expect(internalWhy('copy_files', new Error('odd'))).toMatch(/^internal error \(ref [0-9a-f]{8}\)$/)
  expect(lines).toHaveLength(2)
  expect(lines[0]!.fields).toMatchObject({ tool: 'copy_files', turnId: 't2' })
})

test('a converter start refused for want of memory or processes is tried again; other errors are not', async () => {
  let n = 0
  expect(await spawnRetrying(() => { if (++n < 3) throw errno('EAGAIN'); return 'started' }, [1, 1])).toBe('started')
  expect(n).toBe(3)
  n = 0
  await expect(spawnRetrying(() => { n++; throw errno('ENOMEM') }, [1, 1])).rejects.toThrow('ENOMEM')
  expect(n).toBe(3)
  n = 0
  await expect(spawnRetrying(() => { n++; throw errno('ENOENT') }, [1, 1])).rejects.toThrow('ENOENT')
  expect(n).toBe(1)
  expect(spawnShortOf(new Error('spawn failed: EAGAIN'))).toBe(true)
  expect(spawnShortOf(errno('EACCES'))).toBe(false)
})
