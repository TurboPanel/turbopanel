/**
 * Host-free coverage for compose hosting reconcile (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { ComposeDocument } from '../../features/compose/index.ts'
import { hostingEntryKey } from '../../features/compose/index.ts'
import {
  hostname,
  hosting,
  instanceHostname,
  ip,
  organization,
  service,
  setting,
  tls,
} from '../../db/schema.ts'
import type { Db } from '../../db/connection.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  HOSTING_COMPOSE_ROUTE_METADATA_KEY,
  withHostingComposeOwner,
} from '../../features/hostings/hosting-compose-owner.ts'
import { reconcileHostingsFromCompose } from './reconcile-hostings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const ENV_ID = '22222222-2222-4222-8222-222222222222'
const SVC_WEB = '33333333-3333-4333-8333-333333333333'
const SVC_OTHER = '44444444-4444-4444-8444-444444444444'
const HOSTNAME = 'app.example.com'
const ROUTE = hostingEntryKey({ hostname: HOSTNAME })

type ExistingRow = {
  id: string
  serviceId: string
  metadata: unknown
  options: unknown
}

function composeDoc(services: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function hostingService(
  hostingEntries: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    image: 'nginx:alpine',
    'x-turbopanel': {
      ...extra,
      hosting: hostingEntries,
    },
  }
}

function composeOwnedMetadata(
  composeServiceName: string,
  route: string,
  adopted = false
): Record<string, unknown> {
  return withHostingComposeOwner(
    {},
    {
      composeServiceName,
      route,
      ...(adopted ? { adopted: true } : {}),
    }
  )
}

type TlsSeed = {
  id: string
  label: string | null
  source?: string
  status?: string
  metadata?: Record<string, unknown>
}

function createReconcileDb(opts: {
  hostingRows?: ExistingRow[]
  tlsRows?: TlsSeed[]
  ipRows?: Array<{ id: string; label: string | null }>
  panelHosts?: string[]
  /** The organization's "Allow Let's Encrypt certificates" switch; unset leaves the key out. */
  acmeEnabled?: boolean
}) {
  return createMemoryDb(
    [
      [
        organization,
        [
          {
            id: ORG_ID,
            options: opts.acmeEnabled === undefined ? {} : { acmeEnabled: opts.acmeEnabled },
          },
        ],
      ],
      [hosting, opts.hostingRows ?? []],
      [
        service,
        [
          { id: SVC_WEB, environmentId: ENV_ID },
          { id: SVC_OTHER, environmentId: ENV_ID },
        ],
      ],
      [
        tls,
        (opts.tlsRows ?? []).map((row) => ({
          id: row.id,
          name: row.label,
          organizationId: ORG_ID,
          createdAt: new Date(0).toISOString(),
          source: row.source ?? 'upload',
          status: row.status ?? 'ready',
          metadata: row.metadata ?? {},
        })),
      ],
      [
        ip,
        (opts.ipRows ?? []).map((row) => ({
          id: row.id,
          address: row.label,
          organizationId: ORG_ID,
        })),
      ],
      [hostname, []],
      [setting, []],
      [
        instanceHostname,
        (opts.panelHosts ?? []).map((host, index) => ({
          id: `panel-${index}`,
          host,
          source: 'platform-ca',
          uploadedCertId: null,
          acmeLastAttemptAt: null,
          acmeLastError: null,
          notAfter: null,
          createdAt: new Date(index).toISOString(),
          updatedAt: new Date(index).toISOString(),
        })),
      ],
    ],
    { fallback: lockRecorder() }
  )
}

/** Stands in for `execute` (the managed Let's Encrypt row's transaction lock) and records each call. */
const executed: unknown[] = []
function lockRecorder(): Db {
  return {
    execute: (query: unknown) => {
      executed.push(query)
      return Promise.resolve([])
    },
  } as unknown as Db
}

/** The one `hosting` row a call created or kept, by id. */
function hostingRow(db: ReturnType<typeof createReconcileDb>, id: string) {
  return db.rows(hosting).find((row) => row.id === id)
}

test('reconcileHostingsFromCompose is a no-op when nothing is declared or owned', async () => {
  const db = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({}),
    serviceRows: [],
  })
  assertEquals(result, {
    ok: true,
    created: [],
    updated: [],
    adopted: [],
    removed: [],
    released: [],
  })
  assertEquals(db.rows(hosting), [])
})

test('reconcileHostingsFromCompose skips non-mapping services and services without hosting', async () => {
  const db = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      skip: 'not-a-mapping',
      api: { image: 'node:22' },
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create to succeed')
  assertEquals(result.created.length, 1)
  assertEquals(db.rows(hosting).length, 1)
  const row = hostingRow(db, result.created[0]!)
  assertEquals(row?.name, HOSTNAME)
  assertEquals(row?.serviceId, SVC_WEB)
})

test('reconcileHostingsFromCompose creates a row and pins TLS/IP by id or label, and syncs the hostname table', async () => {
  const db = createReconcileDb({
    tlsRows: [
      { id: 'tls-1', label: 'prod-cert' },
      { id: 'tls-2', label: 'prod-cert' },
    ],
    ipRows: [{ id: 'ip-1', label: '203.0.113.10' }],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([
        {
          hostname: HOSTNAME,
          pathPrefix: '/app',
          targetPort: 8080,
          forceHttps: true,
          tls: { mode: 'certificate', certificateRef: 'tls-1' },
          bind: { scope: 'public', ipRef: '203.0.113.10' },
        },
      ]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create with pins to succeed')
  assertEquals(result.created.length, 1)
  const row = hostingRow(db, result.created[0]!)
  assertEquals(row?.tlsId, 'tls-1')
  assertEquals(row?.ipId, 'ip-1')
  const options = row?.options as Record<string, unknown>
  assertEquals(options.hostnames, [HOSTNAME])
  assertEquals(options.pathPrefix, '/app')
  assertEquals(options.targetPort, 8080)
  assertEquals((options.proxy as { forceHttps?: boolean })?.forceHttps, true)
  assertEquals(db.rows(hostname).length, 1)
  assertEquals(db.rows(hostname)[0]?.hostingId, result.created[0])
  assertEquals(db.rows(hostname)[0]?.routingOrganizationId, ORG_ID)
  assertEquals(db.rows(hostname)[0]?.hostname, HOSTNAME)
})

test('reconcileHostingsFromCompose drops targetPort on site services', async () => {
  const db = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService(
        [
          {
            hostname: HOSTNAME,
            targetPort: 8080,
          },
        ],
        { serviceKind: 'site' }
      ),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected site create to succeed')
  const options = hostingRow(db, result.created[0]!)?.options as Record<string, unknown>
  assertEquals('targetPort' in options, false)
})

test('reconcileHostingsFromCompose updates an existing compose-owned row and replaces its hostname row', async () => {
  const existingId = 'host-existing'
  const db = createReconcileDb({
    hostingRows: [
      {
        id: existingId,
        serviceId: SVC_WEB,
        metadata: composeOwnedMetadata('web', ROUTE),
        options: { hostnames: [HOSTNAME], web: { env: { KEEP: '1' } } },
      },
    ],
  })
  db.rows(hostname).push({
    id: 'hn-existing',
    hostingId: existingId,
    routingOrganizationId: ORG_ID,
    hostname: HOSTNAME,
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME, forceHttps: false }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected update to succeed')
  assertEquals(result.updated, [existingId])
  assertEquals(result.created, [])
  assertEquals(db.rows(hosting).length, 1)
  const options = hostingRow(db, existingId)?.options as Record<string, unknown>
  assertEquals((options.web as { env?: Record<string, string> })?.env, {
    KEEP: '1',
  })
  assertEquals((options.proxy as { forceHttps?: boolean })?.forceHttps, false)
  // Replace-whole-array: still one row, same values, not a second row.
  assertEquals(db.rows(hostname).length, 1)
  assertEquals(db.rows(hostname)[0]?.hostingId, existingId)
  assertEquals(db.rows(hostname)[0]?.hostname, HOSTNAME)
})

test('reconcileHostingsFromCompose adopts a matching panel-authored row', async () => {
  const panelId = 'host-panel'
  const db = createReconcileDb({
    hostingRows: [
      {
        id: panelId,
        serviceId: SVC_WEB,
        metadata: { note: 'panel' },
        options: { hostnames: [HOSTNAME], pathPrefix: '/' },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected adopt to succeed')
  assertEquals(result.adopted, [panelId])
  assertEquals(result.updated, [])
  const metadata = hostingRow(db, panelId)?.metadata as Record<string, unknown>
  assertEquals(metadata.composeOwned, true)
  assertEquals(metadata.composeAdopted, true)
  assertEquals(metadata.note, 'panel')
})

test('reconcileHostingsFromCompose reports a multi-hostname panel conflict', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-multi',
        serviceId: SVC_WEB,
        metadata: {},
        options: {
          hostnames: [HOSTNAME, 'www.example.com'],
          pathPrefix: '/',
        },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result, {
    ok: false,
    error: {
      kind: 'hosting_route_conflict',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      pathPrefix: '/',
      hostingId: 'host-multi',
      otherHostnames: ['www.example.com'],
    },
  })
})

test('reconcileHostingsFromCompose ignores tcp panel rows and other services', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-tcp',
        serviceId: SVC_WEB,
        metadata: {},
        options: { hostnames: [HOSTNAME], protocol: 'tcp' },
      },
      {
        id: 'host-other',
        serviceId: SVC_OTHER,
        metadata: {},
        options: { hostnames: [HOSTNAME], pathPrefix: '/' },
      },
      {
        id: 'host-path',
        serviceId: SVC_WEB,
        metadata: {},
        options: { hostnames: [HOSTNAME], pathPrefix: '/other' },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create after ignored panel rows')
  assertEquals(result.created.length, 1)
  assertEquals(db.rows(hosting).length, 4)
})

function automaticDoc(entry: Record<string, unknown> = {}): ComposeDocument {
  return composeDoc({
    web: hostingService([{ hostname: HOSTNAME, tls: { mode: 'automatic' }, ...entry }]),
  })
}

function reconcileAutomatic(
  db: ReturnType<typeof createReconcileDb>,
  entry: Record<string, unknown> = {}
) {
  return reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: automaticDoc(entry),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
}

function managedRow(id: string, dnsNames: string[]): TlsSeed {
  return { id, label: null, source: 'lets_encrypt', status: 'automatic', metadata: { dnsNames } }
}

test('reconcileHostingsFromCompose pins a new managed Lets Encrypt row for tls.mode automatic', async () => {
  const db = createReconcileDb({ acmeEnabled: true })
  const result = await reconcileAutomatic(db, { www: 'www-to-root' })
  if (!result.ok) throw new TypeError(`expected automatic pin, got ${result.error.kind}`)
  const [created] = db.rows(tls)
  assertEquals(created.source, 'lets_encrypt')
  assertEquals(created.status, 'automatic')
  assertEquals(created.name, null)
  assertEquals(created.privateKeyPem, null)
  assertEquals((created.metadata as { dnsNames: string[] }).dnsNames, [HOSTNAME, `www.${HOSTNAME}`])
  const row = hostingRow(db, result.created[0])
  assertEquals(row?.tlsId, created.id)
  assertEquals((row?.metadata as Record<string, unknown>).composeTlsMode, 'automatic')
})

test('reconcileHostingsFromCompose keeps one managed row across repeated deploys', async () => {
  const db = createReconcileDb({ acmeEnabled: true })
  const first = await reconcileAutomatic(db)
  const second = await reconcileAutomatic(db)
  if (!first.ok || !second.ok) throw new TypeError('expected both reconciles to pin')
  assertEquals(db.rows(tls).length, 1)
  assertEquals(second.updated, first.created)
  assertEquals(hostingRow(db, first.created[0])?.tlsId, db.rows(tls)[0].id)
})

test('reconcileHostingsFromCompose reuses an existing Lets Encrypt row covering the hostname', async () => {
  const db = createReconcileDb({
    acmeEnabled: true,
    tlsRows: [
      managedRow('tls-other', ['other.example.com']),
      managedRow('tls-covering', [`www.${HOSTNAME}`, HOSTNAME]),
    ],
  })
  const result = await reconcileAutomatic(db)
  if (!result.ok) throw new TypeError('expected automatic pin')
  assertEquals(db.rows(tls).length, 2)
  assertEquals(hostingRow(db, result.created[0])?.tlsId, 'tls-covering')
})

test('reconcileHostingsFromCompose prefers the row with exactly the needed names', async () => {
  const db = createReconcileDb({
    acmeEnabled: true,
    tlsRows: [
      managedRow('tls-covering', [HOSTNAME, `www.${HOSTNAME}`]),
      managedRow('tls-exact', [HOSTNAME]),
    ],
  })
  const result = await reconcileAutomatic(db)
  if (!result.ok) throw new TypeError('expected automatic pin')
  assertEquals(hostingRow(db, result.created[0])?.tlsId, 'tls-exact')
})

test('reconcileHostingsFromCompose does not reuse a revoked or uploaded row for automatic', async () => {
  const db = createReconcileDb({
    acmeEnabled: true,
    tlsRows: [
      { ...managedRow('tls-revoked', [HOSTNAME]), status: 'revoked' },
      { id: 'tls-upload', label: 'mine', metadata: { dnsNames: [HOSTNAME] } },
    ],
  })
  const result = await reconcileAutomatic(db)
  if (!result.ok) throw new TypeError('expected automatic pin')
  const pinned = hostingRow(db, result.created[0])?.tlsId
  assertEquals(db.rows(tls).length, 3)
  assertEquals(pinned === 'tls-revoked' || pinned === 'tls-upload', false)
})

for (const acmeEnabled of [false, undefined]) {
  test(`reconcileHostingsFromCompose refuses automatic while Lets Encrypt is off (${acmeEnabled})`, async () => {
    const db = createReconcileDb({ acmeEnabled })
    const result = await reconcileAutomatic(db)
    if (result.ok) throw new TypeError('expected a refusal')
    assertEquals(result.error, {
      kind: 'hosting_letsencrypt_refused',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      reason: 'lets_encrypt_not_enabled',
      names: [HOSTNAME],
    })
    assertEquals(db.rows(tls).length, 0)
    assertEquals(db.rows(hosting).length, 0)
  })
}

test('reconcileHostingsFromCompose refuses automatic on a route that is not public', async () => {
  const db = createReconcileDb({ acmeEnabled: true })
  const result = await reconcileAutomatic(db, { bind: { scope: 'datacenter' } })
  if (result.ok) throw new TypeError('expected a refusal')
  assertEquals(result.error.kind, 'hosting_letsencrypt_refused')
  if (result.error.kind !== 'hosting_letsencrypt_refused') return
  assertEquals(result.error.reason, 'acme_requires_public_bind')
  assertEquals(db.rows(tls).length, 0)
})

test('reconcileHostingsFromCompose refuses automatic for a wildcard name', async () => {
  const db = createReconcileDb({ acmeEnabled: true })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: '*.example.com', tls: { mode: 'automatic' } }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (result.ok) throw new TypeError('expected a refusal')
  assertEquals(result.error.kind, 'hosting_letsencrypt_refused')
  if (result.error.kind !== 'hosting_letsencrypt_refused') return
  assertEquals(result.error.reason, 'letsencrypt_hostname_unsupported')
})

test('reconcileHostingsFromCompose takes the organization lock before creating a managed row', async () => {
  executed.length = 0
  const result = await reconcileAutomatic(createReconcileDb({ acmeEnabled: true }))
  if (!result.ok) throw new TypeError('expected automatic pin')
  assertEquals(executed.length, 1)
})

test('reconcileHostingsFromCompose does not reuse a row lacking the www name the route adds', async () => {
  const db = createReconcileDb({
    acmeEnabled: true,
    tlsRows: [managedRow('tls-bare', [HOSTNAME])],
  })
  const result = await reconcileAutomatic(db, { www: 'www-to-root' })
  if (!result.ok) throw new TypeError('expected automatic pin')
  const pinned = hostingRow(db, result.created[0])?.tlsId
  const row = db.rows(tls).find((candidate) => candidate.id === pinned)
  assertEquals(pinned === 'tls-bare', false)
  assertEquals((row?.metadata as { dnsNames: string[] }).dnsNames, [HOSTNAME, `www.${HOSTNAME}`])
})

function waitingComposeRow(tlsMode: string): ExistingRow & Record<string, unknown> {
  return {
    id: 'hosting-waiting',
    serviceId: SVC_WEB,
    pendingAt: '2026-10-25T00:00:00.000Z',
    metadata: {
      ...composeOwnedMetadata('web', ROUTE),
      composeTlsMode: tlsMode,
      letsEncryptDns: { ready: false, checkedAt: '2026-10-25T00:00:00.000Z', hostnames: [] },
    },
    options: { hostnames: [HOSTNAME] },
  }
}

test('reconcileHostingsFromCompose clears a waiting Lets Encrypt request once the route stops asking for it', async () => {
  const db = createReconcileDb({ hostingRows: [waitingComposeRow('automatic')] })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: hostingService([{ hostname: HOSTNAME }]) }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected an update')
  const row = hostingRow(db, 'hosting-waiting')
  assertEquals(row?.pendingAt, null)
  assertEquals((row?.metadata as Record<string, unknown>).letsEncryptDns, undefined)
  assertEquals((row?.metadata as Record<string, unknown>).composeTlsMode, 'internal')
})

test('reconcileHostingsFromCompose keeps a waiting request while the route asks for automatic', async () => {
  const db = createReconcileDb({
    acmeEnabled: true,
    hostingRows: [waitingComposeRow('automatic')],
  })
  const result = await reconcileAutomatic(db)
  if (!result.ok) throw new TypeError('expected an update')
  const row = hostingRow(db, 'hosting-waiting')
  assertEquals(row?.pendingAt, '2026-10-25T00:00:00.000Z')
  assertEquals(
    ((row?.metadata as Record<string, unknown>).letsEncryptDns as { ready: boolean }).ready,
    false
  )
})

test('reconcileHostingsFromCompose reports unresolved and ambiguous TLS refs', async () => {
  const missing = await reconcileHostingsFromCompose(
    createReconcileDb({ tlsRows: [{ id: 'tls-1', label: 'other' }] }),
    {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({
        web: hostingService([
          {
            hostname: HOSTNAME,
            tls: { mode: 'certificate', certificateRef: 'missing-cert' },
          },
        ]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    }
  )
  assertEquals(missing, {
    ok: false,
    error: {
      kind: 'hosting_tls_ref_unresolved',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      ref: 'missing-cert',
      reason: 'not_found',
    },
  })

  const ambiguous = await reconcileHostingsFromCompose(
    createReconcileDb({
      tlsRows: [
        { id: 'tls-a', label: 'shared' },
        { id: 'tls-b', label: 'shared' },
      ],
    }),
    {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({
        web: hostingService([
          {
            hostname: HOSTNAME,
            tls: { mode: 'certificate', certificateRef: 'shared' },
          },
        ]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    }
  )
  assertEquals(ambiguous.ok, false)
  if (ambiguous.ok) throw new TypeError('expected ambiguous TLS ref')
  assertEquals(ambiguous.error, {
    kind: 'hosting_tls_ref_unresolved',
    composeServiceName: 'web',
    hostname: HOSTNAME,
    ref: 'shared',
    reason: 'ambiguous',
  })
})

test('reconcileHostingsFromCompose reports unresolved IP refs', async () => {
  const result = await reconcileHostingsFromCompose(
    createReconcileDb({ ipRows: [{ id: 'ip-1', label: '203.0.113.10' }] }),
    {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({
        web: hostingService([
          {
            hostname: HOSTNAME,
            bind: { scope: 'public', ipRef: '198.51.100.10' },
          },
        ]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    }
  )
  assertEquals(result, {
    ok: false,
    error: {
      kind: 'hosting_ip_ref_unresolved',
      composeServiceName: 'web',
      hostname: HOSTNAME,
      ref: '198.51.100.10',
      reason: 'not_found',
    },
  })
})

test('reconcileHostingsFromCompose skips a declaration whose service row is missing', async () => {
  const db = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      ghost: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [],
  })
  if (!result.ok) throw new TypeError('expected skip-missing-service to succeed')
  assertEquals(result.created, [])
  assertEquals(db.rows(hosting), [])
})

test('reconcileHostingsFromCompose deletes orphaned compose-owned rows, cascading their hostname row', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-orphan',
        serviceId: SVC_WEB,
        metadata: composeOwnedMetadata('web', 'gone.example.com /'),
        options: { hostnames: ['gone.example.com'] },
      },
    ],
  })
  db.rows(hostname).push({
    id: 'hn-orphan',
    hostingId: 'host-orphan',
    routingOrganizationId: ORG_ID,
    hostname: 'gone.example.com',
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: { image: 'nginx:alpine' } }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected prune to succeed')
  assertEquals(result.removed, ['host-orphan'])
  assertEquals(result.released, [])
  assertEquals(db.rows(hosting), [])
  // `hostname.hosting_id` FK is `onDelete: cascade` in real Postgres — this
  // in-memory double does not model FK cascade, so the prune itself must not
  // rely on it. It doesn't: `pruneOrphanedComposeRows` only ever deletes
  // `hosting` rows, and the real database enforces the rest.
})

test('reconcileHostingsFromCompose releases adopted rows when the declaration disappears', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-adopted',
        serviceId: SVC_WEB,
        metadata: composeOwnedMetadata('web', 'old.example.com /', true),
        options: { hostnames: ['old.example.com'] },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: { image: 'nginx:alpine' } }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected release to succeed')
  assertEquals(result.released, ['host-adopted'])
  assertEquals(result.removed, [])
  assertEquals(db.rows(hosting).length, 1)
  const metadata = hostingRow(db, 'host-adopted')?.metadata as Record<string, unknown>
  assertEquals(metadata.composeOwned, undefined)
  assertEquals(metadata.composeAdopted, undefined)
})

test('reconcileHostingsFromCompose ignores compose-owned rows without a route key', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-unkeyed',
        serviceId: SVC_WEB,
        metadata: { composeOwned: true },
        options: { hostnames: [HOSTNAME] },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{ hostname: HOSTNAME }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  if (!result.ok) throw new TypeError('expected create when existing row has no route')
  assertEquals(result.created.length, 1)
  // The unkeyed row is compose-owned but never matched the declared route (no
  // route metadata to match by), so it looks orphaned and prune removes it —
  // one fresh row is all that is left, not two.
  assertEquals(result.removed, ['host-unkeyed'])
  assertEquals(db.rows(hosting).length, 1)
  assertEquals(
    typeof (hostingRow(db, result.created[0]!)?.metadata as Record<string, unknown>)[
      HOSTING_COMPOSE_ROUTE_METADATA_KEY
    ],
    'string'
  )
})

test('reconcileHostingsFromCompose retires a renamed service row before inserting its replacement', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-old',
        serviceId: SVC_WEB,
        metadata: composeOwnedMetadata('web', ROUTE),
        options: { hostnames: [HOSTNAME] },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ other: hostingService([{ hostname: HOSTNAME }]) }),
    serviceRows: [{ id: SVC_OTHER, composeServiceName: 'other' }],
  })
  if (!result.ok) throw new TypeError('expected rename to succeed')
  assertEquals(result.removed, ['host-old'])
  assertEquals(result.created.length, 1)
  assertEquals(
    db.rows(hosting).map((row) => row.serviceId),
    [SVC_OTHER]
  )
})

test('reconcileHostingsFromCompose leaves a stale row in place when a later route is rejected', async () => {
  const db = createReconcileDb({
    hostingRows: [
      {
        id: 'host-old',
        serviceId: SVC_WEB,
        metadata: composeOwnedMetadata('web', ROUTE),
        options: { hostnames: [HOSTNAME] },
      },
    ],
  })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      other: hostingService([
        {
          hostname: 'next.example.test',
          tls: { mode: 'certificate', certificateRef: 'missing-cert' },
        },
      ]),
    }),
    serviceRows: [{ id: SVC_OTHER, composeServiceName: 'other' }],
  })
  assertEquals(result.ok, false)
  // The old row was retired before the rejected route; the rollback restored it.
  assertEquals(
    db.rows(hosting).map((row) => row.id),
    ['host-old']
  )
})

test('reconcileHostingsFromCompose sets options.www from the entry and drops it once omitted', async () => {
  const db = createReconcileDb({})
  const reconcile = (entry: Record<string, unknown>) =>
    reconcileHostingsFromCompose(db, {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({ web: hostingService([entry]) }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    })
  const first = await reconcile({ hostname: HOSTNAME, www: 'root-to-www' })
  if (!first.ok) throw new TypeError('expected create with www to succeed')
  const id = first.created[0]!
  assertEquals((hostingRow(db, id)?.options as Record<string, unknown>).www, 'root-to-www')

  const second = await reconcile({ hostname: HOSTNAME })
  if (!second.ok) throw new TypeError('expected update without www to succeed')
  assertEquals(second.updated, [id])
  assertEquals('www' in (hostingRow(db, id)?.options as Record<string, unknown>), false)

  await reconcile({ hostname: HOSTNAME, www: 'both' })
  const third = await reconcile({ hostname: HOSTNAME, www: 'off' })
  if (!third.ok) throw new TypeError('expected update with www off to succeed')
  assertEquals('www' in (hostingRow(db, id)?.options as Record<string, unknown>), false)
})

for (const declared of ['canary.example.test', 'CANARY.Example.Test']) {
  test(`reconcileHostingsFromCompose refuses a declaration of the panel hostname (${declared})`, async () => {
    const db = createReconcileDb({ panelHosts: ['canary.example.test'] })
    const result = await reconcileHostingsFromCompose(db, {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({ web: hostingService([{ hostname: declared }]) }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    })
    assertEquals(result, {
      ok: false,
      error: {
        kind: 'hosting_hostname_is_panel',
        composeServiceName: 'web',
        hostname: declared.toLowerCase(),
      },
    })
    assertEquals(db.rows(hostname).length, 0)
  })
}

test('reconcileHostingsFromCompose accepts a wildcard that would textually cover the panel hostname', async () => {
  const db = createReconcileDb({ panelHosts: ['canary.example.test'] })
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({ web: hostingService([{ hostname: '*.example.test' }]) }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result.ok, true)
})
