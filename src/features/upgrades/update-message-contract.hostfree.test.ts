import { assert, assertEquals, assertMatch } from '@std/assert'
import {
  type DaemonOutboundEnvelope,
  outboundEnvelopeToWireMessage,
} from '../../contracts/cell-protocol.ts'
import type { ReleaseArtifactKind } from '../../contracts/update-channel.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import type { UpgradeTarget, UpgradeUnitTarget } from './target.ts'
import { unitTargetFromManifest } from './target-resolve.ts'
import {
  CANARY_LATE,
  canaryBuild,
  EXACT_BUILD_MANIFEST_URL,
  INSTALLED_EARLY,
  type ReleaseBuild,
} from './testing/release-labels.ts'

/**
 * The wire contract between the control plane's upgrade coordinator and the
 * daemon's update handler (turbopaneld `src/instance/client.ts`). The field
 * NAMES are held by the contract-drift snapshot; this pins the MEANING the
 * daemon relies on: `manifestUrl` names one exact published build (a pin the
 * daemon verifies and installs, never a floating pointer it re-resolves), and
 * `targetCommit` is that build's commit, so the daemon's signed-manifest
 * commit check compares like with like. On 2026-09-27 a drift here left the
 * testing fleet failing `preflight_manifest` on every run.
 *
 * Jest/Mocha-shaped alias for {@link Deno.test} (Sonar typescript:S2187).
 */
const test = Deno.test.bind(Deno)

const NOW = '2026-09-27T20:00:00.000Z'

function pin(kind: ReleaseArtifactKind, build: ReleaseBuild): UpgradeUnitTarget {
  const target = unitTargetFromManifest(kind, 'canary', {
    version: build.version,
    commit: build.commit,
    buildId: build.version.split('canary.')[1] ?? 'build',
    builtAt: build.builtAt ?? NOW,
    channel: 'canary',
    manifestUrl: `https://github.com/TurboPanel/x/releases/download/canary/manifest.json`,
  })
  assert(target, `no ${kind} target`)
  return target
}

function host(serverId: string, overrides: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.example`,
    connected: true,
    commit: INSTALLED_EARLY.commit,
    version: INSTALLED_EARLY.version,
    builtAt: INSTALLED_EARLY.builtAt,
    features: ['managed-upgrade-v1'],
    colocated: false,
    ...overrides,
  }
}

/** The wire message with the per-dispatch identifiers normalized. */
function normalized(envelope: DaemonOutboundEnvelope): Record<string, unknown> {
  const wire = outboundEnvelopeToWireMessage(envelope) as Record<string, unknown>
  assertEquals(typeof wire.id, 'string')
  assertEquals(wire.at, NOW)
  const { id: _id, at: _at, upgradeId, ...rest } = wire
  return { ...rest, ...(upgradeId === undefined ? {} : { upgradeId: '<run>' }) }
}

test('a managed daemon update carries the exact build as a pin and its commit', async () => {
  const daemon = pin('daemon', CANARY_LATE)
  const target: UpgradeTarget = { daemon, instance: null, ui: null }
  const enqueued: DaemonOutboundEnvelope[] = []
  const coordinator = createUpgradeCoordinator({
    store: createMemoryUpgradeStore({ facts: [host('adrastea')], latest: target }),
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'canary',
    development: false,
    now: () => NOW,
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.1', commit: 'b12db099' },
    resolveTarget: () => Promise.resolve(target),
  })

  const started = await coordinator.start({ source: 'auto', startedBy: null })
  assertEquals(started.ok, true)
  assertEquals(enqueued.length, 1)

  assertEquals(normalized(enqueued[0]), {
    type: 'update',
    channel: 'canary',
    upgradeId: '<run>',
    manifestUrl: `https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-${CANARY_LATE.version}.json`,
    targetCommit: CANARY_LATE.commit,
  })
  const wire = outboundEnvelopeToWireMessage(enqueued[0]) as { manifestUrl?: string }
  assertMatch(wire.manifestUrl ?? '', EXACT_BUILD_MANIFEST_URL)
})

test('a host without the managed-upgrade feature gets a plain channel update, never a pin', async () => {
  const daemon = pin('daemon', CANARY_LATE)
  const target: UpgradeTarget = { daemon, instance: null, ui: null }
  const enqueued: DaemonOutboundEnvelope[] = []
  const coordinator = createUpgradeCoordinator({
    store: createMemoryUpgradeStore({ facts: [host('legacy', { features: [] })], latest: target }),
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'canary',
    development: false,
    now: () => NOW,
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.1', commit: 'b12db099' },
    resolveTarget: () => Promise.resolve(target),
  })

  await coordinator.start({ source: 'auto', startedBy: null })

  assertEquals(enqueued.length, 1, 'the legacy host is still dispatched')
  for (const envelope of enqueued) {
    const wire = outboundEnvelopeToWireMessage(envelope) as Record<string, unknown>
    assertEquals(wire.manifestUrl, undefined)
    assertEquals(wire.targetCommit, undefined)
  }
})

test('a self-hosted control-plane update pins the instance and UI builds and names the version', async () => {
  const daemon = pin('daemon', CANARY_LATE)
  const instanceBuild = canaryBuild(
    '0.1.1',
    '2026-09-27T19:50:06Z',
    '154d9c897dfd9acf0c596ac3bb07e9b80a9f0c90'
  )
  const uiBuild = canaryBuild(
    '0.1.1',
    '2026-09-27T19:40:00Z',
    'edb6ddd800000000000000000000000000000000'
  )
  const target: UpgradeTarget = {
    daemon,
    instance: pin('instance', instanceBuild),
    ui: pin('ui', uiBuild),
  }
  const enqueued: DaemonOutboundEnvelope[] = []
  // The panel's own daemon is already on the target, so the run goes
  // straight to the control-plane phase.
  const panel = host('panel', {
    colocated: true,
    commit: CANARY_LATE.commit,
    version: '0.1.1',
    builtAt: CANARY_LATE.builtAt,
  })
  const coordinator = createUpgradeCoordinator({
    store: createMemoryUpgradeStore({ facts: [panel], latest: target }),
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => NOW,
    colocatedServerId: 'panel',
    instanceInstalled: { version: '0.1.1', commit: 'b12db099' },
    resolveTarget: () => Promise.resolve(target),
  })

  const started = await coordinator.start({ source: 'manual', startedBy: null })
  assertEquals(started.ok, true)
  const instanceUpdate = enqueued.find((envelope) => envelope.kind === 'instance-update')
  assert(instanceUpdate, `expected an instance-update, got ${enqueued.map((e) => e.kind)}`)

  const wire = normalized(instanceUpdate)
  assertEquals(wire, {
    type: 'instance-update',
    channel: 'canary',
    upgradeId: '<run>',
    manifestUrl: `https://github.com/TurboPanel/turbopanel/releases/download/canary/manifest-${instanceBuild.version}.json`,
    uiManifestUrl: `https://github.com/TurboPanel/ui/releases/download/canary/manifest-${uiBuild.version}.json`,
    targetVersion: instanceBuild.version,
    targetCommit: instanceBuild.commit,
  })
  assertMatch(String(wire.manifestUrl), EXACT_BUILD_MANIFEST_URL)
  assertMatch(String(wire.uiManifestUrl), EXACT_BUILD_MANIFEST_URL)
})
