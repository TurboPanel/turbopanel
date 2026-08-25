/**
 * Host-free coverage for schema parsers not exercised in schemas.test.ts.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { managedHaContainerNameFromService } from '../naming.ts'
import {
  parseDeploySecretPlan,
  parseManagedHaFailoverPayload,
  parseManagedHaFailoverResult,
  parseManagedHaReconcilePayload,
  parseManagedHaReconcileResult,
  parseManagedReplicationHealth,
  parsePrincipalsReconcilePayload,
  parsePrincipalsReconcileResult,
  parseTlsTrustReconcilePayload,
  parseTlsTrustReconcileResult,
} from './schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001'
const SERVER_ID = '00000000-0000-4000-8000-0000000000bb'
const HA_SERVICE_ID = '00000000-0000-4000-8000-0000000000cc'
const MEMBER_ID = '00000000-0000-4000-8000-0000000000dd'
const PEM =
  '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

test('parsePrincipalsReconcilePayload accepts principals and rejects duplicates', () => {
  assertEquals(
    parsePrincipalsReconcilePayload({
      principals: [{ principalId: PRINCIPAL_ID, username: 'deploy' }],
    }),
    {
      principals: [{ principalId: PRINCIPAL_ID, username: 'deploy' }],
    },
  )
  assertThrows(
    () =>
      parsePrincipalsReconcilePayload({
        principals: [
          { principalId: PRINCIPAL_ID, username: 'deploy' },
          { principalId: '00000000-0000-4000-8000-000000000002', username: 'deploy' },
        ],
      }),
    Error,
    'principals contains deploy more than once',
  )
  assertThrows(
    () => parsePrincipalsReconcilePayload({ principals: 'x' }),
    TypeError,
    'principals must be an array',
  )
  assertThrows(
    () => parsePrincipalsReconcilePayload(null),
    Error,
    'Invalid principals reconcile payload',
  )
})

test('parsePrincipalsReconcileResult validates integer and boolean fields', () => {
  assertEquals(
    parsePrincipalsReconcileResult({
      principalsApplied: 2,
      keysChanged: ['deploy'],
      keysRemoved: [],
      sshdReloaded: true,
      warnings: ['reloaded'],
    }),
    {
      principalsApplied: 2,
      keysChanged: ['deploy'],
      keysRemoved: [],
      sshdReloaded: true,
      warnings: ['reloaded'],
    },
  )
  assertThrows(
    () =>
      parsePrincipalsReconcileResult({
        principalsApplied: 1.5,
        keysChanged: [],
        keysRemoved: [],
        sshdReloaded: true,
        warnings: [],
      }),
    TypeError,
    'principalsApplied must be an integer',
  )
  assertThrows(
    () =>
      parsePrincipalsReconcileResult({
        principalsApplied: 1,
        keysChanged: [1],
        keysRemoved: [],
        sshdReloaded: true,
        warnings: [],
      }),
    Error,
    'keysChanged must be an array of strings',
  )
})

test('parseTlsTrustReconcilePayload validates PEM bundle and optional allowRemoval', () => {
  assertEquals(
    parseTlsTrustReconcilePayload({
      bundlePem: PEM,
      fingerprint: 'a'.repeat(64),
      allowRemoval: true,
    }),
    {
      bundlePem: PEM,
      fingerprint: 'a'.repeat(64),
      allowRemoval: true,
    },
  )
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: 'not-a-pem',
        fingerprint: 'a'.repeat(64),
      }),
    Error,
    'bundlePem must contain at least one certificate',
  )
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: PEM,
        fingerprint: 'a'.repeat(64),
        allowRemoval: 'yes',
      }),
    TypeError,
    'allowRemoval must be a boolean',
  )
})

test('parseTlsTrustReconcileResult requires applied and fingerprint', () => {
  assertEquals(
    parseTlsTrustReconcileResult({
      applied: false,
      fingerprint: 'b'.repeat(64),
    }),
    { applied: false, fingerprint: 'b'.repeat(64) },
  )
  assertThrows(
    () => parseTlsTrustReconcileResult({ applied: true, fingerprint: '' }),
    Error,
    'fingerprint must be a non-empty string',
  )
})

test('parseDeploySecretPlan accepts entries and rejects hostile paths', () => {
  assertEquals(
    parseDeploySecretPlan([
      {
        key: 'DB_PASSWORD',
        composeServiceName: 'web',
        source: 'env',
        target: 'secrets',
        relativePath: 'db_password',
        forBuild: true,
        forRuntime: false,
      },
    ]),
    [
      {
        key: 'DB_PASSWORD',
        composeServiceName: 'web',
        source: 'env',
        target: 'secrets',
        relativePath: 'db_password',
        forBuild: true,
        forRuntime: false,
      },
    ],
  )
  assertEquals(parseDeploySecretPlan(undefined), undefined)
  assertThrows(
    () => parseDeploySecretPlan({}),
    TypeError,
    'secretPlan must be an array',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'env',
          target: 'secrets',
          relativePath: '../escape',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan relativePath',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'bad/name',
          target: 'secrets',
          relativePath: 'db_password',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan source/target',
  )
  assertThrows(
    () =>
      parseDeploySecretPlan([
        {
          key: 'DB_PASSWORD',
          composeServiceName: 'web',
          source: 'env',
          target: '../secrets',
          relativePath: 'db_password',
        },
      ]),
    TypeError,
    'Invalid environment.deploy secretPlan source/target',
  )
})

test('parseManagedReplicationHealth accepts valid snapshots and drops malformed rows', () => {
  assertEquals(
    parseManagedReplicationHealth({
      state: 'streaming',
      observedAt: '2020-01-01T00:00:00.000Z',
      lagBytes: 1024,
      lagSeconds: 2,
    }),
    {
      state: 'streaming',
      observedAt: '2020-01-01T00:00:00.000Z',
      lagBytes: 1024,
      lagSeconds: 2,
    },
  )
  assertEquals(parseManagedReplicationHealth(undefined), undefined)
  assertEquals(parseManagedReplicationHealth({ state: 'bogus' }), undefined)
  assertEquals(parseManagedReplicationHealth({ state: 'streaming', observedAt: 'not-iso' }), undefined)
})

test('parseManagedHaReconcilePayload accepts raft peers and cluster members', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  const payload = parseManagedHaReconcilePayload({
    serverId: SERVER_ID,
    desired: 'present',
    raft: {
      nodeId: SERVER_ID,
      advertiseAddress: '203.0.113.10',
      httpPort: 33001,
      raftPort: 33002,
      peers: [
        {
          nodeId: '00000000-0000-4000-8000-0000000000ee',
          address: '203.0.113.11',
          raftPort: 33002,
          httpPort: 33001,
        },
      ],
    },
    clusters: [
      {
        managedId: 'managed-pg-1',
        clusterAlias: 'managed-pg-1',
        engine: 'postgres',
        members: [
          {
            memberId: MEMBER_ID,
            role: 'primary',
            replicaClass: null,
            host: 'db-1',
            port: 5432,
            promotionRule: 'prefer',
          },
        ],
        replicationUsername: 'tp_repl',
        replicationPasswordEnvelope: 'tpdaemon.v1.server.key.payload',
      },
    ],
    identity: {
      serviceId: HA_SERVICE_ID,
      composeServiceName: 'orchestrator',
      containerName,
    },
  })
  assertEquals(payload.raft?.advertiseAddress, '203.0.113.10')
  assertEquals(payload.clusters[0]?.members[0]?.promotionRule, 'prefer')

  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: 'present',
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: '203.0.113.10',
          httpPort: 33001,
          raftPort: 33002,
          peers: [{ nodeId: 'bad', address: '203.0.113.11', raftPort: 33002, httpPort: 33001 }],
        },
        clusters: [],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName,
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile raft peer',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: 'present',
        raft: null,
        clusters: [
          {
            managedId: 'managed-pg-1',
            clusterAlias: 'managed-pg-1',
            engine: 'postgres',
            members: [
              {
                memberId: MEMBER_ID,
                role: 'primary',
                replicaClass: null,
                host: 'db-1',
                port: 5432,
                promotionRule: 'prefer',
              },
            ],
            replicationUsername: 'tp_repl',
            replicationPasswordEnvelope: 'plaintext-not-allowed',
          },
        ],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName,
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile cluster',
  )
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: 'present',
        raft: null,
        clusters: [],
        identity: {
          serviceId: HA_SERVICE_ID,
          composeServiceName: 'orchestrator',
          containerName: 'wrong-name',
        },
      }),
    TypeError,
    'Invalid managed.ha.reconcile identity',
  )
})

test('parseManagedHaReconcileResult accepts optional containers', () => {
  const containerName = managedHaContainerNameFromService(HA_SERVICE_ID)
  assertEquals(
    parseManagedHaReconcileResult({
      summary: 'registered',
      registeredClusters: ['managed-pg-1'],
      restarted: false,
      containers: [
        {
          composeServiceName: 'orchestrator',
          containerId: 'cid-1',
          containerName,
          status: 'running',
          role: 'turbopanel',
        },
      ],
    }),
    {
      summary: 'registered',
      registeredClusters: ['managed-pg-1'],
      restarted: false,
      containers: [
        {
          composeServiceName: 'orchestrator',
          containerId: 'cid-1',
          containerName,
          status: 'running',
          role: 'turbopanel',
        },
      ],
    },
  )
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: 'bad',
        registeredClusters: ['../etc'],
        restarted: false,
      }),
    TypeError,
    'Invalid managed.ha.reconcile result',
  )
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: 'bad containers',
        registeredClusters: ['managed-pg-1'],
        restarted: false,
        containers: [{ composeServiceName: 'orchestrator' }],
      }),
    TypeError,
    'Invalid managed.ha.reconcile result containers',
  )
})

test('parseManagedHaFailoverPayload and result validate phase and ids', () => {
  const payload = parseManagedHaFailoverPayload({
    managedId: 'managed-pg-1',
    sourceMemberId: MEMBER_ID,
    targetMemberId: '00000000-0000-4000-8000-0000000000ee',
    phase: 'drain',
    engine: 'postgres',
    sourceHost: '10.0.0.1',
    sourcePort: 5432,
  })
  assertEquals(payload.managedId, 'managed-pg-1')
  assertEquals(payload.phase, 'drain')
  assertEquals(payload.engine, 'postgres')
  assertEquals(payload.sourceHost, '10.0.0.1')

  assertEquals(
    parseManagedHaFailoverResult({
      summary: 'drained',
      phase: 'recover',
    }),
    { summary: 'drained', phase: 'recover' },
  )

  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: 'managed-pg-1',
        sourceMemberId: MEMBER_ID,
        targetMemberId: '00000000-0000-4000-8000-0000000000ee',
        phase: 'promote',
      }),
    TypeError,
    'Invalid managed.ha.failover payload',
  )
})
