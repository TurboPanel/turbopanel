const encoder = new TextEncoder()

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

function readEnv(name: string): string | undefined {
  if (typeof Deno !== 'undefined') {
    return Deno.env.get(name) ?? undefined
  }
  return process.env[name]
}

const LOG_DEBUG_ENABLED =
  readEnv('TURBOPANEL_DAEMON_DEBUG') === '1' ||
  readEnv('TURBOPANEL_DAEMON_DEBUG') === 'true' ||
  readEnv('TURBOPANEL_LOG_LEVEL') === 'debug'

function formatParts(parts: unknown[]): string {
  return parts.map(String).join(' ')
}

function splitMessageLines(message: string): string[] {
  const normalized = message.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines.length > 0 ? lines : ['']
}

function formatStructuredLine(
  level: LogLevel,
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
  level: LogLevel,
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

export function isDaemonDebugEnabled(
  env?: { TURBOPANEL_DAEMON_DEBUG?: string },
): boolean {
  const value = env?.TURBOPANEL_DAEMON_DEBUG ?? readEnv('TURBOPANEL_DAEMON_DEBUG')
  return value === '1' || value === 'true'
}

export function logDebug(component: string, ...parts: unknown[]): void {
  if (!LOG_DEBUG_ENABLED) return
  log('DEBUG', component, ...parts)
}

export function daemonCellLog(
  level: LogLevel,
  serverId: string,
  connectionId: string | undefined,
  message: string,
): void {
  if (level === 'DEBUG' && !isDaemonDebugEnabled()) return
  const conn = connectionId ?? 'unknown'
  log(
    level,
    'daemon-cell',
    `[daemon-cell serverId=${serverId} conn=${conn}] ${message}`,
  )
}

/** Serialize a trace detail value without Object's default `[object Object]`. */
function serializeTraceValue(value: unknown): string {
  if (
    typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean' || typeof value === 'bigint'
  ) {
    return `${value}`
  }
  return JSON.stringify(value)
}

function formatTraceEvent(
  event: string,
  fields: Record<string, unknown>,
): string {
  const parts: string[] = [`event=${event}`]
  for (const key of Object.keys(fields).sort((a, b) => a.localeCompare(b))) {
    const value = fields[key]
    if (value === undefined || value === null) continue
    parts.push(`${key}=${serializeTraceValue(value)}`)
  }
  return parts.join(' ')
}

export function componentTrace(
  component: string,
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!isDaemonDebugEnabled()) return
  log('DEBUG', component, formatTraceEvent(event, fields))
}

export function cellTrace(
  event: string,
  fields: Record<string, unknown>,
): void {
  componentTrace('daemon-cell', event, fields)
}

export function commandConsumerTrace(
  event: string,
  fields: Record<string, unknown>,
): void {
  componentTrace('command-consumer', event, fields)
}

export function logWarn(component: string, ...parts: unknown[]): void {
  log('WARN', component, ...parts)
}

export function logError(component: string, ...parts: unknown[]): void {
  log('ERROR', component, ...parts)
}
