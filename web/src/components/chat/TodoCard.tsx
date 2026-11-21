// The AI's to-do list for one answer (todo_write, like Claude Code's TodoWrite; Step.todos): one card under the answer's
// steps that moves on in place while the AI works (each call replaces the list) and stays with the answer afterwards.
// Each item says its state with its mark and, for a screen reader, in words: not started (an empty circle), in
// progress (a spinner while the answer runs, then a half-filled circle; its "doing" words while it runs) and done (a
// check, the words in grey and crossed out, as in Claude Code). The frame and rows are the answer cards' own
// (ActionCard, ListRow).
import clsx from 'clsx'
import { Circle, CircleCheck, CircleDot, Loader2 } from 'lucide-react'
import type { Step } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { ListRow } from '../list/List'
import { ActionCard, ActionRows } from './ActionCard'

type Todo = NonNullable<Step['todos']>[number]

/** the answer's to-do list: the last step that has one (there is one per answer) */
export const todoStepOf = (steps: readonly Step[]): Step | undefined => steps.findLast((s) => !!s.todos && !s.parentId)

export default function TodoCard({ todos, streaming }: { todos: readonly Todo[]; streaming: boolean }) {
  const t = useT()
  const done = todos.filter((x) => x.status === 'completed').length
  const title = t('todo.title')
  return (
    <ActionCard title={<>{title} <span className="font-normal text-faint tabular-nums" data-testid="todo-progress">· {t('todo.progress', { done, n: todos.length })}</span></>}
      label={title} testId="todo-card" state={done === todos.length ? 'done' : 'open'} kind="todo">
      <ActionRows testId="todo-items">
        {todos.map((x, i) => {
          const words = x.status === 'in_progress' && streaming && x.activeForm ? x.activeForm : x.content
          const state = x.status === 'completed' ? t('todo.completed') : x.status === 'in_progress' ? t('todo.inProgress') : t('todo.pending')
          const icon = x.status === 'completed' ? <CircleCheck size={16} className="text-ok" aria-hidden />
            : x.status === 'in_progress' ? (streaming ? <Loader2 size={16} className="animate-spin text-accent" aria-hidden /> : <CircleDot size={16} className="text-accent" aria-hidden />)
            : <Circle size={16} className="text-faint" aria-hidden />
          return (
            <ListRow key={i} icon={icon} wrap testId="todo-item" li={{ 'data-status': x.status }}
              name={<><span className={clsx(x.status === 'completed' && 'text-faint line-through', x.status === 'in_progress' && 'font-medium text-ink')}>{words}</span><span className="sr-only"> ({state})</span></>} />
          )
        })}
      </ActionRows>
    </ActionCard>
  )
}
