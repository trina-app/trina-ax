// The left of a computer's window (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1; Layout.tsx): the rail,
// and beside it the list of the place: 트리나, 대화, 프로젝트 (every project I see, panels/ProjectsPanel.tsx), 파일 (its places: recent files, team and project folders, 내
// 파일, the trash) and 활동 (the notices that are not conversations). Admin's own menu is its list
// (pages/admin/AdminLayout.tsx), so nothing is lit and no panel shows there. The panel
// folds away by itself below 1052 px while a thread, the room's ✦ side chat or a side panel is open (railPanel.ts), and
// may be hidden there by the person. What is on screen is remembered as what is open in its place (lib/rail.ts).
import { useEffect } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { rememberRail, useRailHere } from '../../lib/rail'
import { useSidePanel } from '../../lib/sidePanel'
import { useRooms } from '../../store/rooms'
import { useGuestHidden } from '../GuestView'
import { ActivityPanel } from '../panels/ActivityPanel'
import { ChatsPanel } from '../panels/ChatsPanel'
import { FilesPanel } from '../panels/FilesPanel'
import { ProjectsPanel } from '../panels/ProjectsPanel'
import { TrinaPanel } from '../panels/TrinaPanel'
import { useMediaQuery } from '../ui'
import { Rail } from './Rail'
import { PANEL_ALWAYS_PX, panelState, useRailPanel } from './railPanel'

/** whether this place has a list panel and how it shows now */
function useRailPanelShown(): { has: boolean; state: ReturnType<typeof panelState> } {
  const { pathname } = useLocation()
  // a place a guest does not have (components/GuestView.tsx useGuestHidden: 트리나 while their AI is off, 파일) has no
  // list either, also under Settings opened straight from its address (the page under it is then Home's, 트리나's)
  const item = useRailHere()
  const notMine = useGuestHidden()
  const has = !!item && !notMine.has(item)
  const wide = useMediaQuery(`(min-width: ${PANEL_ALWAYS_PX}px)`)
  const roomId = matchPath('/rooms/:roomId/*', pathname)?.params.roomId ?? null
  const thread = !!matchPath('/rooms/:roomId/t/:messageId', pathname)
  const side = useRooms((s) => !!roomId && s.side[roomId] === 'trina')
  const panel = !!useSidePanel()
  const hidden = useRailPanel((s) => s.hidden)
  return { has, state: panelState({ wide, crowded: thread || side || panel, hidden }) }
}

/** `onList`: told whether the list panel shows (Layout.tsx's skip link "목록으로") */
export function RailColumns({ onList }: { onList: (shown: boolean) => void }) {
  const { pathname, search, state: entry } = useLocation()
  const item = useRailHere()
  const { has, state } = useRailPanelShown()
  const shown = has && state === 'shown'
  useEffect(() => rememberRail(pathname, search, entry), [pathname, search, entry])
  useEffect(() => {
    onList(shown)
    return () => onList(false)
  }, [shown, onList])
  return (
    <>
      <Rail showList={has && state === 'hidden'} />
      {shown && (item === 'ai' ? <TrinaPanel /> : item === 'chats' ? <ChatsPanel /> : item === 'projects' ? <ProjectsPanel /> : item === 'files' ? <FilesPanel /> : <ActivityPanel />)}
    </>
  )
}
