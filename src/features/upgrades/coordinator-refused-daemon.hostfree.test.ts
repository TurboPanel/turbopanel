/**
 * A daemon the control plane refuses (`daemon_update_required`: no usable
 * version, a version below the floor, or a hello that lacks a required wire
 * feature) gets no commands, but the upgrade coordinator still sends it the
 * `update` message. That message is the only way such a daemon becomes
 * current: it needs the daemon's open connection and nothing else, and the
 * daemon has no updater of its own that runs without the control plane.
 */
import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { resolveDaemonSupport } from '../../lib/version-wire.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import type { UpgradeTarget } from './target.ts'

const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-11-03T10:00:00.000Z')
const ADMIN = '11111111-1111-4111-8111-111111111111'

function build(commit: string): NonNullable<UpgradeTarget['daemon']> {
  return {
    version: '0.1.22',
    commit,
    buildId: commit,
    builtAt: '2026-11-03T00:00:00.000Z',
    manifestUrl: `https://example.test/${commit}/manifest.json`,
  }
}

const target: UpgradeTarget = { daemon: build('new-daemon'), instance: null, ui: null }

function host(serverId: string, overrides: Partial<FleetServerFact>): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.example.net`,
    connected: true,
    commit: 'old-daemon',
    version: '0.1.21',
    features: [],
    colocated: false,
    ...overrides,
  }
}

test('a refused daemon is still sent the update message', async () => {
  const facts = [
    host('no-version', { version: null, features: [] }),
    host('below-floor', { version: '0.0.9', features: ['managed-upgrade-v1'] }),
    host('missing-feature', { version: '0.1.21', features: ['managed-upgrade-v1'] }),
    host('no-managed-upgrade', { version: null, features: [] }),
  ]
  for (const fact of facts) {
    const support = resolveDaemonSupport(fact.version, fact.features)
    assertEquals(support.status, 'unsupported', fact.serverId)
    assertEquals(support.code, 'daemon_update_required', fact.serverId)
  }

  const store = createMemoryUpgradeStore({
    facts,
    latest: { daemon: build('older-daemon'), instance: null, ui: null },
    installedUi: { commit: 'new-ui', source: 'install', at: '2026-11-03T00:00:00.000Z' },
    settings: { batch: { mode: 'percent', value: 100 } },
  })
  const sent: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      sent.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'release',
    development: false,
    now: () => new Date(T0).toISOString(),
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.22', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve(target),
  })

  const result = await coordinator.updateNow({ startedBy: ADMIN })
  assertEquals(result.ok, true)
  assertEquals(sent.map((item) => item.serverId).sort(), facts.map((f) => f.serverId).sort())
  for (const item of sent) assertEquals(item.envelope.kind, 'update')
})
