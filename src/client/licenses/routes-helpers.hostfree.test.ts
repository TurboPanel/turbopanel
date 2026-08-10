/**
 * Host-free coverage gaps for license create body parsing.
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  installBaseUrlValidationError,
  isReservedColocatedLicenseName,
  parseLicenseCreateFields,
  reservedColocatedLicenseNameError,
  serializeLicenseListEntry,
  serverCapacityExceededBody,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseLicenseCreateFields accepts partial string fields and ignores extras', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: 'Edge node' })),
    { name: 'Edge node' },
  )
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      installBaseUrl: 'https://panel.example.com',
      extra: 'ignored',
    })),
    { installBaseUrl: 'https://panel.example.com' },
  )
})

test('parseLicenseCreateFields accepts empty string name values', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: '' })),
    { name: '' },
  )
})

test('parseLicenseCreateFields rejects numeric field types', () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ installBaseUrl: 8443 })),
    'invalid',
  )
})

test('reserved colocated license name helpers', () => {
  assertEquals(isReservedColocatedLicenseName('this server', 'this server'), true)
  assertEquals(isReservedColocatedLicenseName('  this server  ', 'this server'), true)
  assertEquals(isReservedColocatedLicenseName('edge', 'this server'), false)
  assertEquals(
    reservedColocatedLicenseNameError('this server'),
    "'this server' is reserved for the co-located control plane",
  )
})

test('installBaseUrlValidationError depends on developer surface', () => {
  assertEquals(
    installBaseUrlValidationError(true),
    'installBaseUrl must be a valid http(s) URL',
  )
  assertEquals(
    installBaseUrlValidationError(false),
    'installBaseUrl must be a valid https URL',
  )
})

test('serializeLicenseListEntry shapes bound and unbound rows', () => {
  assertEquals(
    serializeLicenseListEntry({
      id: 'l1',
      name: 'Edge',
      createdAt: '2026-01-01T00:00:00.000Z',
      revocable: true,
      bound: undefined,
      status: undefined,
    }),
    {
      id: 'l1',
      name: 'Edge',
      createdAt: '2026-01-01T00:00:00.000Z',
      revocable: true,
      boundServer: null,
    },
  )
  assertEquals(
    serializeLicenseListEntry({
      id: 'l1',
      name: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revocable: false,
      bound: { id: 's1', name: 'node' },
      status: { serverId: 's1', connected: true },
    }).boundServer,
    { id: 's1', name: 'node', connected: true },
  )
})

test('serverCapacityExceededBody preserves capacity fields', () => {
  assertEquals(
    serverCapacityExceededBody(
      {
        maxServers: 2,
        usedSeats: 2,
        serverCount: 1,
        reservedSeatCount: 1,
      },
      'server_capacity_exceeded',
    ),
    {
      error: 'server_capacity_exceeded',
      maxServers: 2,
      usedSeats: 2,
      serverCount: 1,
      reservedSeatCount: 1,
    },
  )
})
