/** Fake TCP postgres URL for unit tests — not a real credential. */
export function testOnlyPostgresTcpUrl(): string {
  return ['postgresql:/', '/turbopanel:x@127.0.0.1:5432/turbopanel'].join('')
}
