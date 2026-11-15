// Every link the apps open into the public guide (https://ax.trina.app/docs/...) must lead to a page of docs/site/ that
// the site builds (one in the navigation), and a #section to one of its headings. QA TC-3098: Find work files' "How"
// opened a page that was not there yet. Looks through the code of the web app, the desktop app, the server, the shared
// package and the phone app (comments too: a link written in a comment is read by people as well).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ROOT, navSlugs, readNav } from '../../scripts/docs/site'
import { headingId } from '../../scripts/docs/build'

const DOCS = 'https://ax.trina.app/docs'
const DIRS = ['web/src', 'desktop/src', 'server/src', 'shared/src', 'mobile/src', 'mobile/app', 'menubar']
const CODE = /\.(ts|tsx|js|mjs|swift|kt|json)$/

function codeFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) codeFiles(p, out)
    else if (CODE.test(e.name)) out.push(p)
  }
  return out
}

/** Every https://ax.trina.app/docs/... in the apps' code, with the file it is in. */
function inAppDocsLinks(root = ROOT): { file: string; url: string }[] {
  const out: { file: string; url: string }[] = []
  const re = /https:\/\/ax\.trina\.app\/docs(?:\/[A-Za-z0-9/_.-]*)?(?:#[A-Za-z0-9_-]+)?/g
  for (const d of DIRS) {
    for (const f of codeFiles(path.join(root, d))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) out.push({ file: path.relative(root, f), url: m[0] })
    }
  }
  return out
}

/** Why a guide link leads nowhere, or null. */
function docsLinkProblem(url: string, root = ROOT): string | null {
  const [address, hash] = url.split('#') as [string, string | undefined]
  // a page's Markdown copy (<slug>.md) is checked as its page
  const slug = address.slice(DOCS.length).replace(/^\/+|\/+$/g, '').replace(/\.md$/, '') || 'index'
  const file = path.join(root, 'docs/site', `${slug}.md`)
  if (!fs.existsSync(file)) return `no page docs/site/${slug}.md`
  if (!navSlugs(readNav()).includes(slug)) return `docs/site/${slug}.md is not in docs/site/nav.json (the site does not build it)`
  if (hash) {
    const ids = [...fs.readFileSync(file, 'utf8').matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => headingId(m[1]!.replace(/\*\*|__/g, '')))
    if (!ids.includes(hash)) return `docs/site/${slug}.md has no heading #${hash}`
  }
  return null
}

describe('links from the apps into the guide', () => {
  test('there are some (the scan finds them)', () => {
    const urls = inAppDocsLinks().map((l) => l.url)
    expect(urls).toContain('https://ax.trina.app/docs/use/find-work-files/')
  })

  test('each one leads to a page the site builds, and a #section to one of its headings', () => {
    const broken = inAppDocsLinks().flatMap((l) => {
      const why = docsLinkProblem(l.url)
      return why ? [`${l.file}: ${l.url}: ${why}`] : []
    })
    expect(broken).toEqual([])
  })

  test('a missing page, a page left out of the navigation and a missing section are each caught', () => {
    expect(docsLinkProblem(`${DOCS}/use/no-such-page/`)).toContain('no page')
    expect(docsLinkProblem(`${DOCS}/use/find-work-files/#no-such-section`)).toContain('no heading')
    expect(docsLinkProblem(`${DOCS}/use/find-work-files/`)).toBeNull()
    expect(docsLinkProblem(`${DOCS}/`)).toBeNull()
  })
})
