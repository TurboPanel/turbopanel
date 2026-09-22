import { assertEquals } from '@std/assert'
import {
  mergeManagedFailureMessages,
  pickManagedFailureMessage,
} from './last-error.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeManagedFailureMessages skips blanks and duplicates', () => {
  assertEquals(mergeManagedFailureMessages(null, '  ', undefined), null)
  assertEquals(
    mergeManagedFailureMessages('docker.sock denied', 'docker.sock denied', 'proxysql missing'),
    'docker.sock denied\nproxysql missing',
  )
})

test('pickManagedFailureMessage prefers latest apply-family then ingress', () => {
  const managedId = 'managed-1'
  assertEquals(
    pickManagedFailureMessage(
      [
        {
          type: 'managed.ingress.reconcile',
          status: 'failed',
          error: 'proxysql admin.cnf is missing',
          context: {},
          createdAt: '2026-08-19T18:00:02.000Z',
        },
        {
          type: 'managed.apply',
          status: 'failed',
          error: 'permission denied while trying to connect to the docker API',
          context: { managedId },
          createdAt: '2026-08-19T18:00:01.000Z',
        },
        {
          type: 'managed.apply',
          status: 'failed',
          error: 'older apply error',
          context: { managedId },
          createdAt: '2026-08-19T17:00:00.000Z',
        },
        {
          type: 'managed.apply',
          status: 'failed',
          error: 'other cluster',
          context: { managedId: 'managed-2' },
        },
        {
          type: 'managed.apply',
          status: 'succeeded',
          error: null,
          context: { managedId },
        },
      ],
      managedId,
    ),
    'permission denied while trying to connect to the docker API\nproxysql admin.cnf is missing',
  )
})

test('pickManagedFailureMessage ignores ingress failure superseded by a later success', () => {
  const managedId = 'managed-1'
  assertEquals(
    pickManagedFailureMessage(
      [
        {
          type: 'managed.ingress.reconcile',
          status: 'succeeded',
          error: null,
          context: {},
          createdAt: '2026-08-19T19:15:04.000Z',
        },
        {
          type: 'managed.ingress.reconcile',
          status: 'failed',
          error: 'managed-ingress descriptor is missing',
          context: {},
          createdAt: '2026-08-19T18:40:00.000Z',
        },
        {
          type: 'managed.apply',
          status: 'failed',
          error: "mysql failed: ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)",
          context: { managedId },
          createdAt: '2026-08-19T19:16:00.000Z',
        },
      ],
      managedId,
    ),
    "mysql failed: ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)",
  )
})

test('pickManagedFailureMessage returns null when nothing failed', () => {
  assertEquals(
    pickManagedFailureMessage(
      [{
        type: 'managed.apply',
        status: 'succeeded',
        error: null,
        context: { managedId: 'managed-1' },
      }],
      'managed-1',
    ),
    null,
  )
})
