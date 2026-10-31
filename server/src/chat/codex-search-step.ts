// The step of a Codex web search (docs/DECISIONS.md "Codex web search"; QA 2026-10-30 N1 / N2). Codex starts the item
// without its query and names it only at the end, and an open of one of the search's results (turn0search0) names
// none. The model proxy tells the turn about each search request as it answers it (proxy/codex-path.ts, ProxyTurnEvent
// 'search'): what it asked for, and the addresses it answered itself instead of sending them (Codex then ends that
// item as done). Only answers Codex ends an item with are told: a search that fails (refused, limited, an upstream
// error) never completes its item. The turn keeps those asks and matches each item that ended as done to one of them:
//   1. an ask the proxy refused whose address the item names (Codex names an open by its address; a find as
//      "'pattern' in <address>"). Only refs that look like an address (a dot or a slash) count, so a query that merely
//      contains a short refused ref ("12") is not taken for it;
//   2. an item that opened or looked inside a page (its action says so, it names an address, or it names nothing):
//      the oldest ask without a query (open, click, find, screenshot);
//   3. an item with a query: the oldest ask with one (search_query, image_query);
//   4. an item of a kind no waiting ask has (a command Codex names its own way, such as the weather): the oldest ask
//      the proxy did not refuse, so that no ask stays behind for a later item to take.
// The asks come in the order the proxy answered them, which is the order Codex gets the answers and ends the items, so
// searches in flight together pair the wrong way round only rarely and only among asks of the same kind; 1 decides a
// refusal by the address itself wherever the item names it.

/** what the proxy saw of one search request (ProxyTurnEvent 'search') */
export interface SearchAsk { commands: string[]; refused: string[] | null }

/** commands that name a query: Codex's item then carries it */
const NAMED = new Set(['search_query', 'image_query'])
/** commands that open or look inside a page of the search's results */
const OPENS = new Set(['open', 'click', 'find', 'screenshot'])
/** at most this many asks wait for their item (a search whose item never ends does not grow the list for ever) */
export const SEARCH_ASKS_MAX = 50

const named = (a: SearchAsk) => a.commands.some((c) => NAMED.has(c))
const bare = (s: string) => s.trim().replace(/\/+$/, '').toLowerCase()
/** a refused ref worth matching by its text: an address has a dot or a slash (a result id or a number has neither) */
const addressLike = (b: string) => b.length >= 4 && /[./]/.test(b)

/** Take the ask an ended Codex search item belongs to (removed from `asks`); null: none fits (no proxy, or not seen).
 * `action`: what Codex says the item did when it was not a query (codex-parse.ts searchAction). */
export function takeSearchAsk(asks: SearchAsk[], query: string, action?: 'open' | 'find'): SearchAsk | null {
  const q = bare(query)
  let i = q ? asks.findIndex((a) => !!a.refused?.some((r) => { const b = bare(r); return addressLike(b) && q.includes(b) })) : -1
  const opened = !!action || !q || /^https?:\/\//.test(q)
  if (i < 0) i = asks.findIndex((a) => (opened ? !named(a) : named(a)))
  if (i < 0) i = asks.findIndex((a) => !a.refused)
  return i < 0 ? null : asks.splice(i, 1)[0]!
}

/** The label of an ended Codex search that named no query: a result opened (or looked inside), or just "Web search". */
export function unnamedSearchKind(ask: SearchAsk | null, action: 'open' | 'find' | undefined): 'webSearchOpen' | 'webSearchPlain' {
  if (ask) return ask.commands.some((c) => OPENS.has(c)) ? 'webSearchOpen' : 'webSearchPlain'
  return action ? 'webSearchOpen' : 'webSearchPlain'
}
