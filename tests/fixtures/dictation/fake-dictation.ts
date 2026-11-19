#!/usr/bin/env bun
// A stand-in for voice input's on-device helper (desktop/native/dictation/main.swift) for the unit tests and the
// desktop e2e: the same commands and JSON lines, no Speech framework. Set as MYCEL_DICTATION_HELPER.
//   probe / install / listen --language xx
// listen: `ready`, then one guess per 400 ms of sound ("one", "one two" …), made final every 1.2 s ("One two
// three."), the rest final at the end of stdin, then `done`. FAKE_DICTATION (comma list) changes it:
//   unavailable, unsupported (probe and the rest say so); no-model (probe says installed false until install ran:
//   FAKE_DICTATION_DIR keeps that); install-fail; crash (listen exits after its first guess, without done);
//   hang (listen never says done); slow-ready (ready after 300 ms).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = new Set((process.env.FAKE_DICTATION ?? '').split(',').filter(Boolean))
const dir = process.env.FAKE_DICTATION_DIR ?? ''
const [command] = process.argv.slice(2)
const li = process.argv.indexOf('--language')
const language = li > 0 ? process.argv[li + 1] ?? '' : ''
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + '\n')
const locale = `${language}-${language === 'en' ? 'US' : language.toUpperCase()}`
const installedFile = dir ? join(dir, `installed-${language}`) : ''
const installed = () => !mode.has('no-model') || (installedFile !== '' && existsSync(installedFile))
const fail = (code: string) => {
  out({ event: 'error', code, message: code })
  process.exit(1)
}
if (dir) {
  mkdirSync(dir, { recursive: true })
  // what the app ran, for the tests
  writeFileSync(join(dir, `ran-${Date.now()}-${process.pid}`), JSON.stringify(process.argv.slice(2)))
}

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function main() {
  if (mode.has('unavailable')) {
    if (command === 'probe') return out({ event: 'probe', available: false })
    return fail('unavailable')
  }
  if (language === 'id' || mode.has('unsupported')) {
    if (command === 'probe') return out({ event: 'probe', available: true, supported: false })
    return fail('unsupported')
  }
  if (command === 'probe') return out({ event: 'probe', available: true, supported: true, locale, installed: installed() })
  if (command === 'install') {
    for (const p of [0, 40, 80, 100]) {
      out({ event: 'progress', percent: p })
      await Bun.sleep(60)
    }
    if (mode.has('install-fail')) return fail('assets')
    if (installedFile) writeFileSync(installedFile, '1')
    return out({ event: 'installed', locale })
  }
  if (command !== 'listen') return fail('usage')
  if (!installed()) return fail('assets')
  if (mode.has('slow-ready')) await Bun.sleep(300)
  out({ event: 'ready', locale })
  let bytes = 0
  let words: string[] = []
  let next = 0
  let shown = 0
  for await (const chunk of Bun.stdin.stream()) {
    bytes += (chunk as Uint8Array).length
    // 400 ms of 16 kHz 16-bit sound per guess
    while (Math.floor(bytes / 12_800) > shown) {
      shown++
      words.push(WORDS[next++ % WORDS.length]!)
      out({ event: 'text', final: false, text: words.join(' '), start: 0, end: bytes / 32_000 })
      if (mode.has('crash')) process.exit(3)
      if (words.length === 3) {
        out({ event: 'text', final: true, text: cap(words.join(' ')) + '.', start: 0, end: bytes / 32_000 })
        words = []
      }
    }
  }
  if (mode.has('hang')) await new Promise(() => {})
  if (words.length) out({ event: 'text', final: true, text: cap(words.join(' ')) + '.', start: 0, end: bytes / 32_000 })
  out({ event: 'done', seconds: bytes / 32_000 })
}
await main()
