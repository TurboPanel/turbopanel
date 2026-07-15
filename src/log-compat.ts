const encoder = new TextEncoder()

function splitMessageLines(message: string): string[] {
  const normalized = message.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines.length > 0 ? lines : ['']
}

function formatStructuredLine(
  level: 'INFO' | 'WARN' | 'ERROR',
  component: string,
  message: string,
): string {
  return `${new Date().toISOString()} ${level} ${component}  ${message}\n`
}

function writeStructured(
  level: 'INFO' | 'WARN' | 'ERROR',
  component: string,
  message: string,
): void {
  if (typeof Deno !== 'undefined') {
    const out = level === 'INFO' ? Deno.stdout : Deno.stderr
    for (const line of splitMessageLines(message)) {
      out.writeSync(encoder.encode(formatStructuredLine(level, component, line)))
    }
    return
  }

  const tagged = `[${component}] ${message}`
  if (level === 'INFO') {
    console.log(tagged)
  } else if (level === 'WARN') {
    console.warn(tagged)
  } else {
    console.error(tagged)
  }
}

export function compatLogInfo(component: string, message: string): void {
  writeStructured('INFO', component, message)
}

export function compatLogWarn(component: string, message: string): void {
  writeStructured('WARN', component, message)
}

export function compatLogError(component: string, message: string): void {
  writeStructured('ERROR', component, message)
}
