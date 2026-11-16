// The video and audio notes reach members through the AI: plain words only (AI scenario check VIEW-08, 2026-11-16).
import { describe, expect, test } from 'bun:test'
import { MEDIA_TEXT } from '../../server/src/files/media-text'

/** words an office worker should not read, per language; the *Admin notes may name what to install */
const JARGON: Record<string, RegExp> = {
  en: /\bserver|linux|ffmpeg|whisper|package\b/i,
  ko: /서버|리눅스|linux|ffmpeg|whisper|패키지/i,
  id: /\bserver|linux|ffmpeg|whisper|paket\b/i,
  ja: /サーバー|linux|ffmpeg|whisper|パッケージ/i,
  es: /servidor|linux|ffmpeg|whisper|paquete/i,
  zh: /服务器|linux|ffmpeg|whisper|软件包/i,
}

describe('media notes', () => {
  test('no server, Linux, tool or package names in what members read', () => {
    for (const [key, texts] of Object.entries(MEDIA_TEXT)) {
      if (key.endsWith('Admin')) continue
      for (const [locale, text] of Object.entries(texts)) expect({ key, locale, bad: JARGON[locale]!.test(text) }).toEqual({ key, locale, bad: false })
    }
  })
  test('the admin note names the missing package, still without "server" or "Linux"', () => {
    for (const text of Object.values(MEDIA_TEXT.noToolAdmin)) {
      expect(text).toContain('ffmpeg')
      expect(text).not.toMatch(/server|servidor|서버|サーバー|服务器|linux/i)
    }
  })
  test('the Mac note gives a way on instead of a different install', () => {
    expect(MEDIA_TEXT.mac.en).toContain('paste a transcript')
    expect(MEDIA_TEXT.mac.ko).toContain('붙여 주시면')
  })
})
