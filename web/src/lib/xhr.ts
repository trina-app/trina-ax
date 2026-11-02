// fetch cannot say how much of a request body has gone out, so an upload with its progress on screen goes through
// XMLHttpRequest (lib/api.ts, ApiClient's fetchWithProgress). The caller sees fetch: the same init, a Response, an
// abort by the signal, and a TypeError for a network failure (lib/upload.ts retries those, unlike a server's refusal).
const NO_BODY = new Set([101, 204, 205, 304])

export function xhrFetch(url: string, init: RequestInit, onSent: (share: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { signal } = init
    if (signal?.aborted) return reject(signal.reason)
    const xhr = new XMLHttpRequest()
    const stop = () => xhr.abort()
    signal?.addEventListener('abort', stop, { once: true })
    const ended = () => signal?.removeEventListener('abort', stop)
    xhr.onload = () => {
      ended()
      const contentType = xhr.getResponseHeader('content-type')
      try {
        resolve(new Response(NO_BODY.has(xhr.status) ? null : (xhr.response as Blob), { status: xhr.status, headers: contentType ? { 'content-type': contentType } : {} }))
      } catch (e) {
        reject(e)
      }
    }
    xhr.onerror = () => {
      ended()
      reject(new TypeError('Network request failed'))
    }
    xhr.onabort = () => {
      ended()
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    }
    // a share, not bytes: the body of a form also holds its fields and boundaries. Set before send(), or no event comes.
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onSent(Math.min(1, e.loaded / e.total)) }
    xhr.upload.onload = () => onSent(1)
    try {
      xhr.open(init.method ?? 'GET', url)
      xhr.responseType = 'blob'
      xhr.withCredentials = init.credentials === 'include'
      new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value))
      xhr.send(init.body as XMLHttpRequestBodyInit | null | undefined)
    } catch (e) {
      ended()
      reject(e)
    }
  })
}
