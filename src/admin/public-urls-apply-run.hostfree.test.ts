import { assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import type { Db } from '../db/connection.ts'
import { EDGE_TRUST_SETTING_KEY, loadEdgeTrustState } from '../features/install/edge-trust.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import {
  applyPublicUrlsIfChanged,
  applyStoredPublicUrls,
  publicUrlsPayloadFingerprint,
  recordPublicUrlsApplied,
} from './public-urls-apply-run.ts'
import type { PublicUrlsApplyPayload, PublicUrlsApplyWaitResult } from './routes-helpers.ts'

const test = Deno.test.bind(Deno)

function fakeDb(rows: { key: string; value: unknown }[]): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          rows.splice(0, rows.length, row)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
}

test('an apply that carried no edge set records only the body hash', async () => {
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  await recordPublicUrlsApplied(db, { urls: [] })
  const state = await loadEdgeTrustState(db)
  assertEquals(state.appliedHash, undefined)
  assertEquals(state.appliedPayloadHash, await publicUrlsPayloadFingerprint({ urls: [] }))
})

test('an apply that carried an edge set records its hash', async () => {
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  await recordPublicUrlsApplied(db, {
    urls: [],
    edgeTrust: { cidrs: [], hash: 'abc', cloudflare: [], bunny: [] },
  })
  assertEquals((await loadEdgeTrustState(db)).appliedHash, 'abc')
})

const HOST = 'panel.example.test'
const URLS = [`https://${HOST}:8443`]
const EDGE = { cidrs: [], hash: 'edge', cloudflare: [], bunny: [] }

/** The body sent before the public port existed, or while the name was direct. */
const OLD_BODY: PublicUrlsApplyPayload = {
  urls: URLS,
  hostnames: [{ host: HOST, source: 'platform-ca' }],
  edgeTrust: EDGE,
}

/** The same name in tunnel mode, for a daemon that advertises the public port. */
const NEW_BODY: PublicUrlsApplyPayload = {
  urls: URLS,
  hostnames: [{ host: HOST, source: 'platform-ca', publicPort: 8443 }],
  edgeTrust: EDGE,
}

function recordingSend(sent: PublicUrlsApplyPayload[]) {
  return (payload: PublicUrlsApplyPayload): Promise<PublicUrlsApplyWaitResult> => {
    sent.push(payload)
    return Promise.resolve<PublicUrlsApplyWaitResult>({ kind: 'done' })
  }
}

test('after an upgrade the body with the public port is sent once', async () => {
  // The last apply ran before the public port existed; the edge set is unchanged.
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  await recordPublicUrlsApplied(db, OLD_BODY)
  const sent: PublicUrlsApplyPayload[] = []

  assertEquals(await applyPublicUrlsIfChanged(db, NEW_BODY, recordingSend(sent)), true)
  assertEquals(sent.length, 1)
  assertEquals(sent[0]?.hostnames?.[0]?.publicPort, 8443)

  assertEquals(await applyPublicUrlsIfChanged(db, NEW_BODY, recordingSend(sent)), false)
  assertEquals(sent.length, 1)
})

test('a stored state from before the body hash sends once, then stays idle', async () => {
  // Only the edge hash was kept by earlier builds.
  const rows: { key: string; value: unknown }[] = [
    { key: EDGE_TRUST_SETTING_KEY, value: { appliedHash: EDGE.hash } },
  ]
  const db = fakeDb(rows)
  const sent: PublicUrlsApplyPayload[] = []
  assertEquals(await applyPublicUrlsIfChanged(db, NEW_BODY, recordingSend(sent)), true)
  assertEquals(await applyPublicUrlsIfChanged(db, NEW_BODY, recordingSend(sent)), false)
  assertEquals(sent.length, 1)
})

test('a daemon without the public port feature gets one body without it, then nothing', async () => {
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  const sent: PublicUrlsApplyPayload[] = []
  const legacy: PublicUrlsApplyPayload = { urls: URLS, hostnames: OLD_BODY.hostnames }
  for (let pass = 0; pass < 3; pass += 1) {
    await applyPublicUrlsIfChanged(db, legacy, recordingSend(sent))
  }
  assertEquals(sent.length, 1)
  assertEquals('publicPort' in (sent[0]?.hostnames?.[0] ?? {}), false)
})

test('a failed send records nothing, so the next pass tries again', async () => {
  const rows: { key: string; value: unknown }[] = []
  const db = fakeDb(rows)
  const failing = () => Promise.resolve<PublicUrlsApplyWaitResult>({ kind: 'timeout' })
  await assertRejects(
    () => applyPublicUrlsIfChanged(db, NEW_BODY, failing),
    Error,
    'apply timed out'
  )
  assertEquals(rows, [])
})

test('the fingerprint ignores key material and follows what the daemon renders', async () => {
  const sealed = (envelope: string): PublicUrlsApplyPayload => ({
    urls: URLS,
    hostnames: [
      {
        host: HOST,
        source: 'uploaded',
        uploadedCertId: 'cert-1',
        certPem: 'CERT',
        keyEnvelope: envelope,
      },
    ],
  })
  assertEquals(
    await publicUrlsPayloadFingerprint(sealed('first-seal')),
    await publicUrlsPayloadFingerprint(sealed('second-seal'))
  )
  assertNotEquals(
    await publicUrlsPayloadFingerprint(OLD_BODY),
    await publicUrlsPayloadFingerprint(NEW_BODY)
  )
  assertNotEquals(
    await publicUrlsPayloadFingerprint(NEW_BODY),
    await publicUrlsPayloadFingerprint({ ...NEW_BODY, edgeTrust: { ...EDGE, hash: 'other' } })
  )
})

/** A query builder where every step returns itself and awaiting it gives no rows. */
function emptyDb(): Db {
  const chain: object = new Proxy(() => chain, {
    get: (_target, key) =>
      key === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : chain,
    apply: () => chain,
  })
  return chain as Db
}

test('applying the stored hostnames with no co-located daemon connected is refused', async () => {
  const registry = {
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
  } as unknown as DaemonCellRegistry
  await assertRejects(
    () =>
      applyStoredPublicUrls({
        db: emptyDb(),
        registry,
        secretsConfig: undefined,
        dataEncryptionSecrets: undefined,
        env: {},
      }),
    Error,
    'no co-located daemon connected'
  )
})
