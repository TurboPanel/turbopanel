import type { Context } from 'hono'
import {
  isValidDisplayName,
  normalizeDisplayName,
} from '../display-name-format.ts'

export class BadRequestError extends Error {}

/** Parse resource name from the wire body (`name` only). */
export function parseName(body: Record<string, unknown>): string | null {
  const raw = body.name
  if (raw === undefined) {
    return null
  }
  if (typeof raw !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  const name = normalizeDisplayName(raw)
  if (!isValidDisplayName(name)) {
    throw new BadRequestError('Invalid request')
  }
  return name
}

export function requireStringField(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): string | Response {
  const value = body[field]
  if (typeof value !== 'string' || !value) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}
