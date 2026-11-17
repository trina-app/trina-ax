// The recording bar's wave (lib/recorder.ts): the level of the analyser's samples, each bar's height, and when the bar
// says that nothing is heard. The microphone, the browser's audio and the bar itself are in test/e2e/voice.spec.ts.
import { describe, expect, test } from 'bun:test'
import { HEARD_LEVEL, inputLevel, LEVEL_FLOOR_DB, LEVEL_FULL_DB, nothingHeard, SILENT_AFTER_MS, WAVE_DOT_PX, WAVE_MAX_PX, waveBarPx } from '../../src/lib/recorder'

/** 512 analyser samples (-1 to 1, getFloatTimeDomainData) of a sine with this amplitude (0 to 1) */
const sine = (amplitude: number) => Float32Array.from({ length: 512 }, (_, i) => amplitude * Math.sin((i / 512) * 2 * Math.PI * 8))
const bars = (level: number, seconds = 0) => Array.from({ length: 32 }, (_, i) => waveBarPx(level, i, seconds))
/** the level of sound at this many dBFS (RMS; a sine's RMS is its amplitude / √2) */
const dbfs = (db: number) => inputLevel(sine(10 ** (db / 20) * Math.SQRT2))

describe('input level', () => {
  test('no sound is 0', () => {
    expect(inputLevel(new Float32Array(512))).toBe(0)
    expect(inputLevel(new Float32Array(0))).toBe(0)
  })
  test('from LEVEL_FLOOR_DB (0) to LEVEL_FULL_DB (1), never outside', () => {
    expect(dbfs(LEVEL_FLOOR_DB)).toBeCloseTo(0, 3)
    expect(dbfs(LEVEL_FULL_DB)).toBeCloseTo(1, 3)
    expect(dbfs((LEVEL_FLOOR_DB + LEVEL_FULL_DB) / 2)).toBeCloseTo(0.5, 3)
    expect(dbfs(-90)).toBe(0)
    expect(inputLevel(sine(1))).toBe(1)
  })
  test('louder is higher', () => {
    expect(dbfs(-40)).toBeLessThan(dbfs(-30))
    expect(dbfs(-30)).toBeLessThan(dbfs(-20))
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
  test("speech on a Mac's built-in microphone a little away from it (about -33 dBFS, measured in the desktop app): the wave moves", () => {
    // the former level (four times the RMS) drew every bar of it as a dot, while the words were transcribed
    expect(Math.max(...bars(dbfs(-33)))).toBeGreaterThan(WAVE_DOT_PX * 3)
    expect(Math.max(...bars(dbfs(-38)))).toBeGreaterThan(WAVE_DOT_PX * 2)
  })
  test('a quiet room (about -52 dBFS, 90% of the time under -46) stays a row of dots', () => {
    expect(Math.max(...bars(dbfs(-52)))).toBe(WAVE_DOT_PX)
    expect(Math.max(...bars(dbfs(-46)))).toBe(WAVE_DOT_PX)
  })
  test('the pattern moves on with the seconds', () => {
    expect(bars(0.5, 0)).not.toEqual(bars(0.5, 1))
  })
  test('HEARD_LEVEL is where the wave leaves the row of dots', () => {
    expect(Math.max(...bars(HEARD_LEVEL))).toBe(WAVE_DOT_PX)
    expect(Math.max(...bars(HEARD_LEVEL * 1.2))).toBeGreaterThan(WAVE_DOT_PX)
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
