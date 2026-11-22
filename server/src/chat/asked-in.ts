// The turn that asked for a call, as the call's checks read it (docs/decisions/20261122-late-card-answer-resumes.md).
// A call whose card waited after the answer ended runs again in the turn the person's press starts; that turn's user
// message is only the button's words ("이번만 허용"). The checks that read "the asker's own message of this turn" (a file
// they named or attached, a recipient they named, a share or post they asked for), "made in this answer" and "the
// answer this text came from" read the asking turn's while the call runs again (TurnExec.askedIn), so the call is
// judged as it was asked. Everything else (who the person is now, access, the files, the people, the switches) is read
// as it is now.
import type { Database } from 'bun:sqlite'
import type { TurnSpec } from './turn'
import type { AskedIn } from './open-questions'
import { madeInTurn } from './shared-actions'

/** what these helpers read of a turn (a test's stand-in has only `spec`) */
export interface AskedExec { spec: Pick<TurnSpec, 'userMessageId' | 'turnId' | 'assistantId'>; askedIn?: AskedIn | null }

/** the asker's own message of the call: the asking turn's while a waiting call runs again, else this turn's */
export const askerMessageId = (exec: AskedExec): string => exec.askedIn?.userMessageId ?? exec.spec.userMessageId

/** the AI answer the call's content comes from (a post's text, a paste of the person's own words) */
export const askingAnswerId = (exec: AskedExec): string => exec.askedIn?.assistantId ?? exec.spec.assistantId

/** the turn and message `fromAsker` and the other spec-shaped checks read */
export const askerSpec = (exec: AskedExec): { userMessageId: string; turnId: string } =>
  exec.askedIn ? { userMessageId: exec.askedIn.userMessageId, turnId: exec.askedIn.turnId } : { userMessageId: exec.spec.userMessageId, turnId: exec.spec.turnId }

/** the file `rel` was made by the AI in this answer, or in the answer that asked for the call running again */
export const madeHere = (db: Database, exec: AskedExec, rel: string): boolean =>
  madeInTurn(db, exec.spec.turnId, rel) || (!!exec.askedIn && exec.askedIn.turnId !== exec.spec.turnId && madeInTurn(db, exec.askedIn.turnId, rel))
