/**
 * Host-free coverage for compose hosting reconcile (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { ComposeDocument } from '../../lib/compose/index.ts'
import { hostingEntryKey } from '../../lib/compose/index.ts'
import { hostname, hosting, ip, service, tls } from '../../lib/db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  HOSTING_COMPOSE_ROUTE_METADATA_KEY,
  withHostingComposeOwner,
} from '../../lib/hosting-compose-owner.ts'
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

function composeDoc(
  services: Record<string, unknown>,
): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function hostingService(
  hostingEntries: unknown[],
  extra: Record<string, unknown> = {},
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
  adopted = false,
): Record<string, unknown> {
  return withHostingComposeOwner({}, {
    composeServiceName,
    route,
    ...(adopted ? { adopted: true } : {}),
  })
}

function createReconcileDb(opts: {
  hostingRows?: ExistingRow[]
  tlsRows?: Array<{ id: string; label: string | null }>
  ipRows?: Array<{ id: string; label: string | null }>
}) {
  return createMemoryDb([
    [hosting, opts.hostingRows ?? []],
    [service, [
      { id: SVC_WEB, environmentId: ENV_ID },
      { id: SVC_OTHER, environmentId: ENV_ID },
    ]],
    [tls, (opts.tlsRows ?? []).map((row) => ({
      id: row.id,
      name: row.label,
      organizationId: ORG_ID,
    }))],
    [ip, (opts.ipRows ?? []).map((row) => ({
      id: row.id,
      address: row.label,
      organizationId: ORG_ID,
    }))],
    [hostname, []],
  ])
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
      web: hostingService([{
        hostname: HOSTNAME,
        pathPrefix: '/app',
        targetPort: 8080,
        forceHttps: true,
        tls: { mode: 'certificate', certificateRef: 'tls-1' },
        bind: { scope: 'public', ipRef: '203.0.113.10' },
      }]),
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
      web: hostingService([{
        hostname: HOSTNAME,
        targetPort: 8080,
      }], { serviceKind: 'site' }),
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
    hostingRows: [{
      id: existingId,
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', ROUTE),
      options: { hostnames: [HOSTNAME], web: { env: { KEEP: '1' } } },
    }],
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
    hostingRows: [{
      id: panelId,
      serviceId: SVC_WEB,
      metadata: { note: 'panel' },
      options: { hostnames: [HOSTNAME], pathPrefix: '/' },
    }],
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
    hostingRows: [{
      id: 'host-multi',
      serviceId: SVC_WEB,
      metadata: {},
      options: {
        hostnames: [HOSTNAME, 'www.example.com'],
        pathPrefix: '/',
      },
    }],
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

test('reconcileHostingsFromCompose refuses automatic TLS mode', async () => {
  const db = createReconcileDb({})
  const result = await reconcileHostingsFromCompose(db, {
    organizationId: ORG_ID,
    environmentId: ENV_ID,
    merged: composeDoc({
      web: hostingService([{
        hostname: HOSTNAME,
        tls: { mode: 'automatic' },
      }]),
    }),
    serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
  })
  assertEquals(result.ok, false)
  if (result.ok) throw new TypeError('expected automatic TLS refusal')
  assertEquals(result.error.kind, 'hosting_tls_mode_unsupported')
  if (result.error.kind !== 'hosting_tls_mode_unsupported') {
    throw new TypeError('expected tls mode error')
  }
  assertEquals(result.error.mode, 'automatic')
  assertEquals(result.error.hostname, HOSTNAME)
})

test('reconcileHostingsFromCompose reports unresolved and ambiguous TLS refs', async () => {
  const missing = await reconcileHostingsFromCompose(
    createReconcileDb({ tlsRows: [{ id: 'tls-1', label: 'other' }] }),
    {
      organizationId: ORG_ID,
      environmentId: ENV_ID,
      merged: composeDoc({
        web: hostingService([{
          hostname: HOSTNAME,
          tls: { mode: 'certificate', certificateRef: 'missing-cert' },
        }]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    },
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
        web: hostingService([{
          hostname: HOSTNAME,
          tls: { mode: 'certificate', certificateRef: 'shared' },
        }]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    },
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
        web: hostingService([{
          hostname: HOSTNAME,
          bind: { scope: 'public', ipRef: '198.51.100.10' },
        }]),
      }),
      serviceRows: [{ id: SVC_WEB, composeServiceName: 'web' }],
    },
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
    hostingRows: [{
      id: 'host-orphan',
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', 'gone.example.com /'),
      options: { hostnames: ['gone.example.com'] },
    }],
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
    hostingRows: [{
      id: 'host-adopted',
      serviceId: SVC_WEB,
      metadata: composeOwnedMetadata('web', 'old.example.com /', true),
      options: { hostnames: ['old.example.com'] },
    }],
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
    hostingRows: [{
      id: 'host-unkeyed',
      serviceId: SVC_WEB,
      metadata: { composeOwned: true },
      options: { hostnames: [HOSTNAME] },
    }],
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
    'string',
  )
})
