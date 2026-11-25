// Apps on the computer on Windows: the words people and the AI get when a program does not start (QA on 0.18.0,
// TC-9006..9009). The real reason, the app's download page, and one list of refused characters that the splitter, the
// desktop app and the words all read, so they never say different things.
import { describe, expect, test } from 'bun:test'
import { BATCH_REFUSED, COMMAND_REFUSED, LOCAL_APP_PRESETS, splitCommand, type LocalAppSpec, type LocalResult } from '@mycel/shared/api'
import { cmdLaunch, launchFor, type ProgramHost } from '../../desktop/src/common/programs'
import { LocalError, localTransport, notReadyWords } from '../../server/src/integrations/connections/local'
import { reasonText } from '../../server/src/integrations/connections/text'
import { en } from '../../web/src/i18n/en'

const INIT = { jsonrpc: '2.0', id: 'i1', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
const EGO = LOCAL_APP_PRESETS.find((p) => p.id === 'ego-lite')!.spec
const relay = (r: Partial<LocalResult>) => ({ windowAlive: () => true, call: async () => ({ callId: 'x', ok: false, ...r }) }) as never
const send = (spec: LocalAppSpec, r: Partial<LocalResult>, name = 'Tool') => localTransport({ relay: relay(r), userId: 'u', via: { windowId: 'w', turnId: null }, row: { id: 'c', name }, spec })('https://local-app.invalid/c', { method: 'POST', headers: [], body: Buffer.from(JSON.stringify(INIT)) } as never)
const mcp = (command: string): LocalAppSpec => ({ adapter: 'mcp', command, args: [], env: [] })
const host: ProgramHost = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, home: 'C:\\Users\\u', isFile: () => true, isExecutable: () => true, readText: () => null }

describe('TC-9006: an app that is not installed: the AI gives its download page', () => {
  test('before anyone asks (no tools yet), the AI\'s line is its last check, with ego lite\'s download page', () => {
    const w = notReadyWords({ name: 'ego lite', last_error: 'local_missing' }, EGO)
    expect(w).toContain('https://lite.ego.app/download')
    expect(w).toContain('not installed')
    expect(w).not.toContain('not set up')
  })
  test('a call that fails says the same, with the link', async () => {
    const e = await send(EGO, { failure: 'start_failed', cause: 'not_found' }, 'ego lite').catch((x) => x)
    expect(e.reason).toBe('local_missing')
    expect(e.message).toContain('https://lite.ego.app/download')
  })
  test('another last check: its own words; never checked: not set up yet', () => {
    expect(notReadyWords({ name: 'Tool', last_error: 'local_share' }, mcp('\\\\srv\\s\\x.exe'))).toContain(reasonText('local_share', 'en', undefined, 'Tool')!)
    expect(notReadyWords({ name: 'Tool', last_error: null }, null)).toContain('not set up on the computer yet')
    expect(notReadyWords({ name: 'Tool', last_error: 'local_offline' }, null)).toContain('not set up on the computer yet')
  })
})

describe('TC-9007: a program on a network share says why', () => {
  test('cause unsupported for a \\\\server path: local_share, network path and copy it to this computer', async () => {
    for (const c of ['\\\\server\\share\\x.exe', '//server/share/x.exe', '\\\\?\\C:\\x.exe']) {
      const e = await send(mcp(c), { failure: 'start_failed', cause: 'unsupported', error: 'x' }).catch((x) => x)
      expect(e).toBeInstanceOf(LocalError)
      expect(e.reason).toBe('local_share')
      expect(e.message).toContain('network path')
    }
    expect(reasonText('local_share', 'en', undefined, 'Tool')).toContain('copy it to a folder on this computer')
  })
  test('another kind of file Windows does not start: local_unsupported; no cause (older desktop app): local_failed', async () => {
    expect((await send(mcp('C:\\x\\tool.ps1'), { failure: 'start_failed', cause: 'unsupported' }).catch((x) => x)).reason).toBe('local_unsupported')
    expect((await send(mcp('\\\\srv\\s\\x.exe'), { failure: 'start_failed', error: 'x' }).catch((x) => x)).reason).toBe('local_failed')
  })
  test('the form refuses it before saving', () => {
    expect(en['localApps.error.share']).toContain('network path')
  })
})

describe('TC-9008: one list of refused characters, read by the splitter and the words', () => {
  test('every listed character is refused by the splitter, on each system', () => {
    for (const style of ['posix', 'windows'] as const) {
      for (const c of COMMAND_REFUSED[style]) {
        const v = c === '%NAME%' ? '%PATH%' : c
        expect([style, c, splitCommand(`tool a${v}b`, style)]).toEqual([style, c, null])
      }
    }
    // the ones QA found missing from the words
    expect(COMMAND_REFUSED.windows).toContain('^')
    expect(COMMAND_REFUSED.windows).toContain('%NAME%')
  })
  test('the form\'s words take the list, never a list of their own', () => {
    expect(en['localApps.error.command']).toContain('{chars}')
    expect(en['localApps.error.command']).not.toMatch(/[|&;^]/)
  })
  test('a batch file: what cmd.exe refuses is BATCH_REFUSED, and its words list it', () => {
    for (const c of BATCH_REFUSED) {
      const l = cmdLaunch('C:\\x\\tool.cmd', [`a${c}b`], host)
      expect('refused' in l && l.refused).toBe('unsafe_arg')
      expect('error' in l && l.error).toContain(BATCH_REFUSED.join(' '))
    }
    expect('refused' in cmdLaunch('C:\\x\\tool.cmd', ['plain'], host)).toBe(false)
    expect(launchFor('C:\\x\\tool.exe', ['a"!b'], host)).toEqual({ file: 'C:\\x\\tool.exe', args: ['a"!b'] })
  })
  test('the page and the AI hear local_unsafe with the same list', async () => {
    const e = await send(mcp('C:\\x\\tool.cmd'), { failure: 'start_failed', cause: 'unsafe_arg' }).catch((x) => x)
    expect(e.reason).toBe('local_unsafe')
    for (const L of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) expect(reasonText('local_unsafe', L, undefined, 'Tool')).toContain(BATCH_REFUSED.join(' '))
    expect(e.message).toContain(BATCH_REFUSED.join(' '))
  })
})

describe('the new reasons have words in every language', () => {
  test('local_share, local_unsupported, local_unsafe', () => {
    for (const r of ['local_share', 'local_unsupported', 'local_unsafe']) {
      for (const L of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
        const s = reasonText(r, L, undefined, 'Tool')!
        expect(s).toContain('Tool')
        expect(s).not.toMatch(/\{\w+\}/)
      }
    }
  })
})
