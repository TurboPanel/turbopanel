import { assertEquals, assertThrows } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { ManagedEngineCode } from '../../features/managed/types.ts'
import {
  getResolveFleetPresence,
  setResolveFleetPresence,
} from './fleet-presence.ts'
import {
  getLoadServerStatusRecords,
  setLoadServerStatusRecords,
} from './load-server-status.ts'
import {
  getManagedHaRecoveryHooks,
  setManagedHaRecoveryHooks,
} from './managed-ha-recovery.ts'
import { registerCommandRuntimePorts } from './register-command-runtime-ports.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const fakeDb = {} as Db

test('registerCommandRuntimePorts wires HA hooks and narrows engine/registry', async () => {
  setManagedHaRecoveryHooks(null)
  setLoadServerStatusRecords(null)
  setResolveFleetPresence(null)

  let seenEngine: ManagedEngineCode | undefined
  let seenRegistry: DaemonCellRegistry | undefined
  const registry = { kind: 'test-registry' } as unknown as DaemonCellRegistry

  registerCommandRuntimePorts({
    fencePhaseFromCommandMetadata: () => 'stop',
    recoveryIdFromCommandMetadata: () => 'recovery-1',
    onFenceCommandSucceeded: async (_db, _queue, params) => {
      seenEngine = params.engine
    },
    onFenceCommandFailed: async (_db, _queue, params) => {
      seenEngine = params.engine
    },
    onPromoteSucceeded: async () => {},
    onRecoveryCommandFailed: async () => {},
    loadServerStatusRecords: async (_db, nextRegistry, serverIds) => {
      seenRegistry = nextRegistry
      return serverIds.map((serverId) => ({ serverId, connected: true }))
    },
    resolveFleetPresence: async (_db, nextRegistry, serverIds) => {
      seenRegistry = nextRegistry
      const map = new Map()
      for (const serverId of serverIds) {
        map.set(serverId, {
          connected: true,
          daemonBuild: { version: '1.2.3' },
        })
      }
      return map
    },
  })

  const hooks = getManagedHaRecoveryHooks()
  assertEquals(hooks?.fencePhaseFromCommandMetadata({}), 'stop')
  assertEquals(hooks?.recoveryIdFromCommandMetadata({}), 'recovery-1')

  await hooks?.onFenceCommandSucceeded(fakeDb, undefined, {
    recoveryId: 'recovery-1',
    commandId: 'cmd-1',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: { actorType: 'system', actorId: 'system' },
  })
  assertEquals(seenEngine, 'postgres')

  await hooks?.onFenceCommandFailed(fakeDb, undefined, {
    recoveryId: 'recovery-1',
    commandId: 'cmd-1',
    engine: 'mysql',
    actor: { actorType: 'system', actorId: 'system' },
  })
  assertEquals(seenEngine, 'mysql')

  const statuses = await getLoadServerStatusRecords()(fakeDb, registry, ['s1'])
  assertEquals(statuses, [{ serverId: 's1', connected: true }])
  assertEquals(seenRegistry, registry)

  const presence = await getResolveFleetPresence()(fakeDb, registry, ['s1'])
  assertEquals(presence.get('s1')?.connected, true)
  assertEquals(presence.get('s1')?.daemonBuild?.version, '1.2.3')
  assertEquals(seenRegistry, registry)

  setManagedHaRecoveryHooks(null)
  setLoadServerStatusRecords(null)
  setResolveFleetPresence(null)
})

test('fleet presence and server-status getters refuse an unset port', () => {
  setResolveFleetPresence(null)
  setLoadServerStatusRecords(null)
  assertThrows(
    () => getResolveFleetPresence(),
    Error,
    'resolveFleetPresence port is not registered',
  )
  assertThrows(
    () => getLoadServerStatusRecords(),
    Error,
    'loadServerStatusRecords port is not registered',
  )
})
