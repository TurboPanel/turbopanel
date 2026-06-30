/**
 * Command ids are DB-generated (uuidv7()). Use newCorrelationId() only for WS
 * correlation ids and envelope fields.
 */
export function newCorrelationId(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}
