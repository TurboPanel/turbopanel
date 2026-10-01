/**
 * Host-free coverage for the firewall preview sender (no Postgres): what a
 * server is sent for each mode, that nothing is sent without a queue, and that
 * a stored host answer is recorded as a preview and never as applied.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { createNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { LoadedFirewallFacts } from './facts.ts'
import { DEFAULT_FIREWALL_ORG_POLICY } from './policy.ts'
import {
  enqueueFirewallPreview,
  previewFromFacts,
  previewOfLastResult,
  recordFirewallPreviewResult,
  runFirewallPreviewSweep,
} from './preview.ts'

const test = Deno.test.bind(Deno)

const SERVER = '0192d6a0-0000-7000-8000-00000000000a'

function facts(mode: LoadedFirewallFacts['mode']): LoadedFirewallFacts {
  return {
    organizationId: '0192d6a0-0000-7000-8000-0000000000f0',
    mode,
    notes: [],
    input: {
      policy: DEFAULT_FIREWALL_ORG_POLICY,
      sshPortHint: 22,
      coLocated: false,
      controlPlaneTcpPorts: [],
      exposures: [
        {
          source: 'compose',
          scope: 'published',
          proto: 'tcp',
          ports: '8080',
          reach: 'public',
          comment: 'App web',
        },
      ],
      edicts: [],
      sources: { servers: [], datacenter: [], fabric: [] },
    },
  }
}

test('observe and managed servers are both sent as an observe preview; off is sent nothing', async () => {
  assertEquals((await previewFromFacts(facts('observe')))?.payload.mode, 'observe')
  assertEquals((await previewFromFacts(facts('managed')))?.payload.mode, 'observe')
  assertEquals(await previewFromFacts(facts('off')), null)
})

test('the desired digest is stable for the same set and changes with it', async () => {
  const first = await previewFromFacts(facts('observe'))
  const again = await previewFromFacts(facts('managed'))
  assertEquals(first?.desiredDigest, again?.desiredDigest)
  const changed = facts('observe')
  changed.input.exposures[0].ports = '9090'
  assertEquals((await previewFromFacts(changed))?.desiredDigest === first?.desiredDigest, false)
})

test('without a command queue nothing is sent and every server is reported as failed', async () => {
  const db = {} as Db
  const outcome = await enqueueFirewallPreview(
    db,
    createNoopCommandQueue(),
    { actorType: 'system', actorId: 'x' },
    [SERVER, SERVER, null]
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER] })
  assertEquals(await runFirewallPreviewSweep(db, createNoopCommandQueue()), { enqueued: 0 })
})

type Written = { values?: Record<string, unknown>; set?: Record<string, unknown> }

function recordingDb(stored: unknown): { db: Db; written: Written[] } {
  const written: Written[] = []
  const db = {
    execute: () => Promise.resolve([{ last_result: stored }]),
    insert: () => {
      const entry: Written = {}
      written.push(entry)
      const builder = {
        values: (values: Record<string, unknown>) => {
          entry.values = values
          return builder
        },
        onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
          entry.set = config.set
          return Promise.resolve()
        },
      }
      return builder
    },
  } as unknown as Db
  return { db, written }
}

const hostAnswer = {
  generation: 4,
  mode: 'observe',
  applied: false,
  digest: 'a'.repeat(64),
  ruleCount: 3,
  ipv6Applied: false,
  forwardApplied: false,
  sshPorts: [22],
  warnings: [],
  summary: 'previewed 3 rules',
  validation: { ok: true, errors: [] },
}

const storedPreview = {
  kind: 'preview',
  status: 'queued',
  desiredDigest: 'd',
  generation: 4,
  sentAt: '2026-10-01T00:00:00.000Z',
  ruleCount: 3,
  notes: [],
  host: null,
}

const sentPayload = {
  generation: 4,
  mode: 'observe',
  policy: { inputDefault: 'accept', ipv6: 'mirror' },
  rules: [],
}

test('a host answer is stored as a preview and never marks anything applied', async () => {
  const { db, written } = recordingDb(storedPreview)
  await recordFirewallPreviewResult(db, SERVER, sentPayload, hostAnswer)
  assertEquals(written.length, 1)
  const set = written[0].set as { lastDigest: string; lastResult: Record<string, unknown> }
  assertEquals(set.lastDigest, hostAnswer.digest)
  assertEquals(set.lastResult.kind, 'preview')
  assertEquals(set.lastResult.status, 'previewed')
  assertEquals('lastAppliedAt' in set, false)
  assertEquals('state' in set, false)
})

test('a kernel refusal is recorded as refused', async () => {
  const { db, written } = recordingDb(storedPreview)
  await recordFirewallPreviewResult(db, SERVER, sentPayload, {
    ...hostAnswer,
    validation: { ok: false, errors: ['iptables-restore: bad'] },
  })
  assertEquals((written[0].set!.lastResult as { status: string }).status, 'refused')
})

test('an answer for an older generation than the stored preview is ignored', async () => {
  const { db, written } = recordingDb({ ...storedPreview, generation: 5 })
  await recordFirewallPreviewResult(db, SERVER, sentPayload, hostAnswer)
  assertEquals(written.length, 0)
})

test('a result for a non-observe command is not recorded by the preview path', async () => {
  const { db, written } = recordingDb(storedPreview)
  await recordFirewallPreviewResult(db, SERVER, { ...sentPayload, mode: 'managed' }, hostAnswer)
  assertEquals(written.length, 0)
})

test('previewOfLastResult only returns stored previews', () => {
  assertEquals(previewOfLastResult(storedPreview)?.status, 'queued')
  assertEquals(previewOfLastResult(null), null)
  assertEquals(previewOfLastResult({ applied: true }), null)
})
