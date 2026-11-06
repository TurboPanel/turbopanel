import { assertEquals, assertRejects } from '@std/assert'
import {
  applyPublicUrlsIfChanged,
  recordPublicUrlsApplied,
} from '../../../../admin/public-urls-apply-run.ts'
import type { PublicUrlsApplyPayload } from '../../../../admin/routes-helpers.ts'
import type { Db } from '../../../../db/connection.ts'
import { instanceHostname } from '../../../../db/schema.ts'
import {
  certificateErrorsToClear,
  clearInstalledCertificateErrors,
  DAEMON_NOT_LOADED_PREFIX,
  deriveInstanceHostnameStatus,
} from '../../../../features/install/instance-hostnames.ts'
import { pushToDaemon } from './order.ts'

const test = Deno.test.bind(Deno)

const NOT_AFTER = '2027-02-02T01:58:14.000Z'
const NOW = Date.parse('2026-11-04T05:00:00.000Z')

type Row = {
  id: string
  source: 'acme-dns-01'
  uploadedCertId: string | null
  acmeLastError: string | null
  notAfter: string
}

/** One hostname row; every update writes to it, so a test sees what a write would change. */
function oneRowDb(row: Row): { db: Db; updates: number } {
  const state = { updates: 0 }
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    update: () => ({
      set: (values: Partial<Row>) => ({
        where: () => {
          state.updates += 1
          Object.assign(row, values)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
  return {
    db,
    get updates() {
      return state.updates
    },
  }
}

function issuedRow(): Row {
  return {
    id: 'host-1',
    source: 'acme-dns-01',
    uploadedCertId: 'cert-new',
    acmeLastError: null,
    notAfter: NOT_AFTER,
  }
}

async function failedPush(row: Row, db: Db): Promise<void> {
  await pushToDaemon(
    { db, applyToDaemon: () => Promise.reject(new Error('Permission denied')) },
    row.id
  )
}

test('a failed push marks the row failed with the reason', async () => {
  const row = issuedRow()
  const { db } = oneRowDb(row)
  await failedPush(row, db)
  assertEquals(row.acmeLastError, `${DAEMON_NOT_LOADED_PREFIX}Permission denied`)
  assertEquals(deriveInstanceHostnameStatus(row, NOW), 'failed')
})

test('a successful push writes nothing', async () => {
  const row = issuedRow()
  const fake = oneRowDb(row)
  await pushToDaemon({ db: fake.db, applyToDaemon: () => Promise.resolve() }, row.id)
  assertEquals(fake.updates, 0)
  assertEquals(deriveInstanceHostnameStatus(row, NOW), 'ready')
})

test('a later apply that carried the same certificate clears the error', async () => {
  const row = issuedRow()
  const { db } = oneRowDb(row)
  await failedPush(row, db)
  await clearInstalledCertificateErrors(db, [
    { uploadedCertId: 'other-host-cert' },
    { uploadedCertId: 'cert-new' },
  ])
  assertEquals(row.acmeLastError, null)
  assertEquals(deriveInstanceHostnameStatus(row, NOW), 'ready')
})

test('an apply that carried a different certificate leaves the error', async () => {
  const row = issuedRow()
  const fake = oneRowDb(row)
  await failedPush(row, fake.db)
  const before = fake.updates
  await clearInstalledCertificateErrors(fake.db, [{ uploadedCertId: 'cert-old' }])
  assertEquals(fake.updates, before)
  assertEquals(row.acmeLastError, `${DAEMON_NOT_LOADED_PREFIX}Permission denied`)
  assertEquals(deriveInstanceHostnameStatus(row, NOW), 'failed')
})

test('an apply without certificates does not read the hostnames', async () => {
  const db = {
    select: () => {
      throw new Error('no read expected')
    },
  } as unknown as Db
  await clearInstalledCertificateErrors(db, [{}])
  await clearInstalledCertificateErrors(db, undefined)
})

test('only the not-loaded error of the carried certificate is cleared', () => {
  const notLoaded = `${DAEMON_NOT_LOADED_PREFIX}timeout`
  const rows = [
    { ...issuedRow(), acmeLastError: notLoaded },
    // A failed renewal while the old pair is still served stays visible.
    { ...issuedRow(), id: 'host-2', acmeLastError: 'CAA forbids the authority' },
    { ...issuedRow(), id: 'host-3', uploadedCertId: 'cert-other', acmeLastError: notLoaded },
    { ...issuedRow(), id: 'host-4', uploadedCertId: null, acmeLastError: notLoaded },
  ]
  assertEquals(certificateErrorsToClear(rows, [{ uploadedCertId: 'cert-new' }]), ['host-1'])
  assertEquals(certificateErrorsToClear(rows, []), [])
})

/** The hostname row plus the settings row that keeps the last applied body hash. */
function tickDb(row: Row): Db {
  const settings: { key: string; value: unknown }[] = []
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(table === instanceHostname ? [row] : settings),
      }),
    }),
    insert: () => ({
      values: (value: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          settings.splice(0, settings.length, value)
          return Promise.resolve()
        },
      }),
    }),
    update: () => ({
      set: (values: Partial<Row>) => ({
        where: () => {
          Object.assign(row, values)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
}

const BODY: PublicUrlsApplyPayload = {
  urls: ['https://panel.example.test:8443'],
  hostnames: [
    {
      host: 'https://panel.example.test:8443',
      source: 'uploaded',
      uploadedCertId: 'cert-new',
      certPem: 'CERT',
    },
  ],
}

test('the tick clears the error when the daemon already applied this body', async () => {
  const row = issuedRow()
  const db = tickDb(row)
  await recordPublicUrlsApplied(db, BODY)
  await failedPush(row, db)
  const send = () => Promise.reject(new Error('no send expected'))
  assertEquals(await applyPublicUrlsIfChanged(db, BODY, send), false)
  assertEquals(row.acmeLastError, null)
})

test('a failed resend leaves the error', async () => {
  const row = issuedRow()
  const db = tickDb(row)
  await failedPush(row, db)
  const send = () => Promise.resolve({ kind: 'timeout' as const })
  await assertRejects(() => applyPublicUrlsIfChanged(db, BODY, send), Error, 'apply timed out')
  assertEquals(row.acmeLastError, `${DAEMON_NOT_LOADED_PREFIX}Permission denied`)
})

test('a resend the daemon took clears the error', async () => {
  const row = issuedRow()
  const db = tickDb(row)
  await failedPush(row, db)
  const send = () => Promise.resolve({ kind: 'done' as const })
  assertEquals(await applyPublicUrlsIfChanged(db, BODY, send), true)
  assertEquals(row.acmeLastError, null)
})
