export { DaemonCellObject } from './daemon/cell/do.ts'

export default {
  fetch(): Response {
    return new Response('vitest daemon cell harness', { status: 404 })
  },
}
