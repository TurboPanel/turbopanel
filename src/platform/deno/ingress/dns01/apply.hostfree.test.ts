import { assert, assertEquals } from '@std/assert'
import {
  buildPublicUrlsPayload,
  publicUrlsPayloadFingerprint,
} from '../../../../admin/public-urls-apply-run.ts'
import type { PublicUrlsApplyPayload } from '../../../../admin/routes-helpers.ts'
import type { DaemonCellRegistry } from '../../../../contracts/cell.ts'
import type { DaemonOutboundEnvelope } from '../../../../contracts/cell-protocol.ts'
import { instanceHostname, key, server, setting } from '../../../../db/schema.ts'
import {
  EDGE_TRUST_FEATURE,
  EDGE_TRUST_SETTING_KEY,
  loadEdgeTrustState,
} from '../../../../features/install/edge-trust.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import { createMemoryDb, type MemoryDb } from '../../../../test-fixtures/memory-db.ts'
import { pushHostnamesToDaemon } from './apply.ts'

const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-7000-8000-000000000001'
const DAEMON_VERSION = '0.1.22'
const FETCHED_AT = '2026-11-05T00:00:00.000Z'
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22']
const CLOUDFLARE_V6 = ['2400:cb00::/32']

function seededDb(): MemoryDb {
  return createMemoryDb([
    [
      server,
      [
        {
          id: SERVER_ID,
          organizationId: null,
          isConnected: true,
          statusChangedAt: FETCHED_AT,
          daemon: {
            projection: {
              remoteAddress: '__direct__',
              keyId: 'key-1',
              features: [EDGE_TRUST_FEATURE],
            },
          },
          metadata: {},
          hostname: 'panel-host',
          machineKey: null,
          trustLevel: 2,
        },
      ],
    ],
    [
      key,
      [
        {
          id: 'key-1',
          serverId: SERVER_ID,
          algorithm: 'Ed25519',
          publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' },
          fingerprint: 'fp-1',
          createdAt: FETCHED_AT,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    ],
    [
      instanceHostname,
      [
        {
          id: '00000000-0000-7000-8000-000000000101',
          createdAt: FETCHED_AT,
          updatedAt: FETCHED_AT,
          host: 'https://panel.example.test:8443',
          source: 'platform-ca',
          uploadedCertId: null,
          acmeLastAttemptAt: null,
          acmeLastError: null,
          notAfter: null,
          mode: 'cloudflare-proxy',
          publicPort: 8443,
          isPrimary: true,
          isDaemonDial: false,
          ingressId: null,
          acmeState: null,
          ingressState: null,
        },
      ],
    ],
    [
      setting,
      [
        {
          key: EDGE_TRUST_SETTING_KEY,
          value: {
            cloudflare: { v4: CLOUDFLARE_V4, v6: CLOUDFLARE_V6, fetchedAt: FETCHED_AT },
          },
        },
      ],
    ],
  ])
}

/** A registry whose co-located daemon is connected and takes every apply. */
function acceptingRegistry(sent: DaemonOutboundEnvelope[]): DaemonCellRegistry {
  return {
    listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
    getSnapshots: () =>
      Promise.resolve(
        new Map([[SERVER_ID, { connected: true, daemonBuild: { version: DAEMON_VERSION } }]])
      ),
    getCell: () => ({
      createRequestAndWait: (envelope: DaemonOutboundEnvelope) => {
        sent.push(envelope)
        return Promise.resolve({ status: 'done' })
      },
    }),
  } as unknown as DaemonCellRegistry
}

const DATA_ENCRYPTION = {} as DerivedSecretsConfig

test('a renewal push carries the same edge ranges as a normal apply and records the body', async () => {
  const db = seededDb()
  const expected = await buildPublicUrlsPayload({
    db,
    serverId: SERVER_ID,
    urls: ['https://panel.example.test:8443'],
    daemonVersion: DAEMON_VERSION,
    secretsConfig: undefined,
    dataEncryptionSecrets: DATA_ENCRYPTION,
    env: {},
  })
  assert(expected.edgeTrust, 'a normal apply carries the edge ranges')
  assertEquals(expected.edgeTrust.cidrs.length, CLOUDFLARE_V4.length + CLOUDFLARE_V6.length)

  const sent: DaemonOutboundEnvelope[] = []
  await pushHostnamesToDaemon(db, {
    registry: acceptingRegistry(sent),
    secretsConfig: undefined,
    dataEncryption: DATA_ENCRYPTION,
    env: {},
  })

  assertEquals(sent.length, 1)
  const envelope = sent[0] as DaemonOutboundEnvelope & PublicUrlsApplyPayload
  assertEquals(envelope.kind, 'public-urls-update')
  assertEquals(envelope.edgeTrust, expected.edgeTrust)

  const state = await loadEdgeTrustState(db)
  assertEquals(state.appliedPayloadHash, await publicUrlsPayloadFingerprint(expected))
  assertEquals(state.appliedHash, expected.edgeTrust.hash)
})
