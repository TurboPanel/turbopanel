/**
 * Host-free coverage for the renewal sweep's handling of peer leaves: nothing
 * is renewed without a way to deliver, a failed issue is remembered, and a
 * leaf on an older Organization CA generation is due like any other kind.
 */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { mintOrganizationCa } from '../../lib/tls/index.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  isTlsLeafDue,
  renewOneTlsLeaf,
  type DueTlsLeafRow,
  type LeafRenewalSweepDeps,
} from './leaf-renewal-sweep.ts'
import { systemRotationContext } from './system-context.ts'

/** Sonar only recognises `test()`; see the note in the other host-free suites. */
const test = Deno.test.bind(Deno)

const peerRow: DueTlsLeafRow = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  serverId: '22222222-2222-4222-8222-222222222222',
  kind: 'peer',
  managedId: null,
  replicaId: null,
  caGeneration: 1,
  notAfter: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  attempts: 0,
  serverConnected: true,
  serverStatusChangedAt: null,
}

const queue: CommandQueue = { enqueue: () => Promise.resolve() }

/** Selects find nothing; updates are recorded. */
function recordingDb(): { db: Db; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = []
  const select = () => {
    const node: Record<string, unknown> = {}
    for (const name of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy'])
      node[name] = () => node
    node.limit = () => Promise.resolve([])
    node.then = (resolve: (value: unknown[]) => unknown) => resolve([])
    return node
  }
  const db = {
    select,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values)
        return { where: () => Promise.resolve([]) }
      },
    }),
  } as unknown as Db
  return { db, updates }
}

async function deps(
  deliverPeerLeaf?: LeafRenewalSweepDeps['deliverPeerLeaf']
): Promise<LeafRenewalSweepDeps> {
  const secretsConfig = parseTestSecretsConfig('deno')
  return {
    secretsConfig,
    dataEncryptionSecrets: await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption'),
    ...(deliverPeerLeaf ? { deliverPeerLeaf } : {}),
  }
}

async function renew(db: Db, sweepDeps: LeafRenewalSweepDeps) {
  return await renewOneTlsLeaf(
    systemRotationContext(sweepDeps),
    db,
    queue,
    sweepDeps,
    peerRow,
    { ingress: new Set<string>(), managed: new Set<string>() },
    {}
  )
}

test('a due peer leaf is left alone while nothing can deliver it', async () => {
  const { db, updates } = recordingDb()
  assertEquals(await renew(db, await deps()), 'skipped')
  assertEquals(updates, [])
})

test('a peer leaf that cannot be issued counts as a failed try and nothing is delivered', async () => {
  const { db, updates } = recordingDb()
  let delivered = 0
  const outcome = await renew(
    db,
    await deps(() => {
      delivered += 1
      return Promise.resolve({ ok: true })
    })
  )
  assertEquals(outcome, 'failed')
  assertEquals(delivered, 0)
  assertEquals(updates.length, 1)
  assertEquals(
    String(updates[0]?.lastError).startsWith('The peer certificate could not be issued'),
    true
  )
})

test('a peer leaf on the previous Organization CA generation is due with months left', () => {
  const notAfterIso = new Date(Date.now() + 80 * 86_400_000).toISOString()
  assertEquals(isTlsLeafDue({ notAfterIso, caGeneration: 1, activeCaGeneration: 2 }), true)
  assertEquals(isTlsLeafDue({ notAfterIso, caGeneration: 2, activeCaGeneration: 2 }), false)
})

test('a due peer leaf is issued, handed to the delivery and counted as queued', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const ca = await mintOrganizationCa({ organizationId: 'Sweep Org' })
  const rows = [
    [
      {
        daemon: null,
        metadata: null,
        hostname: 'h',
        machineKey: null,
        connected: true,
        statusChangedAt: null,
        id: 'key-1',
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
        fingerprint: 'fp',
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
        lastUsedAt: null,
      },
    ],
    [{ organizationId: 'org-1' }],
    [
      {
        id: 'ca-1',
        name: 'Organization CA',
        source: 'organization_ca',
        organizationId: 'org-1',
        status: 'automatic',
        notAfter: null,
        fingerprintSha256: 'f',
        metadata: null,
        options: null,
        certificatePem: ca.certificatePem,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        privateKeyPem: await encryptSecret(dataEncryptionSecrets, ca.privateKeyPem),
        caState: 'active',
        caGeneration: 2,
      },
    ],
    [],
  ]
  let call = 0
  const updates: Record<string, unknown>[] = []
  const select = () => {
    const result = rows[call++] ?? []
    const node: Record<string, unknown> = {}
    for (const name of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy'])
      node[name] = () => node
    node.limit = () => Promise.resolve(result)
    node.then = (resolve: (value: unknown[]) => unknown) => resolve(result)
    return node
  }
  const db = {
    select,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values)
        return { where: () => Promise.resolve([]) }
      },
    }),
  } as unknown as Db

  const delivered: string[] = []
  const sweepDeps: LeafRenewalSweepDeps = {
    secretsConfig,
    dataEncryptionSecrets,
    deliverPeerLeaf: (_db, issue) => {
      delivered.push(issue.pendingTlsLeaf.serverId)
      return Promise.resolve({ ok: true })
    },
  }
  assertEquals(await renew(db, sweepDeps), 'enqueued')
  assertEquals(delivered, [peerRow.serverId])
  assertEquals(updates.length, 1)
  assertEquals(updates[0]?.lastError, null)

  // A delivery that cannot queue the command is a failed try with its reason.
  call = 0
  const failing: LeafRenewalSweepDeps = {
    ...sweepDeps,
    deliverPeerLeaf: () => Promise.resolve({ ok: false, reason: 'server offline' }),
  }
  assertEquals(await renew(db, failing), 'failed')
  assertEquals(String(updates[1]?.lastError).includes('server offline'), true)
})
