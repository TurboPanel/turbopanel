/**
 * Opening, listing and ending terminal sessions for one server.
 *
 * The route layer gathers the facts and calls these; nothing here reads the
 * request. The control plane mints the session key (32 random bytes), seals it
 * to the daemon's sealing key and hands the plain key to the browser in the
 * `POST` answer only. It never stores the key and never sees a frame.
 *
 * The `server.terminal.open` audit row is written before the `shell-open` goes
 * out, and a failed write refuses the open: a terminal never exists unrecorded.
 * The close row is written by the cell from the daemon's `shell-closed` (or as
 * "ended, unconfirmed" when the daemon connection drops).
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, server } from '../../db/schema.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import type {
  DaemonCellRegistry,
  ShellKillReason,
  ShellOpenResult,
  ShellSessionInfo,
} from '../../contracts/cell.ts'
import { base64urlDecode, base64urlEncode } from '../../lib/encoding/base64url.ts'
import { sealToRecipient } from '../../lib/panel-identity/hpke.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  SHELL_IDLE_SEC_DEFAULT,
  SHELL_MAX_FRAME_BYTES_DEFAULT,
  SHELL_MAX_SEC_CONTAINER,
  SHELL_PROTOCOL,
  SHELL_WINDOW_BYTES_DEFAULT,
} from '../../contracts/shell-relay.ts'
import { recordAudit, recordAuditOrThrow } from '../../features/audit/audit-records.ts'
import { getDaemonSealingKey } from '../../features/servers/daemon-sealing-key.ts'
import { parseServerOptions } from '../../features/servers/server-metadata.ts'
import { signShellTicket } from '../../features/terminal/ticket.ts'

/** The Docker-side facts about the container a terminal would open in. */
export type TerminalContainerFacts = {
  /** Service container on this server, owned by the server's organization. */
  owned: boolean
  running: boolean
  /** Docker's container id (the daemon's handle); empty when not owned. */
  dockerId: string
}

export async function loadServerTerminalFacts(
  db: Db,
  serverId: string
): Promise<{ organizationId: string; switchOn: boolean } | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId, options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row?.organizationId) return null
  return {
    organizationId: row.organizationId,
    switchOn: parseServerOptions(row.options)?.terminal?.container === true,
  }
}

/** A tenant container of `organizationId` on `serverId`; anything else is "not owned". */
export async function loadTerminalContainerFacts(
  db: Db,
  input: { serverId: string; organizationId: string; containerRowId: string }
): Promise<TerminalContainerFacts> {
  const none: TerminalContainerFacts = { owned: false, running: false, dockerId: '' }
  const [row] = await db
    .select({ status: container.status, dockerId: container.containerId, role: container.role })
    .from(container)
    .where(and(eq(container.id, input.containerRowId), eq(container.serverId, input.serverId)))
    .limit(1)
  if (row?.role !== 'service') return none
  const owner = await resolveEntityOrganizationId(db, 'container', input.containerRowId)
  if (owner !== input.organizationId) return none
  const dockerId = row.dockerId ?? ''
  return { owned: true, running: row.status === 'running' && dockerId !== '', dockerId }
}

export type OpenTerminalInput = {
  db: Db
  registry: DaemonCellRegistry
  ticketKeyring: DerivedSecretsConfig
  serverId: string
  organizationId: string
  userId: string
  userEmail: string
  authSessionId: string
  containerRowId: string
  dockerContainerId: string
  loginUser: string
  cols: number
  rows: number
}

export type OpenTerminalResult =
  | {
      ok: true
      sid: string
      ticket: string
      key: string
      protocol: typeof SHELL_PROTOCOL
      wsPath: string
      idleSec: number
      maxSec: number
      expiresAtMs: number
    }
  | {
      ok: false
      status: 409 | 500 | 501 | 502
      code:
        | Extract<ShellOpenResult, { ok: false }>['code']
        | 'audit_failed'
        | 'sealing_unavailable'
        | 'terminal_unsupported'
    }

export function shellWsPath(sid: string): string {
  return `/ws/client/v1/shell/${sid}`
}

export async function openTerminalSession(input: OpenTerminalInput): Promise<OpenTerminalResult> {
  // A cell without the terminal methods cannot relay one: refuse before any audit row.
  const cell = input.registry.getCell(input.serverId)
  if (!cell.shellOpen) return { ok: false, status: 501, code: 'terminal_unsupported' }
  const sealing = await getDaemonSealingKey(input.db, input.serverId)
  if (!sealing) return { ok: false, status: 409, code: 'sealing_unavailable' }

  const sid = crypto.randomUUID()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const keySealed = await sealShellKey(sealing, input.serverId, sid, key)

  try {
    await recordAuditOrThrow(input.db, {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      actorEmail: input.userEmail,
      action: 'server.terminal.open',
      targetType: 'server',
      targetId: input.serverId,
      context: {
        sid,
        serverId: input.serverId,
        kind: 'container',
        containerId: input.containerRowId,
        loginUser: input.loginUser,
      },
    })
  } catch {
    return { ok: false, status: 500, code: 'audit_failed' }
  }

  const idleSec = SHELL_IDLE_SEC_DEFAULT
  const maxSec = SHELL_MAX_SEC_CONTAINER
  const opened = await cell.shellOpen({
    sid,
    orgId: input.organizationId,
    userId: input.userId,
    authSessionId: input.authSessionId,
    userLabel: input.userEmail,
    kind: 'container',
    containerId: input.dockerContainerId,
    loginUser: input.loginUser,
    cols: input.cols,
    rows: input.rows,
    keySealed,
    idleSec,
    maxSec,
    windowBytes: SHELL_WINDOW_BYTES_DEFAULT,
    maxFrameBytes: SHELL_MAX_FRAME_BYTES_DEFAULT,
  })
  if (!opened.ok) {
    // The open row is already written: close it so the trail has no dangling open.
    await recordAudit(input.db, {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      actorEmail: input.userEmail,
      action: 'server.terminal.close',
      targetType: 'server',
      targetId: input.serverId,
      context: {
        sid,
        kind: 'container',
        containerId: input.containerRowId,
        loginUser: input.loginUser,
        reason: `open-failed:${opened.code}`,
        confirmed: false,
        durationMs: 0,
      },
    })
    return { ok: false, status: opened.code === 'send_failed' ? 502 : 409, code: opened.code }
  }

  const { ticket, expiresAtMs } = await signShellTicket(input.ticketKeyring, {
    sid,
    userId: input.userId,
    authSessionId: input.authSessionId,
    serverId: input.serverId,
    orgId: input.organizationId,
  })
  return {
    ok: true,
    sid,
    ticket,
    key: base64urlEncode(key),
    protocol: SHELL_PROTOCOL,
    wsPath: shellWsPath(sid),
    idleSec,
    maxSec,
    expiresAtMs,
  }
}

/** The session key's info string; the daemon builds the same one (lower-case sid). */
export function shellKeyInfo(sid: string): string {
  return `turbopanel shell key v1${sid.toLowerCase()}`
}

/**
 * `keySealed`: base64url of the HPKE encapsulated key (32 bytes) followed by the
 * ciphertext (key plus tag), `aad` = server id, `info` = {@link shellKeyInfo}.
 */
export async function sealShellKey(
  sealing: { kid: string; pub: string },
  serverId: string,
  sid: string,
  key: Uint8Array
): Promise<string> {
  const envelope = await sealToRecipient(
    base64urlDecode(sealing.pub),
    sealing.kid,
    serverId,
    key,
    shellKeyInfo(sid)
  )
  const enc = base64urlDecode(envelope.enc)
  const ct = base64urlDecode(envelope.ct)
  const joined = new Uint8Array(enc.length + ct.length)
  joined.set(enc, 0)
  joined.set(ct, enc.length)
  return base64urlEncode(joined)
}

/** The sessions the cell knows for one server; empty when the backend has no shell hub. */
export async function listTerminalSessions(
  registry: DaemonCellRegistry,
  serverId: string
): Promise<ShellSessionInfo[]> {
  return (await registry.getCell(serverId).shellList?.()) ?? []
}

/** End one session (`sid`) or all of them. Returns how many the cell knew. */
export async function endTerminalSessions(
  registry: DaemonCellRegistry,
  serverId: string,
  params: { sid?: string; all?: true; reason: ShellKillReason }
): Promise<number> {
  return (await registry.getCell(serverId).shellKill?.(params)) ?? 0
}
