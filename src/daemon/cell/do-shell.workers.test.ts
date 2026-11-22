/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../db/connection.ts'
import type { ShellOpenRequest } from '../../contracts/cell.ts'
import { setDaemonCellProjectionDbFactoryForTests } from './do.ts'
import { createDurableObjectDaemonCellRegistry } from './do-registry.ts'

function createNoopProjectionDb(): Db {
  const empty = () => ({ where: () => ({ limit: () => Promise.resolve([]) }) })
  return {
    select: () => ({ from: () => ({ ...empty(), innerJoin: empty }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    $client: { end: async () => undefined },
  } as unknown as Db
}

const SID = '11111111-2222-4333-8444-555555555555'

function openRequest(): ShellOpenRequest {
  return {
    sid: SID,
    orgId: 'org-1',
    userId: 'user-1',
    authSessionId: 'auth-1',
    userLabel: 'user@example.net',
    kind: 'container',
    containerId: 'abc123',
    loginUser: '',
    cols: 80,
    rows: 24,
    keySealed: 'sealed',
    idleSec: 900,
    maxSec: 3600,
    windowBytes: 262144,
    maxFrameBytes: 16384,
  }
}

beforeEach(() => {
  setDaemonCellProjectionDbFactoryForTests(createNoopProjectionDb)
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})

describe('daemon cell terminal sessions', () => {
  it('refuses to open without a signed daemon socket and lists nothing', async () => {
    const cell = createDurableObjectDaemonCellRegistry(env).getCell('test-srv-shell-offline')
    expect(await cell.shellOpen?.(openRequest())).toEqual({ ok: false, code: 'daemon_offline' })
    expect(await cell.shellList?.()).toEqual([])
    expect(await cell.shellKill?.({ all: true, reason: 'switch-off' })).toBe(0)
  })

  it('rejects a malformed open', async () => {
    const cell = createDurableObjectDaemonCellRegistry(env).getCell('test-srv-shell-bad')
    const bad = { ...openRequest(), sid: 'nope' }
    expect(await cell.shellOpen?.(bad)).toEqual({ ok: false, code: 'send_failed' })
  })

  it('a browser upgrade with no pending open gets 410, and without shell headers needs the daemon JWT', async () => {
    const stub = env.DAEMON_CELL.getByName('test-srv-shell-upgrade')
    const shell = await stub.fetch('https://cell.example.net/ws', {
      headers: {
        Upgrade: 'websocket',
        'X-Turbopanel-Cell-Shell-Sid': SID,
        'X-Turbopanel-Cell-Shell-User': 'user-1',
        'X-Turbopanel-Cell-Shell-AuthSession': 'auth-1',
      },
    })
    expect(shell.status).toBe(410)
    const daemon = await stub.fetch('https://cell.example.net/ws', {
      headers: { Upgrade: 'websocket' },
    })
    expect(daemon.status).toBe(401)
  })
})
