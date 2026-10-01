/**
 * The firewall preview against a real database: what is queued, when a
 * generation is taken, that `off` is sent nothing, and where the host's answer
 * lands. Skips without TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { bulwark, command, organization, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { loadFirewallFacts } from './facts.ts'
import {
  enqueueFirewallPreview,
  enqueueFirewallPreviewForOrganization,
  FIREWALL_RECONCILE_COMMAND,
  previewOfLastResult,
  recordFirewallPreviewResult,
  runFirewallPreviewSweep,
} from './preview.ts'
import { readBulwark, setBulwarkMode } from './records.ts'

const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ACTOR = { actorType: 'system', actorId: '0192d6a0-0000-7000-8000-0000000000aa' }

type Db = ReturnType<typeof createDenoDb>

function recordingQueue() {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

async function withServer(fn: (db: Db, serverId: string, organizationId: string) => Promise<void>) {
  if (!dbUrl) {
    console.warn('Skipping firewall preview tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Firewall Preview Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Preview Server',
        isConnected: true,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    await fn(db, srv!.id, organizationId)
  } finally {
    const ids = await serverIds(db, organizationId)
    await forEachSequential(ids, async (id) => {
      await db.delete(command).where(eq(command.serverId, id))
      await db.delete(bulwark).where(eq(bulwark.serverId, id))
    })
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function serverIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  return rows.map((row) => row.id)
}

test('a first preview is queued as observe, stored as queued, and not repeated when nothing changed', async () => {
  await withServer(async (db, serverId) => {
    const queue = recordingQueue()
    const first = await enqueueFirewallPreview(db, queue, ACTOR, [serverId])
    assertEquals(first.queuedServerIds, [serverId])
    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]!.type, FIREWALL_RECONCILE_COMMAND)

    const view = await readBulwark(db, serverId)
    const preview = previewOfLastResult(view.lastResult)
    assertEquals(preview?.status, 'queued')
    assertEquals(view.lastAppliedAt, null)
    assertEquals(view.generation, 1)

    await enqueueFirewallPreview(db, queue, ACTOR, [serverId])
    assertEquals(queue.envelopes.length, 1)

    await enqueueFirewallPreview(db, queue, ACTOR, [serverId], { force: true })
    assertEquals(queue.envelopes.length, 2)
    assertEquals((await readBulwark(db, serverId)).generation, 1)
  })
})

test('a server with no stored preview is not refreshed by a deploy-style trigger', async () => {
  await withServer(async (db, serverId) => {
    const queue = recordingQueue()
    await enqueueFirewallPreview(db, queue, ACTOR, [serverId], { onlyIfPreviewed: true })
    assertEquals(queue.envelopes.length, 0)
  })
})

test('a server whose mode is off is sent nothing, and managed is still previewed as observe', async () => {
  await withServer(async (db, serverId, organizationId) => {
    const queue = recordingQueue()
    await setBulwarkMode(db, serverId, 'off')
    assertEquals((await enqueueFirewallPreview(db, queue, ACTOR, [serverId])).queuedServerIds, [])
    assertEquals(await runFirewallPreviewSweep(db, queue), { enqueued: 0 })
    await enqueueFirewallPreviewForOrganization(db, queue, ACTOR, organizationId)
    assertEquals(queue.envelopes.length, 0)

    await setBulwarkMode(db, serverId, 'managed')
    await enqueueFirewallPreview(db, queue, ACTOR, [serverId])
    assertEquals(queue.envelopes.length, 1)
  })
})

test('the sweep sends once after a reconnect and the host answer is stored as a preview', async () => {
  await withServer(async (db, serverId) => {
    const queue = recordingQueue()
    assertEquals(await runFirewallPreviewSweep(db, queue), { enqueued: 1 })
    assertEquals(await runFirewallPreviewSweep(db, queue), { enqueued: 0 })

    const stored = previewOfLastResult((await readBulwark(db, serverId)).lastResult)!
    const payload = {
      generation: stored.generation,
      mode: 'observe',
      policy: { inputDefault: 'accept', ipv6: 'mirror' },
      rules: [],
    }
    await recordFirewallPreviewResult(db, serverId, payload, {
      generation: stored.generation,
      mode: 'observe',
      applied: false,
      digest: 'b'.repeat(64),
      ruleCount: 0,
      ipv6Applied: false,
      forwardApplied: false,
      sshPorts: [22],
      warnings: [],
      summary: 'observed',
      validation: { ok: true, errors: [] },
    })
    const view = await readBulwark(db, serverId)
    assertEquals(previewOfLastResult(view.lastResult)?.status, 'previewed')
    assertEquals(view.lastDigest, 'b'.repeat(64))
    assertEquals(view.lastAppliedAt, null)
    assertEquals(view.state, 'idle')
  })
})

test('the facts for a bare server are observe mode, no exposures and the default ssh port', async () => {
  await withServer(async (db, serverId, organizationId) => {
    const facts = await loadFirewallFacts(db, serverId)
    assertEquals(facts?.organizationId, organizationId)
    assertEquals(facts?.mode, 'observe')
    assertEquals(facts?.input.exposures, [])
    assertEquals(facts?.input.sshPortHint, 22)
    assertEquals(await loadFirewallFacts(db, '0192d6a0-0000-7000-8000-0000000000ff'), null)
  })
})
