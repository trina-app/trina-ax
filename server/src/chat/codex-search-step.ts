// The step of a Codex web search (docs/DECISIONS.md "Codex web search"; QA 2026-10-30 N1 / N2). Codex starts the item
// without its query and names it only at the end, and an open of one of the search's results (turn0search0) names
// none. The model proxy sees each search request first (proxy/codex-path.ts, ProxyTurnEvent 'search'): what it asked
// for, and the addresses it answered itself instead of sending them (Codex then ends that item as done). The turn keeps
// those asks and matches each ended item to one of them:
//   1. an ask the proxy refused whose address the item names (Codex names an open by its address);
//   2. an item that names an address: the oldest ask without a query (open, click, find, screenshot);
//   3. an item without a query: the oldest ask without a query;
//   4. an item with a query: the oldest ask with one (search_query, image_query).
// Searches in flight together can pair the wrong way round only among asks of the same kind (1 decides refusals by the
// address itself), so the label may swap between two opens, never a refusal onto a search that went out.

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

/** Take the ask an ended Codex search item belongs to (removed from `asks`); null: none fits (no proxy, or not seen). */
export function takeSearchAsk(asks: SearchAsk[], query: string): SearchAsk | null {
  const q = bare(query)
  let i = q ? asks.findIndex((a) => !!a.refused?.some((r) => { const b = bare(r); return !!b && (q === b || q.includes(b)) })) : -1
  if (i < 0 && /^https?:\/\//.test(q)) i = asks.findIndex((a) => !named(a))
  if (i < 0) i = asks.findIndex((a) => (q ? named(a) : !named(a)))
  return i < 0 ? null : asks.splice(i, 1)[0]!
}

/** The label of an ended Codex search that named no query: a result opened (or looked inside), or just "Web search". */
export function unnamedSearchKind(ask: SearchAsk | null, action: 'open' | 'find' | undefined): 'webSearchOpen' | 'webSearchPlain' {
  if (ask) return ask.commands.some((c) => OPENS.has(c)) ? 'webSearchOpen' : 'webSearchPlain'
  return action ? 'webSearchOpen' : 'webSearchPlain'
}
