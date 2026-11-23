/**
 * The registry of machine error codes the HTTP surfaces answer with. A code is
 * a stable snake_case string a client may branch on; the message beside it is
 * the default human text and may change. Add a code here before a route uses
 * it: `apiError` only accepts a key of this table.
 */
export const API_ERROR_CODES = {
  /** A request body or parameter failed validation. */
  invalid_request: 'Invalid request',
  /** No valid session or credential. */
  unauthorized: 'Unauthorized',
  /** The caller is known and not allowed. */
  forbidden: 'Forbidden',
  /** The resource does not exist, or an id is not a valid id. */
  not_found: 'Not found',
  /** The request conflicts with the current state. */
  conflict: 'Conflict',
  /** The request body is over the size ceiling for its route. */
  request_body_too_large: 'request body too large',
  /** The write budget for this caller is spent. */
  rate_limited: 'Too many requests',
  /** The database is not configured or not reachable. */
  database_unavailable: 'Database unavailable',
  /** The feature is not configured on this control plane. */
  not_configured: 'Not configured',
  /** The route is not available on this control plane. */
  not_available: 'Not available',
  /** The email provider cannot be used on this runtime (hosted has no SMTP). */
  email_provider_unsupported_on_workers: 'Email provider not supported on this control plane',
  /** The email provider value is not one the control plane knows. */
  email_provider_unknown: 'Unknown email provider',
  /** A sign-up could not send its verification email; try again later. */
  email_delivery_unavailable: 'Email delivery unavailable',
  /** A failure nothing handled. */
  internal_error: 'Internal Server Error',
  /** A response status with no more specific code (a thrown `HTTPException`). */
  http_error: 'Request failed',
} as const

export type ApiErrorCode = keyof typeof API_ERROR_CODES

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERROR_CODES, value)
}
