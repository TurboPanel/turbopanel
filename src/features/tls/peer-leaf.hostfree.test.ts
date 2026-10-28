/**
 * Host-free coverage for peer certificates: the minted leaf, its names and
 * purposes, the key sealed for one server only, and when a tracked leaf stays.
 */
import { assert, assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { leaf } from '../../db/schema.ts'
import {
  decryptSecretForDaemon,
  parseDaemonSecretEnvelope,
} from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintOrganizationCa, verifyCertificateSignature } from '../../lib/tls/index.ts'
import { parseCertificatePem } from '../../lib/tls/parse.ts'
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from '../../lib/tls/self-signed.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  commitPendingTlsLeafTracking,
  parsePendingTlsLeafTracking,
  pendingTlsLeafMetadata,
} from './leaf-tracking.ts'
import {
  buildPeerLeafMaterial,
  ensurePeerLeaf,
  PEER_LEAF_NAME,
  PEER_LEAF_RENEW_BEFORE_MS,
  peerLeafIsCurrent,
} from './peer-leaf.ts'

/** Sonar only recognises `test()`; see the note in the other host-free suites. */
const test = Deno.test.bind(Deno)

const DAY = 86_400_000
const serverA = {
  serverId: '11111111-1111-4111-8111-111111111111',
  keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const serverB = {
  serverId: '22222222-2222-4222-8222-222222222222',
  keyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

async function setup() {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const ca = await mintOrganizationCa({ organizationId: 'Peer Test Org' })
  return {
    secretsConfig,
    dataEncryptionSecrets,
    ca: {
      certificatePem: ca.certificatePem,
      privateKeyPem: ca.privateKeyPem,
      trustBundlePem: ca.certificatePem,
    },
  }
}

function derOf(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '')
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
}

function contains(der: Uint8Array, needle: number[]): boolean {
  return der.some((_, i) => needle.every((byte, j) => der[i + j] === byte))
}

test('a peer leaf is signed by the Organization CA, named tp-peer.internal and carries the datacenter addresses', async () => {
  const { secretsConfig, dataEncryptionSecrets, ca } = await setup()
  const material = await buildPeerLeafMaterial(secretsConfig, dataEncryptionSecrets, serverA, ca, [
    '10.8.0.5',
    'fd00::5',
  ])
  assertEquals(await verifyCertificateSignature(material.certificatePem, ca.certificatePem), true)
  assertEquals(material.caCertPem, ca.trustBundlePem)

  const parsed = await parseCertificatePem(material.certificatePem)
  assertEquals(parsed.dnsNames, [PEER_LEAF_NAME])
  assertEquals(parsed.ipAddresses.includes('10.8.0.5'), true)
  assertEquals(parsed.ipAddresses.length, 2)

  const days = (Date.parse(material.notAfter) - Date.now()) / DAY
  assert(Math.abs(days - ORGANIZATION_CA_LEAF_VALID_DAYS) < 1)

  const der = derOf(material.certificatePem)
  const serverAuth = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]
  const clientAuth = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02]
  assertEquals(contains(der, serverAuth), true)
  assertEquals(contains(der, clientAuth), false)
})

test('the peer leaf key is sealed for one server and is never in the clear', async () => {
  const { secretsConfig, dataEncryptionSecrets, ca } = await setup()
  const forA = await buildPeerLeafMaterial(secretsConfig, dataEncryptionSecrets, serverA, ca)
  const forB = await buildPeerLeafMaterial(secretsConfig, dataEncryptionSecrets, serverB, ca)

  assertEquals(forA.privateKeyEnvelope.startsWith('tpdaemon.'), true)
  assertEquals(parseDaemonSecretEnvelope(forA.privateKeyEnvelope)?.serverId, serverA.serverId)
  assertEquals(parseDaemonSecretEnvelope(forB.privateKeyEnvelope)?.serverId, serverB.serverId)

  const keyA = await decryptSecretForDaemon(secretsConfig, serverA, forA.privateKeyEnvelope)
  const keyB = await decryptSecretForDaemon(secretsConfig, serverB, forB.privateKeyEnvelope)
  assertEquals(keyA.includes('PRIVATE KEY'), true)
  assert(keyA !== keyB)

  // Server B's daemon cannot open server A's key, and neither blob leaks a PEM key.
  await assertRejects(() => decryptSecretForDaemon(secretsConfig, serverB, forA.privateKeyEnvelope))
  for (const material of [forA, forB]) {
    assertEquals(JSON.stringify(material).includes('PRIVATE KEY'), false)
    assertEquals(JSON.stringify(material).includes(keyA.split('\n')[1]!), false)
  }
  assertEquals(JSON.stringify(forB).includes(keyA.split('\n')[1]!), false)
})

test('a tracked peer leaf stays until a third of its lifetime is left, the CA generation changes or it is stale', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  const base = { caGeneration: 2, state: 'active' }

  assertEquals(peerLeafIsCurrent({ ...base, notAfter: at(60 * DAY) }, 2, now), true)
  assertEquals(
    peerLeafIsCurrent({ ...base, notAfter: at(PEER_LEAF_RENEW_BEFORE_MS) }, 2, now),
    true
  )
  assertEquals(
    peerLeafIsCurrent({ ...base, notAfter: at(PEER_LEAF_RENEW_BEFORE_MS - 1) }, 2, now),
    false
  )
  assertEquals(peerLeafIsCurrent({ ...base, notAfter: at(-DAY) }, 2, now), false)
  // A changeover bumps the generation: the old leaf is replaced even with months left.
  assertEquals(peerLeafIsCurrent({ ...base, notAfter: at(80 * DAY) }, 3, now), false)
  assertEquals(
    peerLeafIsCurrent({ ...base, state: 'stale', notAfter: at(80 * DAY) }, 2, now),
    false
  )
  assertEquals(peerLeafIsCurrent({ ...base, notAfter: 'not a date' }, 2, now), false)
  assertEquals(peerLeafIsCurrent(null, 2, now), false)
})

type SelectRows = unknown[][]

/** A db whose successive selects return the given row lists (any chain shape). */
function selectDb(results: SelectRows): { db: Db; selects: () => number } {
  let call = 0
  const chain = (rows: unknown[]) => {
    const node: Record<string, unknown> = {}
    for (const name of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy']) {
      node[name] = () => node
    }
    node.limit = () => Promise.resolve(rows)
    node.then = (resolve: (value: unknown[]) => unknown) => resolve(rows)
    return node
  }
  const db = { select: () => chain(results[call++] ?? []) } as unknown as Db
  return { db, selects: () => call }
}

test('ensurePeerLeaf keeps a current leaf and mints nothing', async () => {
  const { secretsConfig, dataEncryptionSecrets } = await setup()
  const { db, selects } = selectDb([
    [
      {
        notAfter: new Date(Date.now() + 80 * DAY).toISOString(),
        caGeneration: 2,
        state: 'active',
        activeGeneration: 2,
      },
    ],
  ])
  const outcome = await ensurePeerLeaf(db, secretsConfig, dataEncryptionSecrets, {
    organizationId: 'org-1',
    serverId: serverA.serverId,
  })
  assertEquals(outcome.status, 'current')
  assertEquals(selects(), 1)
})

test('ensurePeerLeaf issues again when the leaf is missing, near expiry or on an older generation', async () => {
  const { secretsConfig, dataEncryptionSecrets } = await setup()
  const tracked = (days: number, generation: number) => [
    {
      notAfter: new Date(Date.now() + days * DAY).toISOString(),
      caGeneration: generation,
      state: 'active',
      activeGeneration: 2,
    },
  ]
  for (const rows of [[], tracked(10, 2), tracked(80, 1)]) {
    // The second select (the server's daemon key) finds nothing, which proves it went on to issue.
    const { db, selects } = selectDb([rows])
    const outcome = await ensurePeerLeaf(db, secretsConfig, dataEncryptionSecrets, {
      organizationId: 'org-1',
      serverId: serverA.serverId,
    })
    assertEquals(outcome, {
      status: 'failed',
      error: { kind: 'daemon_key_unavailable', serverId: serverA.serverId },
    })
    assertEquals(selects(), 2)
  }
})

test('a peer leaf is tracked once per server and survives the pending command metadata', async () => {
  const conflicts: { target: unknown; targetWhere: unknown }[] = []
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (conflict: { target: unknown; targetWhere: unknown }) => {
          conflicts.push(conflict)
          return Promise.resolve(undefined)
        },
      }),
    }),
  } as unknown as Db
  const peer = {
    kind: 'peer' as const,
    organizationId: 'org-1',
    serverId: 'server-1',
    caId: 'ca-1',
    caGeneration: 3,
    notAfter: '2026-04-01T00:00:00.000Z',
  }
  assertEquals(parsePendingTlsLeafTracking(pendingTlsLeafMetadata(peer)), peer)
  assertEquals(await commitPendingTlsLeafTracking(db, pendingTlsLeafMetadata(peer)), true)
  assertEquals(conflicts.length, 1)
  assertEquals(conflicts[0]?.target, leaf.serverId)
  const where = conflicts[0]?.targetWhere as { queryChunks: { value?: string[] }[] }
  const text = where.queryChunks.flatMap((chunk) => chunk.value ?? []).join('')
  assertEquals(text.includes("'peer'"), true)
})
