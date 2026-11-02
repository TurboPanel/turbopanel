import { describe, expect, it } from 'vitest'
import { buildWorkersDaemonCellForwardHeaders, CELL_TRUST_LEVEL_HEADER } from './workers-ws.ts'

describe('trust level forwarded to the cell', () => {
  it('comes from the database row, never from the client', () => {
    const raised = buildWorkersDaemonCellForwardHeaders(
      new Headers({ [CELL_TRUST_LEVEL_HEADER]: '0' }),
      { serverId: 'test-srv-trust-level', trustLevel: 1 }
    )
    expect(raised.get(CELL_TRUST_LEVEL_HEADER)).toBe('1')
    const unset = buildWorkersDaemonCellForwardHeaders(
      new Headers({ [CELL_TRUST_LEVEL_HEADER]: '2' }),
      { serverId: 'test-srv-trust-level' }
    )
    expect(unset.get(CELL_TRUST_LEVEL_HEADER)).toBe('0')
  })
})
