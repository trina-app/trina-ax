// Deleting, trashing, hiding and leaving, one way everywhere (docs/decisions/20261126-shared-menus.md): ask only where a
// confirm is the rule today (never a new one: docs/decisions/20261123-do-then-undo.md turned confirms into undo), do it,
// then one toast that says what happened, with "실행 취소" / "Undo" (`common.undo`) when it can be taken back. Chats,
// rooms, projects and scheduled tasks all come here (components/chat/chatActions.ts, rooms/RoomMenu.tsx,
// LeaveProject.tsx, projectActions.tsx, pages/Scheduled.tsx); test/unit/shared-menus-guard.test.ts keeps them here.
import type { ReactNode } from 'react'
import { translate, useLocaleStore } from '../i18n'
import { toast } from '../store/ui'
import { confirmDialog } from '../components/ui'

export interface DestructiveConfirm {
  title: string
  body?: ReactNode
  /** the confirm button's words (it is always the danger style) */
  confirm: string
}

/** What the toast says after it was done: its words, and the undo when it can be taken back. Null: no toast (the
 * caller says it, or nothing needs saying). */
export type DestructiveDone = { text: string; undo?: () => unknown; level?: 'info' | 'success' } | null

/**
 * `confirm`: asked first (cancelled: nothing runs, false). `run`: does it; its answer, or false/null when it did not
 * happen (it says why itself). `done`: the toast for that answer. The answer, or false.
 */
export async function destructive<R>(o: { confirm?: DestructiveConfirm | (() => Promise<DestructiveConfirm | null>); run: () => Promise<R | false | null>; done: (r: R) => DestructiveDone }): Promise<R | false> {
  const ask = typeof o.confirm === 'function' ? await o.confirm() : o.confirm
  if (typeof o.confirm === 'function' && !ask) return false
  if (ask && !(await confirmDialog({ ...ask, danger: true }))) return false
  const r = await o.run()
  if (r === false || r === null) return false
  const said = o.done(r)
  if (said) {
    const undo = said.undo
    toast({ level: said.level ?? 'info', text: said.text, ...(undo ? { action: { label: translate(useLocaleStore.getState().locale, 'common.undo'), run: () => void undo() } } : {}) })
  }
  return r
}
