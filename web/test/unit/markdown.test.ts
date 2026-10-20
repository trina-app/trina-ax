import { describe, expect, test } from 'bun:test'
import { classifyImage, classifyLink, isDisplayableImagePath, prepareMarkdown } from '../../src/lib/markdown'

const O = 'https://acme.treesoop.com'

describe('prepareMarkdown (ported from Saram)', () => {
  test('prices, spreadsheet refs and env vars are not math', () => {
    expect(prepareMarkdown('$5 coupon and $10 off')).toBe('\\$5 coupon and \\$10 off')
    expect(prepareMarkdown('cell $A$1')).toBe('cell \\$A\\$1')
    expect(prepareMarkdown('echo $PATH')).toBe('echo \\$PATH')
  })
  test('real math stays', () => {
    expect(prepareMarkdown('$x^2$ and $$a+b$$')).toBe('$x^2$ and $$a+b$$')
    expect(prepareMarkdown('$1$')).toBe('$1$')
  })
  test('code is left alone', () => {
    expect(prepareMarkdown('`$5` and\n```\n$PATH\n```')).toBe('`$5` and\n```\n$PATH\n```')
  })
  test('streaming closes what is still open', () => {
    expect(prepareMarkdown('**bold', true)).toBe('**bold**')
    // an unclosed fence is already a code block for the Markdown parser: left as is
    expect(prepareMarkdown('```js\nconst a = 1', true)).toBe('```js\nconst a = 1')
    // half-written links show as text, not a broken link
    expect(prepareMarkdown('see [the doc](https://exa', true)).not.toContain('](https://exa')
  })
})

describe('links in answers', () => {
  test('team files open the preview', () => {
    expect(classifyLink('/api/files/download?path=finance%2Fq3.xlsx', O)).toEqual({ kind: 'team-file', path: 'finance/q3.xlsx' })
    expect(classifyLink(`${O}/api/files/download?path=a.md&disposition=inline`, O)).toEqual({ kind: 'team-file', path: 'a.md' })
  })
  test('other API paths are never links; app paths stay in the app', () => {
    expect(classifyLink('/api/admin/users', O)).toEqual({ kind: 'blocked' })
    expect(classifyLink('/files?path=x', O)).toEqual({ kind: 'app', href: '/files?path=x' })
    // share links from the AI's share_file / make_file tools (shared/src/api/files.ts fileShareUrl)
    expect(classifyLink('/files/view?path=shared%2Freport.docx', O)).toEqual({ kind: 'team-file', path: 'shared/report.docx' })
    expect(classifyLink(`${O}/files/view?path=groups%2Fmarketing`, O)).toEqual({ kind: 'app', href: '/files?path=groups%2Fmarketing' })
    expect(classifyLink('/files/view', O)).toEqual({ kind: 'app', href: '/files' })
  })
  test('only http(s) / mailto / tel go out', () => {
    expect(classifyLink('https://example.com/a', O)).toEqual({ kind: 'external', href: 'https://example.com/a' })
    expect(classifyLink('mailto:a@b.c', O).kind).toBe('external')
    expect(classifyLink('javascript:alert(1)', O).kind).toBe('blocked')
    expect(classifyLink('data:text/html,<script>', O).kind).toBe('blocked')
    expect(classifyLink('file:///etc/passwd', O).kind).toBe('blocked')
    expect(classifyLink(undefined, O).kind).toBe('blocked')
  })
})

describe('images in answers', () => {
  test('external images never load by themselves', () => {
    expect(classifyImage('https://evil.example/c?d=secret', O)).toEqual({ kind: 'external', href: 'https://evil.example/c?d=secret', host: 'evil.example' })
    expect(classifyImage('//evil.example/x.png', O).kind).toBe('external')
  })
  test('team-server images and attachment thumbnails load', () => {
    expect(classifyImage('/api/files/download?path=shots%2Fa.png', O)).toEqual({ kind: 'team-file', path: 'shots/a.png' })
    expect(classifyImage('/api/uploads/0192f0a0-0000-7000-8000-000000000000/thumbnail', O).kind).toBe('attachment-thumb')
    expect(classifyImage('/api/admin/users', O).kind).toBe('blocked')
  })
  test('inline data: images only as raster formats', () => {
    expect(classifyImage('data:image/png;base64,iVBORw0KGgo=', O).kind).toBe('inline-data')
    expect(classifyImage('data:image/svg+xml;base64,PHN2Zz4=', O).kind).toBe('blocked')
    expect(classifyImage('data:text/html;base64,PGgxPg==', O).kind).toBe('blocked')
  })
  test('displayable team images: png/jpeg/gif/webp, svg via <img> only', () => {
    expect(['a.png', 'b.JPG', 'c.webp', 'd.gif', 'e.svg'].every(isDisplayableImagePath)).toBe(true)
    expect(isDisplayableImagePath('x.html')).toBe(false)
  })
})
