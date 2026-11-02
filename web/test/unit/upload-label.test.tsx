// A running upload's words inside a live region: a screen reader hears the phases and a fixed text, never each number.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { UploadLabel } from '../../src/components/UploadLabel'
import type { UploadProgress } from '../../src/lib/upload'

const at = (phase: UploadProgress['phase'], loaded: number): UploadProgress => ({ phase, loaded, total: 1000 })
const render = (p: UploadProgress | null) => renderToStaticMarkup(<UploadLabel progress={p} busy="Uploading a.pdf" />)
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('what a screen reader gets from a running upload', () => {
  test('a number is hidden from it, and a fixed text stands in', () => {
    const html = render(at('uploading', 420))
    expect(html).toContain('<span aria-hidden="true">42%</span>')
    expect(html).toContain('<span class="sr-only">Uploading a.pdf</span>')
  })

  test('the numbers change, the text it reads does not', () => {
    const readable = (html: string) => html.replace(/<span aria-hidden="true">.*?<\/span>/, '')
    expect(readable(render(at('uploading', 420)))).toBe(readable(render(at('uploading', 990))))
  })

  test.each([
    ['nothing reported yet', null, 'files.preparing'],
    ['no byte out yet', at('uploading', 0), 'files.preparing'],
    ['hashing', at('hashing', 700), 'files.preparing'],
    ['the last byte is out', at('finishing', 1000), 'files.finishing'],
  ] as const)('%s: the words are read out as they are', (_label, p, key) => {
    setLocale('ko')
    expect(render(p)).toBe(`<span>${translate('ko', key)}</span>`)
  })
})
