import { describe, expect, test } from 'bun:test'
import { artifactCsp, artifactFileName, buildArtifactSrcdoc, findImports, SANDBOX, scriptJson, sucraseCompile, unsupportedImports, wrapHtml } from '../../src/lib/artifacts'

const O = 'https://acme.treesoop.com'
const MSG = { unsupportedImports: (l: string) => `unsupported: ${l}`, compileError: (m: string) => `compile: ${m}`, noDefaultExport: 'no default' }

describe('artifact isolation (tab 5)', () => {
  test('the frame gets allow-scripts only', () => {
    expect(SANDBOX).toBe('allow-scripts')
  })
  test('CSP blocks the network except the team server /vendor/', () => {
    const csp = artifactCsp(O)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src 'unsafe-inline' data: blob: ${O}/vendor/`)
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain('img-src data: blob:')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/esm\.sh|jsdelivr|cdn\.tailwindcss|unpkg/)
  })
  test('our <head> with the CSP comes before anything the AI wrote, even a full document', () => {
    const evil = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.example/"></head><body><img src="https://evil.example/x"></body></html>'
    const html = wrapHtml(evil, O)
    const ours = html.indexOf('http-equiv="Content-Security-Policy"')
    const theirs = html.indexOf('default-src *')
    expect(ours).toBeGreaterThan(0)
    expect(ours).toBeLessThan(theirs)
    expect(html.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true)
    // the AI's head ends up inside our <body>, where meta CSP / base are ignored by the parser
    expect(html.indexOf('<body>')).toBeLessThan(theirs)
  })
  test('scriptJson cannot close the inline script', () => {
    const s = scriptJson('</script><script>alert(1)</script> ')
    expect(s).not.toContain('</script>')
    expect(s).not.toContain(' ')
    expect(JSON.parse(s)).toBe('</script><script>alert(1)</script> ')
  })
})

describe('React artifacts', () => {
  test('compiled outside the frame, imports mapped to /vendor/', async () => {
    const compile = await sucraseCompile()
    const r = buildArtifactSrcdoc('react', 'import { useState } from "react"\nimport { Plus } from "lucide-react"\nexport default function A(){ const [n] = useState(1); return <b><Plus />{n}</b> }', O, compile, MSG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.html).toContain('<script type="importmap">')
    expect(r.html).toContain(`"react":"${O}/vendor/react.js"`)
    expect(r.html).toContain(`"lucide-react":"${O}/vendor/lucide-react.js"`)
    expect(r.html).toContain(`src="${O}/vendor/tailwind.js"`)
    expect(r.html).toContain('data:text/javascript')
    expect(r.html).not.toContain('<b>') // JSX was compiled
  })
  test('unsupported imports and compile errors are reported, not run', async () => {
    const compile = await sucraseCompile()
    expect(buildArtifactSrcdoc('react', 'import x from "left-pad"\nexport default () => null', O, compile, MSG)).toEqual({ ok: false, error: 'unsupported: left-pad' })
    const bad = buildArtifactSrcdoc('react', 'export default function A( { return <div> }', O, compile, MSG)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error.startsWith('compile:')).toBe(true)
  })
  test('findImports sees static, re-export and dynamic imports', () => {
    expect(findImports('import a from "react"; export * from "x"; const m = await import("y")').sort()).toEqual(['react', 'x', 'y'])
    expect(unsupportedImports('import React from "react"; import { LineChart } from "recharts"')).toEqual([])
  })
})

describe('other types and file names', () => {
  test('mermaid uses the vendor bundle; svg is framed', () => {
    const m = buildArtifactSrcdoc('mermaid', 'graph TD; A-->B', O, null, MSG)
    expect(m.ok && m.html).toContain(`${O}/vendor/mermaid.js`)
    const s = buildArtifactSrcdoc('svg', '<svg><circle r="3"/></svg>', O, null, MSG)
    expect(s.ok && s.html).toContain('Content-Security-Policy')
  })
  test('artifactFileName by type and language', () => {
    expect(artifactFileName({ key: 'k', title: 'Sales / Q3: chart', type: 'react', language: null })).toBe('Sales Q3 chart.jsx')
    expect(artifactFileName({ key: 'k', title: null, type: 'mermaid', language: null })).toBe('k.mmd')
    expect(artifactFileName({ key: 'k', title: 'script', type: 'code', language: 'Python' })).toBe('script.py')
    expect(artifactFileName({ key: 'k', title: 'notes.', type: 'markdown', language: null })).toBe('notes.md')
    expect(artifactFileName({ key: 'k', title: 'x', type: 'code', language: 'weird lang!' })).toBe('x.txt')
  })
})
