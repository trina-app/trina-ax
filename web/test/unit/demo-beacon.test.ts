// The scripted demo's beacon (web/demo/beacon.ts): it sends only on ax.trina.app, the body holds the event, the path,
// the language and one short value, and nothing else.
import { describe, expect, test } from 'bun:test'
import { BEACON_PATH, beacon, type BeaconEnv } from '../../demo/beacon'

function env(hostname: string, pathname = '/demo/en/') {
  const sent: { url: string; body: string }[] = []
  const e: BeaconEnv = { location: { hostname, pathname }, lang: 'en', send: (url, body) => { sent.push({ url, body }); return true } }
  return { e, sent }
}

describe('demo beacon', () => {
  test('does nothing on any host but ax.trina.app', () => {
    for (const h of ['localhost', '127.0.0.1', 'demo.trina.app', 'trina.app', 'ax.trina.app.evil.example', 'preview.ax.trina.app', 'example.com']) {
      const { e, sent } = env(h)
      expect(beacon('demo_start', '', e)).toBe(false)
      expect(sent).toEqual([])
    }
    // no browser (tests, server render): nothing
    expect(beacon('demo_start', '', null)).toBe(false)
  })

  test('on ax.trina.app: one POST to /e with e, p, l, x only', () => {
    const { e, sent } = env('ax.trina.app')
    expect(beacon('demo_step', 3, e)).toBe(true)
    expect(beacon('cta_click', 'signup:demo_end', e)).toBe(true)
    expect(sent.map((s) => s.url)).toEqual([BEACON_PATH, BEACON_PATH])
    expect(JSON.parse(sent[0]!.body)).toEqual({ e: 'demo_step', p: '/demo/en/', l: 'en', x: '3' })
    expect(JSON.parse(sent[1]!.body)).toEqual({ e: 'cta_click', p: '/demo/en/', l: 'en', x: 'signup:demo_end' })
  })

  test('a value outside the allowed shape is dropped; a long path is cut; a throwing sender never throws', () => {
    const { e, sent } = env('ax.trina.app', '/' + 'a'.repeat(300))
    beacon('demo_step', 'not ok <script>', e)
    const b = JSON.parse(sent[0]!.body)
    expect(b.x).toBe('')
    expect(b.p.length).toBe(100)
    const bad: BeaconEnv = { ...e, send: () => { throw new Error('x') } }
    expect(beacon('demo_finish', '', bad)).toBe(false)
  })
})
