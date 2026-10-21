// API errors: throw HttpError anywhere in a handler; the app turns it into { error: { code, message } } with the
// status from ErrorStatus and the message in the caller's language.
import { ErrorStatus, errorMessage, type ApiErrorBody, type ErrorCode, type Locale } from '@mycel/shared/api'

export class HttpError extends Error {
  constructor(
    public code: ErrorCode,
    /** specific user-facing message (already localized); default: ERROR_MESSAGES[code] */
    public userMessage?: string,
    public extra: { fields?: Record<string, string>; params?: Record<string, string | number | boolean>; retryAfter?: number; status?: number } = {},
  ) {
    super(userMessage ?? code)
    this.name = 'HttpError'
  }
  get status() { return this.extra.status ?? ErrorStatus[this.code] }
  get retryAfter() { return this.extra.retryAfter }
  body(locale: Locale, requestId?: string): ApiErrorBody {
    return {
      code: this.code,
      message: this.userMessage ?? errorMessage(this.code, locale),
      ...(this.extra.fields ? { fields: this.extra.fields } : {}),
      ...(this.extra.params ? { params: this.extra.params } : {}),
      ...(this.extra.retryAfter !== undefined ? { retryAfter: this.extra.retryAfter } : {}),
      ...(requestId ? { requestId } : {}),
    }
  }
}

export const fail = (code: ErrorCode, message?: string, extra?: HttpError['extra']): never => { throw new HttpError(code, message, extra) }
