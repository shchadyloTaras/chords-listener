import type { ErrorCode } from '../../types'

/** Failure of a browser-only operation; `lib/api` turns it into an ApiError with the same code/status. */
export class LocalError extends Error {
  readonly code: ErrorCode
  readonly status: number

  constructor(message: string, code: ErrorCode, status = 400) {
    super(message)
    this.name = 'LocalError'
    this.code = code
    this.status = status
  }
}
