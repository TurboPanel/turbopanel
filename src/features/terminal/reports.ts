/**
 * What the control plane makes of the daemon's terminal reports and how it
 * records a session's end. Pure, shared by the Durable Object cell and the
 * self-hosted shell hub so both write the same control frames and audit rows.
 */
import type { DaemonMessage } from '../../contracts/cell-protocol.ts'
import type { ShellControlFrame, ShellSessionMeta } from '../../contracts/shell-relay.ts'
import type { AuditEntry } from '../audit/audit-records.ts'

export type ShellCloseDetail = {
  reason: string
  confirmed: boolean
  exitCode?: number
  durationMs?: number
  bytesIn?: number
  bytesOut?: number
}

export type ShellReport = Extract<
  DaemonMessage,
  { type: 'shell-opened' | 'shell-closed' | 'shell-error' }
>

export function isShellReport(message: { type: string }): message is ShellReport {
  return (
    message.type === 'shell-opened' ||
    message.type === 'shell-closed' ||
    message.type === 'shell-error'
  )
}

/** What the browser's terminal socket is told for one daemon report. */
export function shellReportFrame(report: ShellReport): ShellControlFrame {
  if (report.type === 'shell-opened') {
    return { type: 'opened', sid: report.sid, shell: report.shell, user: report.user }
  }
  if (report.type === 'shell-error') return { type: 'error', sid: report.sid, code: report.code }
  return {
    type: 'closed',
    sid: report.sid,
    reason: report.reason,
    ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
    confirmed: true,
  }
}

/** What the close audit row records for a session the daemon ended (never `shell-opened`). */
export function shellReportCloseDetail(
  report: Exclude<ShellReport, { type: 'shell-opened' }>
): ShellCloseDetail {
  if (report.type === 'shell-error') return { reason: `error:${report.code}`, confirmed: true }
  return {
    reason: report.reason,
    confirmed: true,
    ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
    durationMs: report.durationMs,
    bytesIn: report.bytesIn,
    bytesOut: report.bytesOut,
  }
}

function closeFacts(detail: ShellCloseDetail): Record<string, unknown> {
  return {
    reason: detail.reason,
    confirmed: detail.confirmed,
    ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
    ...(detail.bytesIn === undefined ? {} : { bytesIn: detail.bytesIn }),
    ...(detail.bytesOut === undefined ? {} : { bytesOut: detail.bytesOut }),
  }
}

/** The close audit row for one session the control plane still knows. */
export function shellCloseAuditEntry(meta: ShellSessionMeta, detail: ShellCloseDetail): AuditEntry {
  return {
    organizationId: meta.orgId,
    actorUserId: meta.userId,
    action: 'server.terminal.close',
    targetType: 'server',
    targetId: meta.serverId,
    context: {
      sid: meta.sid,
      kind: meta.kind,
      containerId: meta.containerId,
      loginUser: meta.loginUser,
      durationMs: detail.durationMs ?? Math.max(0, Date.now() - meta.openedAtMs),
      ...closeFacts(detail),
    },
  }
}

/** The close audit row for a session only its open row remembers (see `findTerminalOpenAudit`). */
export function lateShellCloseAuditEntry(
  serverId: string,
  sid: string,
  open: {
    organizationId: string | null
    actorUserId: string | null
    context: Record<string, unknown>
  },
  detail: ShellCloseDetail
): AuditEntry {
  return {
    organizationId: open.organizationId,
    actorUserId: open.actorUserId,
    action: 'server.terminal.close',
    targetType: 'server',
    targetId: serverId,
    context: {
      sid,
      kind: open.context.kind,
      containerId: open.context.containerId,
      loginUser: open.context.loginUser,
      ...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
      ...closeFacts(detail),
    },
  }
}
