// Admin > Team settings > Voice input > "Turn video sound into text" (QA on a 2 vCPU box, 2026-11-01): off by default on
// a server with 2 cores or fewer, with the reason; the text follows the real piece length, a hosted server's cap and
// the speed measured on the server (no "2 minutes per read" on a self-installed one); and picking another provider in
// the form and back keeps the admin's saved choice (L4: the server resets it only when a save changes the provider).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SpeechHost } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { MediaTranscriptsSwitch, transcriptsAfterProvider } from '../../src/pages/admin/TeamSettings'

const noop = () => {}
const host = (o: Partial<SpeechHost> = {}): SpeechHost => ({ cpuCores: 4, localPieceSec: 30, localSecPerSec: null, hostedNewSec: null, ...o })
const view = (p: Partial<Parameters<typeof MediaTranscriptsSwitch>[0]> = {}) =>
  renderToStaticMarkup(<MediaTranscriptsSwitch provider="local" value={null} host={host()} onChange={noop} {...p} />)

describe('"Turn video sound into text"', () => {
  test('this server with 4 cores: on by default; the text names the 30-second pieces and how a read goes on, never "2 minutes"', () => {
    const html = view()
    expect(html).toContain('data-on="true"')
    expect(html).toContain('It works in pieces of 30 seconds: one read turns as much as fits in its time, and reading again goes on from there.')
    expect(html).not.toContain('2 minutes')
    expect(html).not.toContain('team-media-transcripts-small')
    expect(html).not.toContain('team-media-transcripts-speed')
  })
  test('a server with 2 cores or fewer: off by default, with why; the admin can turn it on, and then it is on', () => {
    const html = view({ host: host({ cpuCores: 2 }) })
    expect(html).toContain('data-on="false"')
    expect(html).toContain('data-testid="team-media-transcripts-small"')
    expect(html).toContain('this server has 2 CPU cores')
    const chosen = view({ host: host({ cpuCores: 2 }), value: true })
    expect(chosen).toContain('data-on="true"')
    expect(chosen).not.toContain('team-media-transcripts-small')
    // OpenRouter is off by default anywhere, and is not about this server's cores
    const or = view({ provider: 'openrouter', host: host({ cpuCores: 2 }) })
    expect(or).toContain('data-on="false"')
    expect(or).not.toContain('team-media-transcripts-small')
    expect(or).toContain('OpenRouter')
  })
  test('a hosted server says its cap; a measured speed is shown per minute of sound', () => {
    expect(view({ host: host({ hostedNewSec: 120 }) })).toContain('On this hosted server one read turns at most 2 minutes of new sound into text.')
    expect(view({ host: host({ localSecPerSec: 1.2 }) })).toContain('about 72 seconds for each minute of sound')
    expect(view({ host: host({ localSecPerSec: 3.5 }) })).toContain('about 3.5 minutes for each minute of sound')
    expect(view({ provider: 'openrouter', host: host({ localSecPerSec: 3.5, hostedNewSec: 120 }) })).not.toContain('minute of sound')
  })
  test('in Korean, plainly (해요체)', () => {
    expect(translate('ko', 'speech.mediaTranscriptsSmall', { cores: 2 })).toBe('이 서버에서는 소리를 글로 바꾸는 데 오래 걸려서 꺼 두었어요(CPU 코어 2개). 관리자가 켤 수 있고, 꺼져 있어도 AI는 영상의 장면을 볼 수 있어요.')
    expect(translate('ko', 'speech.mediaTranscriptsLocal', { sec: 30 })).toContain('소리를 30초씩 나눠 바꾸는데')
    expect(translate('ko', 'speech.mediaTranscriptsLocal', { sec: 30 })).not.toContain('2분씩')
  })
  test('the provider picked in the form (L4): another one starts from its default, the saved one gets the saved choice back', () => {
    const saved = { speechProvider: 'local' as const, aiMediaTranscripts: false }
    expect(transcriptsAfterProvider('openrouter', saved)).toBeNull()
    expect(transcriptsAfterProvider('off', saved)).toBeNull()
    expect(transcriptsAfterProvider('local', saved)).toBe(false)
    expect(transcriptsAfterProvider('local', { speechProvider: 'openrouter', aiMediaTranscripts: true })).toBeNull()
    expect(transcriptsAfterProvider('openrouter', { speechProvider: 'openrouter', aiMediaTranscripts: true })).toBe(true)
  })
})
