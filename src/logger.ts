const encoder = new TextEncoder()

function readEnv(name: string): string | undefined {
  if (typeof Deno !== 'undefined') {
    return Deno.env.get(name) ?? undefined
  }
  return process.env[name]
}

const DAEMON_DEBUG_ENABLED =
  readEnv('TURBOPANEL_DAEMON_DEBUG') === '1' ||
  readEnv('TURBOPANEL_DAEMON_DEBUG') === 'true' ||
  readEnv('TURBOPANEL_LOG_LEVEL') === 'debug'

function formatParts(parts: unknown[]): string {
  return parts.map((part) => String(part)).join(' ')
}

function splitMessageLines(message: string): string[] {
  const normalized = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines.length > 0 ? lines : ['']
}

function formatStructuredLine(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  component: string,
  message: string,
): string {
  return `${new Date().toISOString()} ${level} ${component}  ${message}\n`
}

function writeLogLine(
  stream: 'stdout' | 'stderr',
  line: string,
): void {
  if (typeof Deno !== 'undefined') {
    const out = stream === 'stdout' ? Deno.stdout : Deno.stderr
    out.writeSync(encoder.encode(line))
    return
  }
  const out = stream === 'stdout' ? process.stdout : process.stderr
  out.write(line)
}

export function log(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  component: string,
  ...parts: unknown[]
): void {
  const message = formatParts(parts)
  const stream = level === 'INFO' || level === 'DEBUG' ? 'stdout' : 'stderr'

  for (const line of splitMessageLines(message)) {
    writeLogLine(stream, formatStructuredLine(level, component, line))
  }
}

export function logInfo(component: string, ...parts: unknown[]): void {
  log('INFO', component, ...parts)
}

export function logDebug(component: string, ...parts: unknown[]): void {
  if (!DAEMON_DEBUG_ENABLED) return
  log('DEBUG', component, ...parts)
}

export function daemonCellLog(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  serverId: string,
  connectionId: string | undefined,
  message: string,
): void {
  if (level === 'DEBUG' && !DAEMON_DEBUG_ENABLED) return
  const conn = connectionId ?? 'unknown'
  log(
    level,
    'daemon-cell',
    `[daemon-cell serverId=${serverId} conn=${conn}] ${message}`,
  )
}

export function logWarn(component: string, ...parts: unknown[]): void {
  log('WARN', component, ...parts)
}

export function logError(component: string, ...parts: unknown[]): void {
  log('ERROR', component, ...parts)
}
