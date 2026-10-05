/**
 * Host-free coverage for the failed-command error line (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { ERROR_LINE_MAX_CHARS, lastErrorLine } from './error-line.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** The daemon's own cut (`sanitizeError` in turbopaneld `command-router.ts`). */
function daemonTail(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text
  return `[...truncated] ${text.slice(text.length - maxLen)}`
}

test('no error text gives no line', () => {
  assertEquals(lastErrorLine(null), null)
  assertEquals(lastErrorLine(undefined), null)
  assertEquals(lastErrorLine(''), null)
  assertEquals(lastErrorLine('  \n \r\n'), null)
})

test('a one-line error is its own line', () => {
  assertEquals(
    lastErrorLine('ansible-playbook failed (exit 2): Install Caddy: apt lock held'),
    'ansible-playbook failed (exit 2): Install Caddy: apt lock held'
  )
})

test('the last meaningful line wins over earlier progress output', () => {
  assertEquals(
    lastErrorLine('Step 1/4: npm ci\nStep 2/4: npm run build\nsh: 1: next: not found\n'),
    'sh: 1: next: not found'
  )
})

test('bare exit codes, stack frames and log-file pointers are skipped', () => {
  assertEquals(lastErrorLine('docker compose up failed\nexit status 1'), 'docker compose up failed')
  assertEquals(
    lastErrorLine(
      'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at Socket.<anonymous> (net.js:12:3)\n    at run (/app/x.js:4:9)'
    ),
    'Error: connect ECONNREFUSED 127.0.0.1:5432'
  )
  assertEquals(
    lastErrorLine(
      'npm ERR! missing script: build\nnpm ERR! A complete log of this run can be found in: /root/.npm/_logs/x.log'
    ),
    'npm ERR! missing script: build'
  )
})

test('a message of only noise still returns its last line', () => {
  assertEquals(lastErrorLine('exit code 1'), 'exit code 1')
})

test('the daemon truncation marker is never the line', () => {
  assertEquals(lastErrorLine('[...truncated] \nlast real line'), 'last real line')
  assertEquals(lastErrorLine('[...truncated] tail of a cut line only'), 'tail of a cut line only')
  assertEquals(lastErrorLine('[...truncated] '), null)
})

test('an error cut to the last 4000 characters still yields the cause line', () => {
  const progress = Array.from({ length: 600 }, (_, i) => `#${i} RUN step output line`).join('\n')
  const cut = daemonTail(`${progress}\nsh: 1: next: not found`)
  assertEquals(cut.startsWith('[...truncated] '), true)
  assertEquals(cut.length <= 4000 + '[...truncated] '.length, true)
  assertEquals(lastErrorLine(cut), 'sh: 1: next: not found')
})

test('a single huge line keeps its end, where the cause is', () => {
  const cut = daemonTail(`${'progress '.repeat(2000)}the real reason`)
  const line = lastErrorLine(cut) ?? ''
  assertEquals(line.length <= ERROR_LINE_MAX_CHARS, true)
  assertEquals(line.endsWith('the real reason'), true)
})

test('signed URLs in the line lose their query string and user info', () => {
  const line = lastErrorLine(
    'fetch https://user:pw@objects.example.com/a.tgz?X-Amz-Signature=abc123&token=zzz failed: 403'
  )
  assertEquals(line, 'fetch https://objects.example.com/a.tgz?[redacted] failed: 403')
})
