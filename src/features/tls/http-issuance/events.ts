/**
 * What the panel does with the three messages a daemon sends back about a
 * server-placed order: `acme-issue-event`, `acme-proof-forward-ready` and
 * `acme-proof-forward-failed`. They only change the stored state; the sweep
 * sends whatever comes next. Nothing here carries or reads a certificate.
 *
 * Every message is matched to the row by request id inside the reporting
 * server's own organization, and only the server the request names may answer
 * for it: the issuing server for events, a helper that was asked for forward
 * answers. Anything else is ignored without a trace in the row.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import type {
  AcmeIssueEventMessage,
  AcmeProofForwardReportMessage,
} from '../../../contracts/cell-protocol.ts'
import { server, tls } from '../../../db/schema.ts'
import { redactUrlSecrets } from '../../upgrades/redact-url-secrets.ts'
import type { TlsAcmeMetadata } from '../../../lib/tls/types.ts'
import { applyForwardReports, nextStateForEvent, publicMarker } from './progress.ts'
import { type HttpIssuanceState, readHttpIssuanceState, withHttpIssuanceState } from './state.ts'

type Located = {
  id: string
  metadata: Record<string, unknown>
  state: HttpIssuanceState
}

/** The row holding request `requestId` for the reporting server's organization, locked for update. */
async function locate(tx: Db, serverId: string, requestId: string): Promise<Located | null> {
  const [reporter] = await tx
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!reporter?.organizationId) return null
  const [row] = await tx
    .select({ id: tls.id, metadata: tls.metadata })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, reporter.organizationId),
        eq(tls.source, 'lets_encrypt'),
        sql`${tls.metadata} -> 'httpCert' ->> 'requestId' = ${requestId}`
      )
    )
    .for('update')
    .limit(1)
  const state = row ? readHttpIssuanceState(row.metadata) : null
  return row && state
    ? { id: row.id, metadata: (row.metadata ?? {}) as Record<string, unknown>, state }
    : null
}

async function save(tx: Db, found: Located, state: HttpIssuanceState, now: Date): Promise<void> {
  const acme = publicMarker(found.metadata.acme as TlsAcmeMetadata | undefined, state)
  await tx
    .update(tls)
    .set({
      metadata: { ...withHttpIssuanceState(found.metadata, state), acme },
      updatedAt: now.toISOString(),
    })
    .where(eq(tls.id, found.id))
}

export type IssueEventInput = {
  /** The reporting server, from its daemon's login. */
  serverId: string
  requestId: string
  stage: 'started' | 'issued' | 'failed'
  reason?: string
  notAfterIso?: string
  now?: Date
}

/** Apply one `acme-issue-event`; answers whether it changed anything. */
export async function handleIssueEvent(db: Db, input: IssueEventInput): Promise<boolean> {
  const now = input.now ?? new Date()
  return await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const found = await locate(tx, input.serverId, input.requestId)
    if (found?.state.issuingServerId !== input.serverId) return false
    const names = (found.metadata.dnsNames as unknown[] | undefined) ?? []
    const expected = names.filter((n): n is string => typeof n === 'string')
    const next = nextStateForEvent(found.state, input, now, expected)
    if (next === found.state) return false
    await save(tx, found, next, now)
    return true
  })
}

export type ForwardReportInput = {
  serverId: string
  requestId: string
  ok: boolean
  reason?: string
  now?: Date
}

/** Apply one `acme-proof-forward-ready` or `-failed`; answers whether it changed anything. */
export async function handleForwardReport(db: Db, input: ForwardReportInput): Promise<boolean> {
  const now = input.now ?? new Date()
  return await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const found = await locate(tx, input.serverId, input.requestId)
    if (found?.state.endedAt !== null) return false
    const asked = found.state.forwards.some(
      (f) => f.serverId === input.serverId && f.outcome === 'pending'
    )
    if (!asked) return false
    const reason = input.reason ? redactUrlSecrets(input.reason) : undefined
    const next = applyForwardReports(
      found.state,
      [
        {
          serverId: input.serverId,
          outcome: input.ok ? 'ready' : 'failed',
          ...(reason ? { reason } : {}),
        },
      ],
      now
    )
    await save(tx, found, next, now)
    return true
  })
}

/** Whether a validated inbound frame is one of the three server-placed order replies. */
export function isHttpIssuanceMessage(message: {
  type: string
}): message is AcmeIssueEventMessage | AcmeProofForwardReportMessage {
  return (
    message.type === 'acme-issue-event' ||
    message.type === 'acme-proof-forward-ready' ||
    message.type === 'acme-proof-forward-failed'
  )
}

/** Route one validated inbound frame of the three server-placed order types to its handler. */
export async function handleHttpIssuanceInbound(
  db: Db,
  serverId: string,
  message: AcmeIssueEventMessage | AcmeProofForwardReportMessage
): Promise<void> {
  if (message.type === 'acme-issue-event') {
    await handleIssueEvent(db, {
      serverId,
      requestId: message.requestId,
      stage: message.stage,
      ...(message.reason ? { reason: message.reason } : {}),
      ...(message.notAfterIso ? { notAfterIso: message.notAfterIso } : {}),
    })
    return
  }
  await handleForwardReport(db, {
    serverId,
    requestId: message.requestId,
    ok: message.type === 'acme-proof-forward-ready',
    ...(message.reason ? { reason: message.reason } : {}),
  })
}
