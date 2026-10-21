export { DaemonCellObject } from './daemon/cell/do.ts'
export { MetricsGateObject } from './daemon/metrics/ingest-gate-object.ts'

export default {
  fetch(): Response {
    return new Response('vitest daemon cell harness', { status: 404 })
  },
}
