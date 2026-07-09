import { assertEquals } from 'jsr:@std/assert'
import { mergeServerMetadataIdentity } from './server-registry.ts'

Deno.test('mergeServerMetadataIdentity merges os and skips unchanged writes', () => {
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
    versionCodename: 'trixie',
  }
  const merged = mergeServerMetadataIdentity(
    { hostname: 'old', machineId: 'mid-1' },
    { hostname: 'new', os },
  )
  assertEquals(merged, {
    hostname: 'new',
    machineId: 'mid-1',
    os,
  })

  assertEquals(
    mergeServerMetadataIdentity(
      { hostname: 'new', machineId: 'mid-1', os },
      { hostname: 'new', machineId: 'mid-1', os },
    ),
    null,
  )
})
