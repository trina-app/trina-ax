// A page's big name that whoever may rename it renames where they read it, as in Notion, Drive or a ChatGPT/Claude
// project: a click on the name (or Enter on it from the keyboard) turns it into a field with the name selected; Enter
// or leaving the field saves, Esc puts it back. No button of its own: on a computer the name says it can be changed when
// the pointer rests on it (a faint fill, a text cursor and the tip "Rename"). Someone who may not rename it reads plain
// text (`editable` false). Used by a project's page (pages/Projects.tsx); its name's menu keeps Rename too.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { Tooltip } from './Tooltip'

export function EditableTitle({ name, editable, onSave, label, maxLength, className, testId }: {
  name: string
  editable: boolean
  /** the new name, trimmed and changed (not called for an empty or the same name) */
  onSave: (name: string) => void
  /** the field's name for screen readers ("Project name") */
  label: string
  maxLength?: number
  /** the heading's classes (its size and weight): the field takes the same */
  className?: string
  testId: string
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // Enter saves and the field goes, and its blur comes after: one save
  const done = useRef(false)
  const back = useRef(false)
  useEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])
  // after the field goes: the keyboard back on the name it came from (not after a click elsewhere took it away)
  useEffect(() => {
    if (editing || !back.current) return
    back.current = false
    button.current?.focus()
  }, [editing])
  if (!editable)
    return (
      <h1 className={className} data-testid={testId}>
        {name}
      </h1>
    )
  const start = () => {
    done.current = false
    setValue(name)
    setEditing(true)
  }
  const finish = (save: boolean, focusBack: boolean) => {
    if (done.current) return
    done.current = true
    back.current = focusBack
    setEditing(false)
    const next = value.trim()
    if (save && next && next !== name) onSave(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // a Korean or Japanese word still being put together: its Enter is the IME's
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true, true)
    } else if (e.key === 'Escape') {
      // only the field: not an open panel of the page too
      e.stopPropagation()
      finish(false, true)
    }
  }
  return (
    <h1 className={className} data-testid={testId}>
      {editing ? (
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => finish(true, false)}
          aria-label={label}
          maxLength={maxLength}
          enterKeyHint="done"
          // the name's own size and place, the field's ring around it
          className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md bg-surface px-1.5 text-ink outline-none ring-1 ring-accent"
          data-testid={`${testId}-input`}
        />
      ) : (
        <Tooltip label={t('chat.rename')} description>
          <button
            ref={button}
            type="button"
            onClick={start}
            className="-mx-1.5 max-w-[calc(100%+0.75rem)] cursor-text rounded-md px-1.5 text-left break-words hover:bg-hover"
            data-testid={`${testId}-rename`}
          >
            {name}
          </button>
        </Tooltip>
      )}
    </h1>
  )
}
