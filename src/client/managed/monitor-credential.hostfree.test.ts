/**
 * Host-free coverage for the per-server ProxySQL monitor credential store.
 *
 * The point of this module is *where* the sealed password lives: the dedicated
 * `monitor` table, never `server.options` — which the server routes return
 * verbatim and the approved cached read models copy into Redis. These tests pin
 * that, plus the read/mint/adopt paths.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import { ENVELOPE_PREFIX_SECRET } from '../authn/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { monitor, server } from '../../lib/db/schema.ts'
import {
  ensureServerMonitorCredential,
  LEGACY_SERVER_OPTIONS_MONITOR_KEY,
  monitorUsernameForServer,
} from './monitor-credential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '11111111-1111-4111-8111-111111111111'
const EXPECTED_USERNAME = 'tp_monitor_111111111111'

type MonitorRow = { username: string; secretEnvelope: string }

type Recorded = {
  inserts: Array<Record<string, unknown>>
  monitorUpdates: Array<Record<string, unknown>>
  serverUpdates: Array<Record<string, unknown>>
}

function stubDb(opts: {
  existing?: MonitorRow
  serverExists?: boolean
  /** Simulate a concurrent mint: the insert conflicts, the re-read wins. */
  onConflictRow?: MonitorRow
  recorded: Recorded
}): Db {
  let monitorRow = opts.existing
  let reads = 0
  return {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            if (table === monitor) {
              reads += 1
              // The second read models the concurrent winner's row.
              const row = reads > 1 && opts.onConflictRow
                ? opts.onConflictRow
                : monitorRow
              return Promise.resolve(row ? [row] : [])
            }
            if (table === server) {
              return Promise.resolve(
                (opts.serverExists ?? true) ? [{ id: SERVER_ID }] : [],
              )
            }
            throw new TypeError(`unexpected select from ${String(fields)}`)
          },
        }),
      }),
    }),
    insert: (table: unknown) => {
      if (table !== monitor) throw new TypeError('unexpected insert')
      return {
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              opts.recorded.inserts.push(values)
              if (opts.onConflictRow) return Promise.resolve([])
              monitorRow = {
                username: values.username as string,
                secretEnvelope: values.secretEnvelope as string,
              }
              return Promise.resolve([monitorRow])
            },
          }),
        }),
      }
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (table === monitor) opts.recorded.monitorUpdates.push(values)
          else opts.recorded.serverUpdates.push(values)
          return Promise.resolve([])
        },
      }),
    }),
  } as unknown as Db
}

function emptyRecorded(): Recorded {
  return { inserts: [], monitorUpdates: [], serverUpdates: [] }
}

async function secrets() {
  return await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
}

test('monitorUsernameForServer stays inside engine identifier limits', () => {
  assertEquals(monitorUsernameForServer(SERVER_ID), EXPECTED_USERNAME)
  assertEquals(monitorUsernameForServer(SERVER_ID).length <= 64, true)
})

test('an existing credential is returned without a new mint', async () => {
  const recorded = emptyRecorded()
  const existing = {
    username: EXPECTED_USERNAME,
    secretEnvelope: `${ENVELOPE_PREFIX_SECRET}existing`,
  }
  const credential = await ensureServerMonitorCredential(
    stubDb({ existing, recorded }),
    await secrets(),
    SERVER_ID,
  )
  assertEquals(credential, {
    username: EXPECTED_USERNAME,
    passwordSealed: existing.secretEnvelope,
  })
  assertEquals(recorded.inserts.length, 0)
  assertEquals(recorded.monitorUpdates.length, 0)
})

test('a missing credential is minted onto the monitor table, not server.options', async () => {
  const recorded = emptyRecorded()
  const credential = await ensureServerMonitorCredential(
    stubDb({ recorded }),
    await secrets(),
    SERVER_ID,
  )

  assertEquals(credential.username, EXPECTED_USERNAME)
  assertEquals(credential.passwordSealed.startsWith(ENVELOPE_PREFIX_SECRET), true)
  assertEquals(recorded.inserts.length, 1)
  assertEquals(recorded.inserts[0]?.serverId, SERVER_ID)
  assertEquals(recorded.inserts[0]?.username, EXPECTED_USERNAME)
  assertEquals(recorded.inserts[0]?.secretEnvelope, credential.passwordSealed)

  // The only `server` write is the legacy-key strip: `options` is set to a SQL
  // fragment that removes a key, never to a value carrying the sealed password.
  assertEquals(recorded.serverUpdates.length, 1)
  const serverUpdate = recorded.serverUpdates[0]!
  assertEquals(
    Object.keys(serverUpdate).toSorted(),
    ['options', 'updatedAt'],
  )
  for (const value of Object.values(serverUpdate)) {
    assertEquals(value === credential.passwordSealed, false)
  }
})

test('a stale stored username is replaced rather than trusted', async () => {
  const recorded = emptyRecorded()
  const stale = {
    username: 'tp_monitor_legacy',
    secretEnvelope: `${ENVELOPE_PREFIX_SECRET}stale`,
  }
  const credential = await ensureServerMonitorCredential(
    stubDb({ existing: stale, onConflictRow: stale, recorded }),
    await secrets(),
    SERVER_ID,
  )
  assertEquals(credential.username, EXPECTED_USERNAME)
  assertEquals(credential.passwordSealed === stale.secretEnvelope, false)
  assertEquals(recorded.monitorUpdates.length, 1)
  assertEquals(recorded.monitorUpdates[0]?.username, EXPECTED_USERNAME)
})

test('an unsealed stored password is not handed out', async () => {
  const recorded = emptyRecorded()
  const plaintext = {
    username: EXPECTED_USERNAME,
    secretEnvelope: 'not-an-envelope',
  }
  const credential = await ensureServerMonitorCredential(
    stubDb({ existing: plaintext, recorded }),
    await secrets(),
    SERVER_ID,
  )
  assertEquals(credential.passwordSealed.startsWith(ENVELOPE_PREFIX_SECRET), true)
  assertEquals(credential.passwordSealed === plaintext.secretEnvelope, false)
})

test('a concurrent mint keeps the winner rather than rotating', async () => {
  const recorded = emptyRecorded()
  const winner = {
    username: EXPECTED_USERNAME,
    secretEnvelope: `${ENVELOPE_PREFIX_SECRET}winner`,
  }
  const credential = await ensureServerMonitorCredential(
    stubDb({ onConflictRow: winner, recorded }),
    await secrets(),
    SERVER_ID,
  )
  // A credential already on its way to a daemon must not be overwritten.
  assertEquals(credential.passwordSealed, winner.secretEnvelope)
  assertEquals(recorded.monitorUpdates.length, 0)
})

test('the legacy server.options key is stripped whenever the credential is read', async () => {
  const recorded = emptyRecorded()
  await ensureServerMonitorCredential(
    stubDb({ recorded }),
    await secrets(),
    SERVER_ID,
  )
  // One `server` UPDATE clearing the published blob. The value is built in SQL,
  // so assert the write happened against `options` — the SQL itself names the key.
  assertEquals(recorded.serverUpdates.length, 1)
  assertEquals('options' in recorded.serverUpdates[0]!, true)
  assertEquals(LEGACY_SERVER_OPTIONS_MONITOR_KEY, 'managedMonitor')
})

test('a missing server row fails loudly instead of minting an orphan', async () => {
  const recorded = emptyRecorded()
  const dataEncryptionSecrets = await secrets()
  await assertRejects(
    () =>
      ensureServerMonitorCredential(
        stubDb({ serverExists: false, recorded }),
        dataEncryptionSecrets,
        SERVER_ID,
      ),
    Error,
    'server not found for monitor credential',
  )
  assertEquals(recorded.inserts.length, 0)
})
