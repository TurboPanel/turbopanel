/**
 * The broker URL for a log line: user and host kept, password replaced.
 * install-rehearsal (Road to 0.1.x) found the full amqp:// URL, password
 * included, in the mailer's journal on a fresh host.
 */
export function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@')
  }
}
