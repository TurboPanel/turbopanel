/**
 * The self-hosted runtime's terminal hub: the same job the Durable Object cell
 * does on Workers, kept in this process's memory.
 *
 * It remembers the opens waiting for their browser, relays opaque frames
 * between a browser's socket and the daemon socket the session runs on, and
 * writes the close audit rows. It never holds a session key and never reads a
 * frame. Single process only: the browser's socket and the daemon's socket must
 * be on the same replica, so with more than one replica a session whose daemon
 * is connected elsewhere is refused clearly (`daemon_offline` on open).
 *
 * Runtime-neutral (no Deno or Workers API): `deno-ws.ts` plugs the sockets in.
 */
import type {
  DaemonCell,
  DaemonCellRegistry,
  ShellKillReason,
  ShellOpenRequest,
  ShellOpenResult,
  ShellSessionInfo,
} from '../contracts/cell.ts'
import type { DaemonMessage } from '../contracts/cell-protocol.ts'
import type { Db } from '../db/connection.ts'
import {
  checkShellFrame,
  controlFrameText,
  isShellSid,
  PendingShellOpens,
  peekShellFrame,
  SHELL_BROWSER_BUDGET,
  SHELL_CLOSE,
  SHELL_DAEMON_BUDGET,
  SHELL_DIR_TO_BROWSER,
  SHELL_DIR_TO_DAEMON,
  SHELL_ENDED_TTL_MS,
  SHELL_PENDING_TTL_MS,
  ShellBudget,
  type PendingShellOpen,
  type ShellSessionMeta,
} from '../contracts/shell-relay.ts'
import { findTerminalOpenAudit, recordAudit } from '../features/audit/audit-records.ts'
import {
  isShellReport,
  lateShellCloseAuditEntry,
  type ShellCloseDetail,
  type ShellReport,
  shellCloseAuditEntry,
  shellReportCloseDetail,
  shellReportFrame,
} from '../features/terminal/reports.ts'
import type { ReportSignature } from './authn/report-signature.ts'

/** The daemon socket a session runs on, as the hub sees it. */
export type HubDaemonLink = {
  connectionId: string
  /** True once the session is signed and its attach proof is accepted. */
  ready(): boolean
  /** A signed control message to the daemon; rejects when it cannot be sent. */
  send(message: DaemonMessage): Promise<void>
  sendBinary(frame: ArrayBuffer): void
}

/** A browser's terminal socket, as the hub sees it. */
export type HubBrowserLink = {
  send(data: string | ArrayBuffer): void
  close(code: number, reason: string): void
}

type LiveShell = {
  meta: ShellSessionMeta
  browser: HubBrowserLink
  browserBudget: ShellBudget
  daemonBudget: ShellBudget
}

type EndedShell = { meta: ShellSessionMeta; atMs: number; audited: boolean }

export type ShellClaim =
  { ok: true; pending: PendingShellOpen } | { ok: false; status: 403 | 410 | 503 }

export type ShellHubOptions = {
  db?: Db
  nowMs?: () => number
}

export class ShellHub {
  readonly #db: Db | undefined
  readonly #now: () => number
  readonly #daemons = new Map<string, HubDaemonLink>()
  readonly #live = new Map<string, LiveShell>()
  readonly #ended = new Map<string, EndedShell>()
  readonly #pending = new PendingShellOpens((open) => {
    void this.#endPending(open, 'expired', 'expired')
  })

  constructor(options: ShellHubOptions = {}) {
    this.#db = options.db
    this.#now = options.nowMs ?? Date.now
  }

  attachDaemon(serverId: string, link: HubDaemonLink): void {
    this.#daemons.set(serverId, link)
  }

  /** The daemon connection closed: its sessions are gone with it. */
  async detachDaemon(serverId: string, connectionId: string): Promise<void> {
    if (this.#daemons.get(serverId)?.connectionId === connectionId) this.#daemons.delete(serverId)
    const lost = { reason: 'daemon-restart', confirmed: false } as const
    const finishes: Promise<void>[] = []
    for (const open of this.#pending.list(this.#now())) {
      if (open.daemonConnectionId !== connectionId) continue
      this.#pending.delete(open.sid)
      finishes.push(this.#finish(this.#metaOf(open), lost))
    }
    for (const live of this.#live.values()) {
      if (live.meta.daemonConnectionId !== connectionId) continue
      this.#live.delete(live.meta.sid)
      live.browser.send(
        controlFrameText({
          type: 'closed',
          sid: live.meta.sid,
          reason: 'daemon-restart',
          confirmed: false,
        })
      )
      live.browser.close(SHELL_CLOSE.daemonLost, 'daemon_lost')
      finishes.push(this.#finish(live.meta, lost))
    }
    for (const ended of this.#ended.values()) {
      if (!ended.audited && ended.meta.daemonConnectionId === connectionId) {
        finishes.push(this.#finish(ended.meta, lost))
      }
    }
    await Promise.all(finishes)
  }

  /** The cell-shaped face the control plane's routes call (`shellOpen`, `shellKill`, `shellList`). */
  cellFor(serverId: string): Pick<DaemonCell, 'shellOpen' | 'shellKill' | 'shellList'> {
    return {
      shellOpen: (request) => this.#open(serverId, request),
      shellKill: (params) => this.#kill(serverId, params),
      shellList: () => Promise.resolve(this.#list(serverId)),
    }
  }

  async #open(serverId: string, request: ShellOpenRequest): Promise<ShellOpenResult> {
    const nowMs = this.#now()
    if (this.#pending.has(request.sid, nowMs) || this.#live.has(request.sid)) {
      return { ok: false, code: 'duplicate_sid' }
    }
    const daemon = this.#daemons.get(serverId)
    // The presence gate saw the daemon online, so a daemon this process does not hold
    // is connected to another replica (or just dropped): refuse, never relay across.
    if (!daemon) return { ok: false, code: 'daemon_elsewhere' }
    if (!daemon.ready()) return { ok: false, code: 'unverified' }
    const expiresAtMs = nowMs + SHELL_PENDING_TTL_MS
    // Pending before the send: the daemon may answer before the send resolves.
    this.#pending.add(
      {
        sid: request.sid,
        serverId,
        orgId: request.orgId,
        userId: request.userId,
        authSessionId: request.authSessionId,
        kind: request.kind,
        containerId: request.containerId,
        loginUser: request.loginUser,
        maxFrameBytes: request.maxFrameBytes,
        daemonConnectionId: daemon.connectionId,
        maxMs: request.maxSec * 1000,
        createdAtMs: nowMs,
        expiresAtMs,
      },
      nowMs
    )
    try {
      await daemon.send({
        type: 'shell-open',
        sid: request.sid,
        kind: request.kind,
        userId: request.userId,
        userLabel: request.userLabel,
        container: { id: request.containerId, user: request.loginUser },
        cols: request.cols,
        rows: request.rows,
        term: 'xterm-256color',
        keySealed: request.keySealed,
        idleSec: request.idleSec,
        maxSec: request.maxSec,
        windowBytes: request.windowBytes,
        maxFrameBytes: request.maxFrameBytes,
      })
    } catch {
      this.#pending.delete(request.sid)
      return { ok: false, code: 'send_failed' }
    }
    return { ok: true, expiresAtMs }
  }

  async #kill(
    serverId: string,
    params: { sid?: string; all?: true; reason: ShellKillReason }
  ): Promise<number> {
    const nowMs = this.#now()
    const wanted = (sid: string) => params.all === true || sid === params.sid
    const lives = [...this.#live.values()].filter(
      (live) => live.meta.serverId === serverId && wanted(live.meta.sid)
    )
    const pendings = this.#pending
      .list(nowMs)
      .filter((open) => open.serverId === serverId && wanted(open.sid))
    const daemon = this.#daemons.get(serverId)
    let told = false
    if (daemon?.ready()) {
      try {
        await daemon.send({
          type: 'shell-kill',
          ...(params.sid ? { sid: params.sid } : { all: true }),
          reason: params.reason,
        })
        told = true
      } catch {
        told = false
      }
    }
    const metas: ShellSessionMeta[] = []
    for (const live of lives) {
      this.#live.delete(live.meta.sid)
      metas.push(live.meta)
      this.#remember(live.meta)
      live.browser.send(
        controlFrameText({ type: 'closed', sid: live.meta.sid, reason: 'kill', confirmed: told })
      )
      live.browser.close(SHELL_CLOSE.killed, `killed:${params.reason}`)
    }
    for (const open of pendings) {
      this.#pending.delete(open.sid)
      const meta = this.#metaOf(open)
      metas.push(meta)
      this.#remember(meta)
    }
    if (!told) {
      await Promise.all(
        metas.map((meta) => this.#finish(meta, { reason: 'kill', confirmed: false }))
      )
    }
    return metas.length
  }

  #list(serverId: string): ShellSessionInfo[] {
    const out: ShellSessionInfo[] = []
    for (const open of this.#pending.list(this.#now())) {
      if (open.serverId !== serverId) continue
      out.push({
        sid: open.sid,
        userId: open.userId,
        kind: open.kind,
        containerId: open.containerId,
        loginUser: open.loginUser,
        state: 'pending',
        openedAtMs: open.createdAtMs,
        maxAtMs: open.createdAtMs + open.maxMs,
      })
    }
    for (const { meta } of this.#live.values()) {
      if (meta.serverId !== serverId) continue
      out.push({
        sid: meta.sid,
        userId: meta.userId,
        kind: meta.kind,
        containerId: meta.containerId,
        loginUser: meta.loginUser,
        state: 'connected',
        openedAtMs: meta.openedAtMs,
        maxAtMs: meta.maxAtMs,
      })
    }
    return out
  }

  /**
   * A browser's upgrade: take the pending open (single use) and check it is for
   * this user and auth session. A wrong user spends the open, so the daemon's
   * session is ended too.
   */
  claim(sid: string, userId: string, authSessionId: string): ShellClaim {
    if (!isShellSid(sid)) return { ok: false, status: 410 }
    const pending = this.#pending.take(sid, this.#now())
    if (!pending) return { ok: false, status: 410 }
    if (pending.userId !== userId || pending.authSessionId !== authSessionId) {
      void this.#endPending(pending, 'client', 'revoked')
      return { ok: false, status: 403 }
    }
    if (this.#daemons.get(pending.serverId)?.connectionId !== pending.daemonConnectionId) {
      void this.#finish(this.#metaOf(pending), { reason: 'daemon-restart', confirmed: false })
      return { ok: false, status: 503 }
    }
    return { ok: true, pending }
  }

  /** The upgrade succeeded: the browser's socket takes over the session. */
  activate(pending: PendingShellOpen, browser: HubBrowserLink): void {
    const nowMs = this.#now()
    const meta = { ...this.#metaOf(pending), openedAtMs: nowMs, maxAtMs: nowMs + pending.maxMs }
    if (pending.outcome) {
      browser.send(controlFrameText(pending.outcome))
      if (pending.outcome.type !== 'opened') {
        browser.close(SHELL_CLOSE.failed, 'failed')
        this.#remember(meta)
        return
      }
    }
    this.#live.set(meta.sid, {
      meta,
      browser,
      browserBudget: new ShellBudget(SHELL_BROWSER_BUDGET),
      daemonBudget: new ShellBudget(SHELL_DAEMON_BUDGET),
    })
    // Output the daemon sent before the browser arrived, in the order it came.
    for (const frame of pending.early ?? []) browser.send(frame)
  }

  /** A message on a browser's terminal socket: binary frames only, one session, bounded. */
  onBrowserMessage(sid: string, message: string | ArrayBuffer): void {
    const live = this.#live.get(sid)
    if (!live) return
    if (typeof message === 'string') {
      live.browser.close(SHELL_CLOSE.protocol, 'text_frame')
      return
    }
    const nowMs = this.#now()
    if (!live.browserBudget.take(message.byteLength, nowMs)) {
      live.browser.close(SHELL_CLOSE.budget, 'budget')
      return
    }
    if (nowMs >= live.meta.maxAtMs) {
      live.browser.close(SHELL_CLOSE.expired, 'expired')
      return
    }
    const verdict = checkShellFrame(new Uint8Array(message), {
      dir: SHELL_DIR_TO_DAEMON,
      sid,
      maxFrameBytes: live.meta.maxFrameBytes,
    })
    if (!verdict.ok) {
      live.browser.close(SHELL_CLOSE.protocol, verdict.reason)
      return
    }
    const daemon = this.#daemons.get(live.meta.serverId)
    if (daemon?.connectionId !== live.meta.daemonConnectionId) {
      live.browser.close(SHELL_CLOSE.daemonLost, 'daemon_lost')
      return
    }
    daemon.sendBinary(message)
  }

  /** A browser's terminal socket closed: tell the daemon, unless the session already ended. */
  async onBrowserClosed(sid: string): Promise<void> {
    const live = this.#live.get(sid)
    if (!live) return
    this.#live.delete(sid)
    this.#remember(live.meta)
    const daemon = this.#daemons.get(live.meta.serverId)
    let told = false
    if (daemon?.connectionId === live.meta.daemonConnectionId) {
      try {
        await daemon.send({
          type: 'shell-kill',
          sid,
          reason: this.#now() >= live.meta.maxAtMs ? 'expired' : 'revoked',
        })
        told = true
      } catch {
        told = false
      }
    }
    if (!told) await this.#finish(live.meta, { reason: 'daemon-restart', confirmed: false })
  }

  /** A binary frame from the daemon: only for a session that runs on this very connection. */
  onDaemonFrame(connectionId: string, frame: ArrayBuffer): void {
    const bytes = new Uint8Array(frame)
    const header = peekShellFrame(bytes)
    if (!header) return
    const nowMs = this.#now()
    const live = this.#live.get(header.sid)
    const pending = live ? null : this.#pending.get(header.sid, nowMs)
    const session = live?.meta ?? pending
    if (session?.daemonConnectionId !== connectionId) return
    const verdict = checkShellFrame(bytes, {
      dir: SHELL_DIR_TO_BROWSER,
      sid: session.sid,
      maxFrameBytes: session.maxFrameBytes,
    })
    if (!verdict.ok) return
    if (live) {
      // Only the offending session's socket closes; the daemon's control socket stays.
      if (live.daemonBudget.take(bytes.length, nowMs)) live.browser.send(frame)
      else live.browser.close(SHELL_CLOSE.budget, 'shell_budget')
      return
    }
    if (pending && this.#pending.bufferEarly(pending.sid, frame, nowMs) === 'overflow') {
      void this.#endPending(pending, 'early-overflow', 'revoked')
    }
  }

  /** `shell-opened` / `shell-closed` / `shell-error` from the daemon; false for any other type. */
  async onDaemonReport(
    serverId: string,
    connectionId: string,
    message: DaemonMessage,
    signature: ReportSignature
  ): Promise<boolean> {
    if (!isShellReport(message)) return false
    if (signature !== 'verified') return true
    const nowMs = this.#now()
    const live = this.#live.get(message.sid)
    const pending = this.#pending.get(message.sid, nowMs)
    const ended = this.#ended.get(message.sid)
    const meta = live?.meta ?? (pending ? this.#metaOf(pending) : (ended?.meta ?? null))
    if (!meta) {
      if (message.type !== 'shell-opened') await this.#closeUnknown(serverId, message)
      return true
    }
    if (meta.serverId !== serverId || meta.daemonConnectionId !== connectionId) return true

    const frame = shellReportFrame(message)
    if (live) live.browser.send(controlFrameText(frame))
    else if (pending) pending.outcome = frame
    if (message.type === 'shell-opened') return true

    await this.#finish(meta, shellReportCloseDetail(message))
    if (live) {
      this.#live.delete(meta.sid)
      live.browser.close(
        message.type === 'shell-error' ? SHELL_CLOSE.failed : SHELL_CLOSE.ended,
        message.type === 'shell-error' ? 'failed' : 'ended'
      )
    }
    return true
  }

  /** Close sessions past their hard maximum age; sweeps the pending opens. */
  reap(): void {
    const nowMs = this.#now()
    this.#pending.list(nowMs)
    for (const { meta, browser } of this.#live.values()) {
      if (nowMs >= meta.maxAtMs) browser.close(SHELL_CLOSE.expired, 'expired')
    }
  }

  #metaOf(open: PendingShellOpen): ShellSessionMeta {
    return {
      sid: open.sid,
      serverId: open.serverId,
      orgId: open.orgId,
      userId: open.userId,
      authSessionId: open.authSessionId,
      kind: open.kind,
      containerId: open.containerId,
      loginUser: open.loginUser,
      openedAtMs: open.createdAtMs,
      maxAtMs: open.createdAtMs + open.maxMs,
      maxFrameBytes: open.maxFrameBytes,
      daemonConnectionId: open.daemonConnectionId,
    }
  }

  #sweepEnded(nowMs: number): void {
    for (const [sid, ended] of this.#ended) {
      if (nowMs - ended.atMs >= SHELL_ENDED_TTL_MS) this.#ended.delete(sid)
    }
  }

  #remember(meta: ShellSessionMeta): void {
    const nowMs = this.#now()
    this.#sweepEnded(nowMs)
    if (!this.#ended.has(meta.sid)) this.#ended.set(meta.sid, { meta, atMs: nowMs, audited: false })
  }

  /** Write the close audit row once per session, whatever ended it. */
  async #finish(meta: ShellSessionMeta, detail: ShellCloseDetail): Promise<void> {
    const nowMs = this.#now()
    this.#sweepEnded(nowMs)
    if (this.#ended.get(meta.sid)?.audited) return
    this.#ended.set(meta.sid, { meta, atMs: nowMs, audited: true })
    await recordAudit(this.#db, shellCloseAuditEntry(meta, detail))
  }

  /** End a session whose browser never took it (or whose early output overflowed). */
  async #endPending(
    open: PendingShellOpen,
    closeReason: string,
    killReason: ShellKillReason
  ): Promise<void> {
    this.#pending.delete(open.sid)
    const meta = this.#metaOf(open)
    this.#remember(meta)
    const daemon = this.#daemons.get(open.serverId)
    if (daemon?.connectionId === open.daemonConnectionId) {
      try {
        await daemon.send({ type: 'shell-kill', sid: open.sid, reason: killReason })
      } catch {
        // The daemon's own pending timeout ends it; the row is written either way.
      }
    }
    await this.#finish(meta, { reason: closeReason, confirmed: false })
  }

  /** A close report for a sid this hub no longer knows: close its open row, once. */
  async #closeUnknown(
    serverId: string,
    report: Exclude<ShellReport, { type: 'shell-opened' }>
  ): Promise<void> {
    const db = this.#db
    if (!db || !isShellSid(report.sid)) return
    const open = await findTerminalOpenAudit(db, serverId, report.sid)
    if (!open || open.closed) return
    await recordAudit(
      db,
      lateShellCloseAuditEntry(serverId, report.sid, open, shellReportCloseDetail(report))
    )
  }
}

/**
 * The registry with the hub's terminal methods on every cell it hands out. The
 * cell's own methods stay bound to the cell, so a backend with private state
 * keeps working.
 */
export function withShellHub<R extends DaemonCellRegistry>(registry: R, hub: ShellHub): R {
  return new Proxy(registry, {
    get(target, prop) {
      if (prop !== 'getCell') {
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (serverId: string): DaemonCell => {
        const cell = target.getCell(serverId)
        const face = hub.cellFor(serverId)
        return new Proxy(cell, {
          get(cellTarget, cellProp) {
            if (cellProp in face) return face[cellProp as keyof typeof face]
            const value = Reflect.get(cellTarget, cellProp, cellTarget) as unknown
            return typeof value === 'function' ? value.bind(cellTarget) : value
          },
        })
      }
    },
  })
}
