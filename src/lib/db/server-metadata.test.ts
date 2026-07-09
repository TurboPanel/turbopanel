import { assertEquals } from 'jsr:@std/assert'
import {
  formatServerOsDisplay,
  parseServerOsMetadata,
  serverOsMetadataEquals,
} from './server-metadata.ts'

Deno.test('formatServerOsDisplay formats Debian 13 (Trixie)', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'debian',
      version: '13',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    }),
    'Debian 13 (Trixie)',
  )
})

Deno.test('formatServerOsDisplay falls back when fields are sparse', () => {
  assertEquals(
    formatServerOsDisplay({ family: 'linux', id: 'ubuntu', version: '24.04' }),
    'Ubuntu 24.04',
  )
  assertEquals(
    formatServerOsDisplay({ family: 'linux', id: 'debian' }),
    'Debian',
  )
  assertEquals(
    formatServerOsDisplay({
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    }),
    'Debian',
  )
  assertEquals(formatServerOsDisplay(null), null)
  assertEquals(formatServerOsDisplay(undefined), null)
})

Deno.test('parseServerOsMetadata accepts daemon hello os blocks', () => {
  assertEquals(
    parseServerOsMetadata({
      family: 'linux',
      id: 'debian',
      version: '13',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    }),
    {
      family: 'linux',
      id: 'debian',
      version: '13',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    },
  )
  assertEquals(parseServerOsMetadata({ family: 'solaris' }), undefined)
  assertEquals(parseServerOsMetadata('nope'), undefined)
})

Deno.test('serverOsMetadataEquals compares field-wise', () => {
  const a = { family: 'linux' as const, id: 'debian', version: '13' }
  assertEquals(serverOsMetadataEquals(a, { ...a }), true)
  assertEquals(serverOsMetadataEquals(a, { ...a, version: '13.1' }), false)
  assertEquals(serverOsMetadataEquals(a, null), false)
})
