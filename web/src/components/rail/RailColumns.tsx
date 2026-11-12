// The left of a computer's window with the new navigation on (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase
// P1; Layout.tsx puts it where the 280 px sidebar was while the server's `navRail` switch is on): the rail, and beside
// it the list of the place that has one (트리나, 대화). 파일 and 활동 open their pages at full width in this phase;
// Admin's own menu is its list (pages/admin/AdminLayout.tsx), so nothing is lit and no panel shows there. The panel
// folds away by itself below 1052 px while a thread, the room's ✦ side chat or a side panel is open (railPanel.ts), and
// may be hidden there by the person. What is on screen is remembered as what is open in its place (lib/rail.ts).
import { useEffect } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { railOf, rememberRail } from '../../lib/rail'
import { useSidePanel } from '../../lib/sidePanel'
import { useRooms } from '../../store/rooms'
import { ChatsPanel } from '../panels/ChatsPanel'
import { TrinaPanel } from '../panels/TrinaPanel'
import { useMediaQuery } from '../ui'
import { Rail } from './Rail'
import { PANEL_ALWAYS_PX, panelState, useRailPanel } from './railPanel'

/** whether the list panel shows now; Layout.tsx asks it for the skip link "목록으로" */
export function useRailPanelShown(): { has: boolean; state: ReturnType<typeof panelState> } {
  const { pathname, search } = useLocation()
  const item = railOf(pathname, search)
  const has = item === 'ai' || item === 'chats'
  const wide = useMediaQuery(`(min-width: ${PANEL_ALWAYS_PX}px)`)
  const roomId = matchPath('/rooms/:roomId/*', pathname)?.params.roomId ?? null
  const thread = !!matchPath('/rooms/:roomId/t/:messageId', pathname)
  const side = useRooms((s) => !!roomId && s.side[roomId] === 'trina')
  const panel = !!useSidePanel()
  const hidden = useRailPanel((s) => s.hidden)
  return { has, state: panelState({ wide, crowded: thread || side || panel, hidden }) }
}

export function RailColumns() {
  const { pathname, search } = useLocation()
  const item = railOf(pathname, search)
  const { has, state } = useRailPanelShown()
  useEffect(() => rememberRail(pathname, search), [pathname, search])
  return (
    <>
      <Rail showList={has && state === 'hidden'} />
      {has && state === 'shown' && (item === 'ai' ? <TrinaPanel /> : <ChatsPanel />)}
    </>
  )
}
