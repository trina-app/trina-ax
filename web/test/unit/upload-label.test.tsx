// A running upload's words inside a live region: a screen reader hears one fixed text with the file's name, not each
// phase and number of each file.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UploadLabel } from '../../src/components/UploadLabel'
import type { UploadProgress } from '../../src/lib/upload'

const at = (phase: UploadProgress['phase'], loaded: number): UploadProgress => ({ phase, loaded, total: 1000 })
const render = (p: UploadProgress | null) => renderToStaticMarkup(<UploadLabel progress={p} busy="Uploading a.pdf" />)
const readable = (html: string) => html.replace(/<span aria-hidden="true">.*?<\/span>/, '')

describe('what a screen reader gets from a running upload', () => {
  test('a number is hidden from it, and the fixed text stands in', () => {
    const html = render(at('uploading', 420))
    expect(html).toContain('<span aria-hidden="true">42%</span>')
    expect(html).toContain('<span class="sr-only">Uploading a.pdf</span>')
  })

  test('from the first step to the last it reads the same, so several files do not fill the queue', () => {
    const steps = [null, at('hashing', 700), at('uploading', 0), at('uploading', 420), at('uploading', 990), at('finishing', 1000)].map((p) => readable(render(p)))
    expect(new Set(steps).size).toBe(1)
    expect(steps[0]).toBe('<span class="sr-only">Uploading a.pdf</span>')
  })
})
