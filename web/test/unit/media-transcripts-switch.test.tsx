// Admin > Team settings > Voice input > "Turn video sound into text" (the owner, 2026-11-19): on by default on a hosted
// server, a Mac and a server with 4 cores and 8 GB; off on a smaller one, with the reason; the whole recording goes into
// text (no hosted "2 minutes per read" any more); the speed measured on the server; and picking another provider in the
// form and back keeps the admin's saved choice (L4: the server resets it only when a save changes the provider).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SpeechHost } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { MediaTranscriptsSwitch, speechHours, transcriptsAfterProvider } from '../../src/pages/admin/TeamSettings'

const noop = () => {}
const host = (o: Partial<SpeechHost> = {}): SpeechHost => ({ cpuCores: 4, localPieceSec: 30, localSecPerSec: null, hosted: false, bigEnough: true, memoryGb: 16, ...o })
const view = (p: Partial<Parameters<typeof MediaTranscriptsSwitch>[0]> = {}) =>
  renderToStaticMarkup(<MediaTranscriptsSwitch provider="local" value={null} host={host()} onChange={noop} {...p} />)

describe('"Turn video sound into text"', () => {
  test('this server with 4 cores and 8 GB: on by default; the whole recording goes into text, the rest in the background, never "2 minutes"', () => {
    const html = view()
    expect(html).toContain('data-on="true"')
    expect(html).toContain('The whole recording is turned into text: what one read has no time for goes on in the background, and reading on picks it up.')
    expect(html).not.toContain('2 minutes')
    expect(html).not.toContain('team-media-transcripts-small')
    expect(html).not.toContain('team-media-transcripts-speed')
  })
  test('a server under 4 cores or 8 GB: off by default, with why; the admin can turn it on, and then it is on', () => {
    const html = view({ host: host({ cpuCores: 2, bigEnough: false, memoryGb: 4 }) })
    expect(html).toContain('data-on="false"')
    expect(html).toContain('data-testid="team-media-transcripts-small"')
    expect(html).toContain('needs at least 4 CPU cores and 8 GB of memory, and this server has 2 CPU cores and 4 GB')
    // 3 cores were enough before; now not
    expect(view({ host: host({ cpuCores: 3, bigEnough: false }) })).toContain('data-on="false"')
    // a Mac and a hosted server are on whatever their size
    expect(view({ host: host({ cpuCores: 2, bigEnough: false, localMac: true }) })).toContain('data-on="true"')
    expect(view({ host: host({ cpuCores: 2, bigEnough: false, hosted: true }) })).toContain('data-on="true"')
    // an older server (no bigEnough): more than 2 cores, as before
    expect(view({ host: { cpuCores: 4, localPieceSec: 30, localSecPerSec: null } })).toContain('data-on="true"')
    const chosen = view({ host: host({ cpuCores: 2, bigEnough: false }), value: true })
    expect(chosen).toContain('data-on="true"')
    expect(chosen).not.toContain('team-media-transcripts-small')
    // OpenRouter with the team's key is off by default on its own server, and is not about this server's cores
    const or = view({ provider: 'openrouter', host: host({ cpuCores: 2, bigEnough: false }) })
    expect(or).toContain('data-on="false"')
    expect(or).not.toContain('team-media-transcripts-small')
    expect(or).toContain('OpenRouter')
  })
  test('a hosted server has no cap to say; OpenRouter with the team\'s own key stays off there too (its cost); a measured speed is shown per minute of sound', () => {
    expect(view({ host: host({ hosted: true }) })).not.toContain('at most 2 minutes')
    expect(view({ provider: 'openrouter', host: host({ hosted: true }) })).toContain('data-on="false"')
    expect(view({ provider: 'openrouter', hostedKey: true, host: host({ hosted: true }) })).toContain('data-on="true"')
    expect(view({ host: host({ localSecPerSec: 1.2 }) })).toContain('about 72 seconds for each minute of sound')
    expect(view({ host: host({ localSecPerSec: 3.5 }) })).toContain('about 3.5 minutes for each minute of sound')
    expect(view({ provider: 'openrouter', host: host({ localSecPerSec: 3.5, hosted: true }) })).not.toContain('minute of sound')
  })
  test("the hosting service's key (hosted speech-to-text): on by default even on 2 cores, saying where the sound goes", () => {
    const html = view({ provider: 'openrouter', hostedKey: true, host: host({ cpuCores: 2, bigEnough: false, hosted: undefined }) })
    expect(html).toContain('data-on="true"')
    expect(html).toContain('hosted transcription turns its sound into text')
    expect(html).toContain('DeepInfra in the US')
    expect(view({ provider: 'openrouter', hostedKey: true, value: false })).toContain('data-on="false"')
    expect(translate('ko', 'speech.hostedUsage', { used: speechHours(5400), free: speechHours(36_000) })).toBe('이번 달 무료 받아쓰기 10시간 중 1.5시간 사용')
    // the plan's hours come from the server (freeSec): Starter 50, Team 100, Business 200
    expect(translate('ko', 'speech.hostedUsage', { used: speechHours(5400), free: speechHours(50 * 3600) })).toBe('이번 달 무료 받아쓰기 50시간 중 1.5시간 사용')
    expect(translate('en', 'speech.hostedUsage', { used: speechHours(5400), free: speechHours(100 * 3600) })).toBe('This month: 1.5 of 100 free transcription hours used')
    expect(translate('ja', 'speech.hostedUsage', { used: speechHours(5400), free: speechHours(200 * 3600) })).toBe('今月の無料文字起こし 200 時間のうち 1.5 時間を使用')
    expect(speechHours(0)).toBe('0')
    expect(speechHours(30)).toBe('0.1')
    expect(speechHours(36_300)).toBe('10.1')
  })
  test('in Korean, plainly (해요체)', () => {
    expect(translate('ko', 'speech.mediaTranscriptsSmall', { cores: 2, gb: 4 })).toBe('기본으로 꺼져 있어요: 여기서 소리를 글로 바꾸려면 CPU 코어 4개와 메모리 8GB 이상이 필요한데, 이 서버는 CPU 코어 2개, 메모리 4GB예요. 관리자가 켤 수 있고, 꺼져 있어도 AI는 영상의 장면을 볼 수 있어요.')
    expect(translate('ko', 'speech.mediaTranscriptsLocal')).toContain('녹음 전체를 글로 바꾸고')
    expect(translate('ko', 'speech.mediaTranscriptsLocal')).not.toContain('2분씩')
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
