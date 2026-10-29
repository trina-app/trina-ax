/** Bound approval waiting too; converter cancellation is handled by the runner.
 * Aborting this wait never resumes the publication continuation on a later answer. */
export function waitForApproval<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason)}
    signal.addEventListener('abort',abort,{once:true})
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
    if(signal.aborted)abort()
  })
}
