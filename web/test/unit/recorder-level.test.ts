// The recording bar's wave (lib/recorder.ts): the level of the analyser's samples, each bar's height, and when the bar
// says that nothing is heard. The microphone, the browser's audio and the bar itself are in test/e2e/voice.spec.ts.
import { describe, expect, test } from 'bun:test'
import { HEARD_LEVEL, inputLevel, nothingHeard, SILENT_AFTER_MS, WAVE_DOT_PX, WAVE_MAX_PX, waveBarPx } from '../../src/lib/recorder'

/** 512 analyser samples (8 bit, 128 = no sound) of a sine with this amplitude (0 to 1) */
const sine = (amplitude: number) => Uint8Array.from({ length: 512 }, (_, i) => Math.round(128 + 127 * amplitude * Math.sin((i / 512) * 2 * Math.PI * 8)))
const bars = (level: number, seconds = 0) => Array.from({ length: 32 }, (_, i) => waveBarPx(level, i, seconds))
/** the level of sound at this many dBFS (RMS) */
const dbfs = (db: number) => inputLevel(sine(10 ** (db / 20) * Math.SQRT2))

describe('input level', () => {
  test('no sound is 0', () => {
    expect(inputLevel(new Uint8Array(512).fill(128))).toBe(0)
    expect(inputLevel(new Uint8Array(0))).toBe(0)
  })
  test('four times the RMS, at most 1', () => {
    // a sine's RMS is its amplitude / √2
    expect(inputLevel(sine(0.1))).toBeCloseTo((0.1 / Math.SQRT2) * 4, 1)
    expect(inputLevel(sine(1))).toBe(1)
    expect(inputLevel(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1)
  })
  test('louder is higher', () => {
    expect(dbfs(-30)).toBeLessThan(dbfs(-20))
    expect(dbfs(-20)).toBeLessThan(dbfs(-12))
  })
})

describe('wave bars', () => {
  test('no sound: 32 dots', () => {
    expect(bars(0)).toEqual(Array(32).fill(WAVE_DOT_PX))
  })
  test('speech as a browser hands it over (about -20 dBFS): bars well over the dot, of different heights, none over the wave', () => {
    const b = bars(dbfs(-20))
    expect(Math.max(...b)).toBeGreaterThan(WAVE_DOT_PX * 3)
    expect(new Set(b.map((h) => h.toFixed(1))).size).toBeGreaterThan(8)
    for (const h of b) expect(h).toBeLessThanOrEqual(WAVE_MAX_PX)
    expect(Math.max(...bars(1))).toBeLessThanOrEqual(WAVE_MAX_PX)
  })
  test('the pattern moves on with the seconds', () => {
    expect(bars(0.5, 0)).not.toEqual(bars(0.5, 1))
  })
  test('HEARD_LEVEL is where the wave leaves the row of dots', () => {
    expect(Math.max(...bars(HEARD_LEVEL))).toBe(WAVE_DOT_PX)
    expect(Math.max(...bars(HEARD_LEVEL * 1.2))).toBeGreaterThan(WAVE_DOT_PX)
    // the quietest an analyser reads off a live microphone (its samples flicker by one step) is far under it
    expect(inputLevel(Uint8Array.from({ length: 512 }, (_, i) => 128 + (i % 2)))).toBeLessThan(HEARD_LEVEL / 2)
  })
})

describe('nothing heard', () => {
  test('said only after the level was watched for SILENT_AFTER_MS with nothing heard', () => {
    expect(nothingHeard({ heard: false, running: true, elapsedMs: SILENT_AFTER_MS - 1 })).toBe(false)
    expect(nothingHeard({ heard: false, running: true, elapsedMs: SILENT_AFTER_MS })).toBe(true)
  })
  test('never once something was heard', () => {
    expect(nothingHeard({ heard: true, running: true, elapsedMs: SILENT_AFTER_MS * 10 })).toBe(false)
  })
  test("never while the browser's audio does not run: the level is not being read, the microphone may be fine", () => {
    expect(nothingHeard({ heard: false, running: false, elapsedMs: SILENT_AFTER_MS * 10 })).toBe(false)
  })
})
