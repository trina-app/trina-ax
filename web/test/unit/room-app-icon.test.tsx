// An Other app's mark (docs/decisions/20261116-other-app-icon.md, QA TC-3544): its first letter on a tint stable per
// app id, its own image or emoji once set, a service's logo for presets, the plain icon only in the picker (no app).
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { APP_TONES, appTone, firstLetter, toneIndex } from '../../src/lib/appTone'
import { AppTile } from '../../src/components/rooms/apps/AppParts'

test('the tint is stable per id, spread over the palette, and by name for a removed app', () => {
  const id = '019a5f00-0000-7000-8000-0000000a0001'
  expect(toneIndex(id)).toBe(toneIndex(id))
  expect(appTone({ id, name: 'A' })).toBe(appTone({ id, name: 'B' }))
  // many ids reach every tint (no tint unused, none for all)
  const seen = new Set(Array.from({ length: 200 }, (_, i) => toneIndex(`019a5f00-0000-7000-8000-${String(i).padStart(12, '0')}`)))
  expect(seen.size).toBe(APP_TONES.length)
  expect(appTone({ id: null, name: 'Alerts' })).toBe(appTone({ id: null, name: 'Alerts' }))
  // every tint has a light and a dark form, never the accent colour
  for (const t of APP_TONES) {
    expect(t).toMatch(/^bg-\[#[0-9A-F]{6}\] text-\[#[0-9A-F]{6}\] dark:bg-\[#[0-9A-F]{6}\] dark:text-\[#[0-9A-F]{6}\]$/)
    expect(t).not.toContain('accent')
  }
})

test('the letter is the name\'s first character in capitals, as a person\'s picture shows it', () => {
  expect(firstLetter('deploy bot')).toBe('D')
  expect(firstLetter('  ünicode')).toBe('Ü')
  expect(firstLetter('🚀 launches')).toBe('🚀')
  expect(firstLetter('')).toBe('?')
})

test('AppTile: a plain Other app draws its letter, emoji or image; presets keep their logo; the picker row its plain icon', () => {
  const app = { id: '019a5f00-0000-7000-8000-0000000a0001', name: 'Dr Alaseo Alert' }
  const letter = renderToStaticMarkup(<AppTile service="other" app={app} />)
  expect(letter).toContain('data-icon="letter"')
  expect(letter).toContain('>D</span>')
  expect(letter).toContain(appTone(app).split(' ')[0]!)
  expect(letter).toContain('aria-hidden="true"')
  const emoji = renderToStaticMarkup(<AppTile service="other" app={{ ...app, icon: { emoji: '🚨' } }} />)
  expect(emoji).toContain('data-icon="emoji"')
  expect(emoji).toContain('🚨')
  const image = renderToStaticMarkup(<AppTile service="other" app={{ ...app, icon: { image: '/api/rooms/r/apps/a/icon?v=5' } }} />)
  expect(image).toContain('<img')
  expect(image).toContain('src="/api/rooms/r/apps/a/icon?v=5"')
  expect(image).toContain('alt=""')
  // a preset's logo, even with an icon field (the server never sends one for it)
  const notion = renderToStaticMarkup(<AppTile service="notion" app={{ ...app, icon: { emoji: '🚨' } }} />)
  expect(notion).toContain('data-testid="app-logo"')
  expect(notion).not.toContain('🚨')
  expect(notion).not.toContain('data-icon')
  // the picker's "Other app" row: no app yet, the plain icon
  expect(renderToStaticMarkup(<AppTile service="other" />)).toContain('<svg')
})
