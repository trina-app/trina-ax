// Feature coverage of the requests a spec answers in the browser (page.route, rooms-mock.ts): they never reach the mock
// team server, so its count (GET /__test/coverage, docs/FEATURES.md) would miss their endpoints. Every /api answer of
// the mock server carries MOCK_ANSWER_HEADER; an answer without it was given in the browser, and its method and path go
// to POST /__test/coverage, which counts the contract endpoint they name. helpers.ts reset() and rooms-mock.ts turn it
// on for the page's browser context.
import type { BrowserContext, Page, Response } from '@playwright/test'

export const MOCK_ANSWER_HEADER = 'x-mock-answer'

const watched = new WeakSet<BrowserContext>()

/** The endpoint request of an answer given in the browser, or null (another site, not /api, the server's own answer). */
export function answeredInBrowser(res: Pick<Response, 'url' | 'headers'> & { request(): { method(): string } }, origin: string): { method: string; path: string } | null {
  const url = new URL(res.url())
  if (url.origin !== origin || !url.pathname.startsWith('/api/') || res.headers()[MOCK_ANSWER_HEADER]) return null
  return { method: res.request().method(), path: url.pathname }
}

export function reportBrowserAnswers(page: Page) {
  const context = page.context()
  if (watched.has(context)) return
  watched.add(context)
  // the mock server, the pages' own origin (playwright.config.ts baseURL)
  const origin = `http://127.0.0.1:${process.env.MOCK_PORT ?? 19143}`
  context.on('response', (res) => {
    const hit = answeredInBrowser(res, origin)
    // not tied to the context: a report still arrives when the test ends right after the answer
    if (hit) void fetch(`${origin}/__test/coverage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hit) }).catch(() => {})
  })
}
