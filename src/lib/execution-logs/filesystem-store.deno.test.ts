import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { executionLogStoreConformanceCases } from './execution-log-store.conformance.ts'
import { FilesystemExecutionLogStore } from './filesystem-store.ts'

describe('FilesystemExecutionLogStore', () => {
  for (const testCase of executionLogStoreConformanceCases) {
    it(testCase.name, async () => {
      const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
      try {
        await testCase.run(new FilesystemExecutionLogStore(root))
      } finally {
        await Deno.remove(root, { recursive: true })
      }
    })
  }

  it('writes transcripts under the state-tree date partition, owner-only', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-1', { seq: 0, bytes: new TextEncoder().encode('hi') })

      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')

      const logStat = await Deno.stat(`${root}/data/${partition}/cmd-1.log`)
      assertEquals(logStat.mode === null ? 0o600 : logStat.mode & 0o777, 0o600)
      // The index is flat and date-free so a read never has to guess the partition.
      await Deno.stat(`${root}/index/cmd-1.json`)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('replaces the plain log with a gzipped object on seal', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-2', { seq: 0, bytes: new TextEncoder().encode('output') })
      await store.seal('cmd-2')

      const partitions: string[] = []
      for await (const year of Deno.readDir(`${root}/data`)) {
        for await (const month of Deno.readDir(`${root}/data/${year.name}`)) {
          for await (const day of Deno.readDir(`${root}/data/${year.name}/${month.name}`)) {
            partitions.push(`${root}/data/${year.name}/${month.name}/${day.name}`)
          }
        }
      }
      assertEquals(partitions.length, 1)

      const names: string[] = []
      for await (const entry of Deno.readDir(partitions[0])) names.push(entry.name)
      assertEquals(names.sort(), ['cmd-2.log.gz'])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
})
