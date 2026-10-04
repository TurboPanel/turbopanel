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
  bulwarkStateOfResult,
  enqueueFirewallPreview,
  needsTeardown,
  planWireMode,
  previewFromFacts,
  previewOfLastResult,
  recordFirewallPreviewFailure,
  recordFirewallPreviewResult,
  runFirewallPreviewSweep,
  shouldSend,
  statusOfResult,
  TEARDOWN_RESEND_MIN_MS,
  teardownBackedOff,
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

test('a result whose kind does not match what was stored is ignored as stale', async () => {
  const { db, written } = recordingDb(storedPreview)
  await recordFirewallPreviewResult(db, SERVER, { ...sentPayload, mode: 'managed' }, hostAnswer)
  assertEquals(written.length, 0)
})

test('previewOfLastResult only returns stored reconcile records', () => {
  assertEquals(previewOfLastResult(storedPreview)?.status, 'queued')
  assertEquals(previewOfLastResult({ ...storedPreview, kind: 'apply' })?.kind, 'apply')
  assertEquals(previewOfLastResult({ ...storedPreview, kind: 'other' }), null)
  assertEquals(previewOfLastResult(null), null)
  assertEquals(previewOfLastResult({ applied: true }), null)
})

test('managed is sent only when apply is allowed for this server; observe stays observe', async () => {
  const applied = await previewFromFacts(facts('managed'), { applyAllowed: true })
  assertEquals(applied?.payload.mode, 'managed')
  assertEquals(applied?.payload.rules.length, 1)
  assertEquals(
    (await previewFromFacts(facts('observe'), { applyAllowed: true }))?.payload.mode,
    'observe'
  )
  assertEquals(
    (await previewFromFacts(facts('managed'), { applyAllowed: false }))?.payload.mode,
    'observe'
  )
})

test('a server that still carries an apply is sent off (no rules) once either key is gone', async () => {
  assertEquals(planWireMode('managed', { applyAllowed: false, teardown: true }), 'off')
  assertEquals(planWireMode('observe', { applyAllowed: true, teardown: true }), 'off')
  assertEquals(planWireMode('off', { teardown: true }), 'off')
  assertEquals(planWireMode('managed', { applyAllowed: true, teardown: true }), 'managed')
  assertEquals(planWireMode('off', {}), null)
  const teardown = await previewFromFacts(facts('off'), { teardown: true })
  assertEquals(teardown?.payload.mode, 'off')
  assertEquals(teardown?.payload.rules, [])
  assertEquals(teardown?.payload.sshPorts, undefined)
})

test('teardown is owed after an apply and until the host reports the removal', () => {
  assertEquals(needsTeardown(null), false)
  assertEquals(needsTeardown({ ...storedPreview, kind: 'preview' } as never), false)
  assertEquals(needsTeardown({ ...storedPreview, kind: 'apply', status: 'refused' } as never), true)
  assertEquals(needsTeardown({ ...storedPreview, kind: 'remove', status: 'queued' } as never), true)
  assertEquals(
    needsTeardown({ ...storedPreview, kind: 'remove', status: 'removed' } as never),
    false
  )
})

test('a reconnect re-sends an unchanged preview or teardown but never re-applies an unchanged ruleset', () => {
  assertEquals(shouldSend(true, 'managed', false), true)
  assertEquals(shouldSend(false, 'managed', true), false)
  assertEquals(shouldSend(false, 'observe', true), true)
  assertEquals(shouldSend(false, 'observe', false), false)
  assertEquals(shouldSend(false, 'off', false), true)
})

test('an unchanged teardown is not re-sent within the back-off gap, a first or changed one is', () => {
  const now = Date.parse('2026-10-01T01:00:00.000Z')
  const sent = (agoMs: number, kind = 'remove') =>
    ({ ...storedPreview, kind, sentAt: new Date(now - agoMs).toISOString() }) as never
  assertEquals(teardownBackedOff(sent(1000), 'off', false, now), true)
  assertEquals(teardownBackedOff(sent(TEARDOWN_RESEND_MIN_MS + 1), 'off', false, now), false)
  assertEquals(teardownBackedOff(sent(1000), 'off', true, now), false)
  assertEquals(teardownBackedOff(sent(1000, 'apply'), 'off', false, now), false)
  assertEquals(teardownBackedOff(null, 'off', false, now), false)
  // Clock skew: a sentAt in the future never holds the teardown back.
  assertEquals(teardownBackedOff(sent(-1000), 'off', false, now), false)
  assertEquals(teardownBackedOff(sent(-TEARDOWN_RESEND_MIN_MS * 100), 'off', false, now), false)
  assertEquals(teardownBackedOff(sent(0), 'off', false, now), true)
  assertEquals(teardownBackedOff(sent(1000), 'observe', false, now), false)
})

const appliedAnswer = {
  ...hostAnswer,
  mode: 'managed',
  applied: true,
  validation: undefined,
  confirmation: { state: 'pending', deadlineAt: '2026-10-01T00:02:00.000Z', windowSeconds: 120 },
}

test('an applied answer is recorded as applied and pending until the host deadline', async () => {
  const { db, written } = recordingDb({ ...storedPreview, kind: 'apply' })
  await recordFirewallPreviewResult(db, SERVER, { ...sentPayload, mode: 'managed' }, appliedAnswer)
  const set = written[0].set as Record<string, unknown>
  assertEquals((set.lastResult as { kind: string; status: string }).kind, 'apply')
  assertEquals((set.lastResult as { status: string }).status, 'applied')
  assertEquals(set.state, 'pending')
  assertEquals(set.deadlineAt, '2026-10-01T00:02:00.000Z')
  assertEquals(typeof set.lastAppliedAt, 'string')
})

test('a reported teardown is recorded as removed and idle; a refusal moves no state', async () => {
  const { db, written } = recordingDb({ ...storedPreview, kind: 'remove' })
  await recordFirewallPreviewResult(
    db,
    SERVER,
    { ...sentPayload, mode: 'off' },
    { ...hostAnswer, mode: 'off', applied: true, digest: '', validation: undefined }
  )
  const set = written[0].set as Record<string, unknown>
  assertEquals((set.lastResult as { status: string }).status, 'removed')
  assertEquals(set.state, 'idle')
  assertEquals(set.deadlineAt, null)
  assertEquals(set.lastDigest, null)
  const refused = { ...appliedAnswer, applied: false, confirmation: undefined }
  assertEquals(statusOfResult('managed', refused as never), 'refused')
  assertEquals(bulwarkStateOfResult('refused', refused as never, 'now'), {})
})

test('an answer the daemon confirmed itself is recorded confirmed, with no deadline', async () => {
  const { db, written } = recordingDb({ ...storedPreview, kind: 'apply' })
  const answer = {
    ...appliedAnswer,
    confirmation: {
      state: 'confirmed',
      deadlineAt: '2026-10-01T00:02:00.000Z',
      windowSeconds: 120,
      autoConfirm: { ok: true, reason: 'reached the control plane' },
    },
  }
  await recordFirewallPreviewResult(db, SERVER, { ...sentPayload, mode: 'managed' }, answer)
  const set = written[0].set as Record<string, unknown>
  assertEquals(set.state, 'confirmed')
  assertEquals(set.deadlineAt, null)
})

test('a failed self-check stays pending with its deadline; a later preview with lastRollback is rolled_back', () => {
  const failed = {
    ...appliedAnswer,
    confirmation: {
      ...appliedAnswer.confirmation,
      autoConfirm: { ok: false, reason: 'could not reach the control plane' },
    },
  }
  const pending = bulwarkStateOfResult('applied', failed as never, 'now')
  assertEquals(pending.state, 'pending')
  assertEquals(pending.deadlineAt, '2026-10-01T00:02:00.000Z')
  const preview = {
    ...hostAnswer,
    lastRollback: { digest: 'c'.repeat(64), at: '2026-10-01T00:02:01.000Z', restored: 'none' },
  }
  assertEquals(bulwarkStateOfResult('previewed', preview as never, 'now'), {
    state: 'rolled_back',
    deadlineAt: null,
  })
})

const FAILED_AT = '2026-10-03T06:01:30.000Z'

test('a failed reconcile is recorded as failed with the error, generation and time', async () => {
  const { db, written } = recordingDb({ ...storedPreview, kind: 'apply' })
  await recordFirewallPreviewFailure(
    db,
    SERVER,
    { ...sentPayload, mode: 'managed' },
    'firewall rollback guard could not be armed: Access denied',
    FAILED_AT
  )
  assertEquals(written.length, 1)
  const set = written[0].set as { lastResult: Record<string, unknown> }
  assertEquals(set.lastResult.status, 'failed')
  assertEquals(set.lastResult.kind, 'apply')
  assertEquals(set.lastResult.generation, 4)
  assertEquals(set.lastResult.error, 'firewall rollback guard could not be armed: Access denied')
  assertEquals(set.lastResult.failedAt, FAILED_AT)
  assertEquals('state' in set, false)
})

test('a failure for a stale generation or kind is ignored', async () => {
  const older = recordingDb({ ...storedPreview, generation: 5 })
  await recordFirewallPreviewFailure(older.db, SERVER, sentPayload, 'boom', FAILED_AT)
  assertEquals(older.written.length, 0)
  const other = recordingDb(storedPreview)
  await recordFirewallPreviewFailure(
    other.db,
    SERVER,
    { ...sentPayload, mode: 'off' },
    'boom',
    FAILED_AT
  )
  assertEquals(other.written.length, 0)
})

test('a long daemon error is shortened', async () => {
  const { db, written } = recordingDb(storedPreview)
  await recordFirewallPreviewFailure(db, SERVER, sentPayload, 'x'.repeat(5000), FAILED_AT)
  const record = written[0].set!.lastResult as { error: string }
  assertEquals(record.error.length <= 500, true)
})

test('a later success clears the recorded failure', async () => {
  const failed = { ...storedPreview, status: 'failed', error: 'boom', failedAt: FAILED_AT }
  const { db, written } = recordingDb(failed)
  await recordFirewallPreviewResult(db, SERVER, sentPayload, hostAnswer)
  const record = written[0].set!.lastResult as Record<string, unknown>
  assertEquals(record.status, 'previewed')
  assertEquals('error' in record, false)
  assertEquals('failedAt' in record, false)
})
