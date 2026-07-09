import { assertEquals } from 'jsr:@std/assert'
import {
  formatServerOsDisplay,
  parseServerOsMetadata,
  resolveServerOsLogoKey,
  serverOsMetadataEquals,
} from './server-metadata.ts'

Deno.test('formatServerOsDisplay formats Debian with point release', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'debian',
      version: '13.5',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    }),
    'Debian 13.5 (Trixie)',
  )
})

Deno.test('formatServerOsDisplay formats Raspberry Pi OS from variant', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '12.11',
      versionCodename: 'bookworm',
    }),
    'Raspberry Pi OS 12.11 (Bookworm)',
  )
})

Deno.test('formatServerOsDisplay formats raspbian ID as Raspberry Pi OS', () => {
  assertEquals(
    formatServerOsDisplay({
      family: 'linux',
      id: 'raspbian',
      version: '11',
      versionCodename: 'bullseye',
    }),
    'Raspberry Pi OS 11 (Bullseye)',
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

Deno.test('resolveServerOsLogoKey picks debian vs raspberry-pi-os', () => {
  assertEquals(
    resolveServerOsLogoKey({ family: 'linux', id: 'debian' }),
    'debian',
  )
  assertEquals(
    resolveServerOsLogoKey({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
    }),
    'raspberry-pi-os',
  )
  assertEquals(
    resolveServerOsLogoKey({ family: 'linux', id: 'raspbian' }),
    'raspberry-pi-os',
  )
  assertEquals(resolveServerOsLogoKey({ family: 'linux', id: 'ubuntu' }), null)
})

Deno.test('parseServerOsMetadata accepts daemon hello os blocks', () => {
  assertEquals(
    parseServerOsMetadata({
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '13.5',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    }),
    {
      family: 'linux',
      id: 'debian',
      variant: 'raspberry-pi-os',
      version: '13.5',
      versionCodename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      arch: 'aarch64',
    },
  )
  assertEquals(parseServerOsMetadata({ family: 'solaris' }), undefined)
  assertEquals(parseServerOsMetadata('nope'), undefined)
})

Deno.test('serverOsMetadataEquals compares field-wise including variant', () => {
  const a = {
    family: 'linux' as const,
    id: 'debian',
    version: '13.5',
    variant: 'raspberry-pi-os' as const,
  }
  assertEquals(serverOsMetadataEquals(a, { ...a }), true)
  assertEquals(serverOsMetadataEquals(a, { ...a, variant: undefined }), false)
  assertEquals(serverOsMetadataEquals(a, null), false)
})
