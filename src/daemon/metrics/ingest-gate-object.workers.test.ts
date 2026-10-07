/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDurableObjectMetricsGate, GATE_SAMPLE_BURST } from './ingest-gate.ts'

const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

describe('MetricsGateObject', () => {
  it('stores one sample, refuses its duplicate and keeps servers apart', async () => {
    const gate = createDurableObjectMetricsGate(env.METRICS_GATE)
    const a = `gate-a-${crypto.randomUUID()}`
    const b = `gate-b-${crypto.randomUUID()}`
    expect(await gate.admit(a, at(0), 3)).toEqual({ stored: true, eventsAllowed: 3 })
    const again = await gate.admit(a, at(0), 3)
    expect(again.stored).toBe(false)
    expect((await gate.admit(b, at(0), 0)).stored).toBe(true)
  })

  it('is exact under parallel calls: only the first plus the burst can pass for one minute', async () => {
    const gate = createDurableObjectMetricsGate(env.METRICS_GATE)
    const id = `gate-flood-${crypto.randomUUID()}`
    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, i) => gate.admit(id, at(i), 0))
    )
    expect(decisions.filter((d) => d.stored).length).toBe(1 + GATE_SAMPLE_BURST)
  })
})
