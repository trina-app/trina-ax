// The browser toolbar's own view (ui/pane.html) is loaded once when the window opens and is transparent where it has
// not drawn. When its page fails to load or its renderer ends, the page the AI opened stood alone with nothing above it:
// no title, no ✕, no way to close the browser until the app restarted. The window loads the toolbar again, a few
// times in a short while at most; past that it closes the browser (the page never stands without its toolbar).

/** loads again at most this many times within WINDOW_MS */
export const CHROME_RELOADS = 3
export const CHROME_RELOAD_WINDOW_MS = 60_000
/** wait before a load again (a renderer that ends at once must not spin) */
export const CHROME_RELOAD_DELAY_MS = 500

/** What to do after the toolbar's page failed (`reload`: within the budget; `close`: the budget is spent). */
export function chromeRecovery(failures: readonly number[], now: number): { action: 'reload' | 'close'; failures: number[] } {
  const recent = [...failures.filter((t) => now - t < CHROME_RELOAD_WINDOW_MS), now]
  return { action: recent.length <= CHROME_RELOADS ? 'reload' : 'close', failures: recent }
}

/** Only web addresses leave for the person's own browser (never file:, about:, the app's own pages). */
export function externalUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
