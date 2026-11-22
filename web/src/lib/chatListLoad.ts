// The first read of the chat list (GET /api/chats?limit=50), shared by every place that shows it on start: the rail's
// and the tab bar's marks (rail/Rail.tsx, BottomTabs.tsx) and the lists (nav/HistoryList.tsx, panels/TrinaList.tsx) mount at once
// and each asked for it, three of the same request at start (docs/DECISIONS.md "First load: compressed files, one
// language, formatting on demand"). A read on its way is shared only within the same signed-in session; once it ends, the next call reads
// again (a Retry after a failure, a reload after a change).
import { useChats } from '../store/chats'
import { useSession } from '../store/session'

let first: { who: string; read: Promise<void> } | null = null

const who = () => {
  const s = useSession.getState().status
  return s.kind === 'signed-in' ? `${s.me.user.id}:${s.me.session.id}` : ''
}

/** useChats.loadChats(true), shared while one is on its way. */
export function loadChatList(): Promise<void> {
  const w = who()
  if (first?.who === w) return first.read
  const read = useChats.getState().loadChats(true)
  const entry = { who: w, read }
  first = entry
  const done = () => { if (first === entry) first = null }
  read.then(done, done)
  return read
}

/** how many rows one "더 보기" should bring at least, and how many pages it reads for them at most */
const MORE_AT_LEAST = 20
const MORE_READS_MAX = 5
/** "더 보기" of a list that leaves some chats out (the Trina history leaves out my sections' chats, which show in their
 * section: docs/decisions/20261122-trina-history-sections.md): reads the next pages until `shown` (the rows the list
 * draws now) has grown by a page's worth, the history ends, or MORE_READS_MAX pages were read. */
export async function loadMoreShown(loadChats: (reset?: boolean) => Promise<void>, shown: () => number): Promise<void> {
  const from = shown()
  for (let i = 0; i < MORE_READS_MAX; i++) {
    if ((await loadChats(false).then(() => true, () => false)) === false) return
    if (!useChats.getState().chatsCursor || shown() - from >= MORE_AT_LEAST) return
  }
}
