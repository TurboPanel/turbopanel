/**
 * What a notification calls a server: its name, else its hostname. A server
 * added without a name has only the hostname its daemon reported, and a notice
 * that says "Server unknown" tells its reader nothing. Null when it has neither,
 * so each notice keeps its own fallback words.
 */
export function serverNoticeName(row: {
  name: string | null
  hostname: string | null
}): string | null {
  return row.name?.trim() || row.hostname?.trim() || null
}
