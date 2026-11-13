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
