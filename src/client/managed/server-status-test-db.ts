import type { Db } from '../../db.ts'
import type { ServerDaemonState } from '../../daemon/authn/daemon-state.ts'

const activeDaemon: ServerDaemonState = {
  key: {
    id: 'key-1',
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp',
    createdAt: '2024-01-01T00:00:00.000Z',
  },
}

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  const limitable = { limit: (_n: number) => Promise.resolve(rows) }
  return Object.assign(promise, {
    ...limitable,
    orderBy: (..._cols: unknown[]) => Object.assign(Promise.resolve(rows), limitable),
  })
}

type ServerPresenceRow = {
  id: string
  daemon: ServerDaemonState
  metadata: null
  hostname: string
  machineKey: null
  connected: boolean
  statusChangedAt: string
}

function buildPresenceRow(serverId: string, connected: boolean): ServerPresenceRow {
  return {
    id: serverId,
    daemon: activeDaemon,
    metadata: null,
    hostname: 'host-1',
    machineKey: null,
    connected,
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }
}

/** Minimal Db double for `loadServerStatusRecords` / fleet presence reads. */
export function createServerPresenceDb(serverId: string, connected: boolean): Db {
  const row = buildPresenceRow(serverId, connected)
  return {
    select: () => ({
      from: () => ({
        where: () => queryResult([row]),
      }),
    }),
    execute: async () => [],
  } as unknown as Db
}

export type PreflightDbOptions = Readonly<{
  serverId: string
  /** When omitted or null, daemon lookup returns no row. */
  daemonState?: ServerDaemonState | null
  /** Datacenter-scope IP address string; omit for none. */
  datacenterAddress?: string | null
}>

/** Db double for `preflightManagedApplyInfrastructure` host-free paths. */
export function createPreflightDb(options: PreflightDbOptions): Db {
  const daemonState = options.daemonState === undefined
    ? activeDaemon
    : options.daemonState

  return {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ('daemon' in fields) {
            if (!daemonState) return queryResult([])
            return queryResult([{
              daemon: daemonState,
              metadata: null,
              hostname: 'host-1',
              machineKey: null,
              connected: true,
              statusChangedAt: '2024-01-01T00:00:00.000Z',
            }])
          }
          if ('address' in fields) {
            if (options.datacenterAddress) {
              return queryResult([{ address: options.datacenterAddress }])
            }
            return queryResult([])
          }
          return queryResult([])
        },
      }),
    }),
  } as unknown as Db
}
