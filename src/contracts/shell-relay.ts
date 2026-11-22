/**
 * The control plane's side of the web terminal transport (feature
 * `terminal-container-v1`): checks on the opaque binary frames it relays, the
 * per-socket budget, and the in-memory book of pending opens.
 *
 * The control plane never holds a session key and never reads a frame. A frame
 * is `version(1) | sid(16) | dir(1) | counter(8) | AES-256-GCM ciphertext+tag`;
 * everything past the 26-byte header is opaque here. The daemon and the browser
 * authenticate each other with the session key; this module only makes sure a
 * socket can name its own session and nothing else, in the right direction, at a
 * bounded size and rate. Twin of the daemon's `src/shell/frames.ts` header
 * layout.
 *
 * Pure and runtime-neutral: the Durable Object (`do.ts`) and the control-plane
 * routes share it.
 */

export const SHELL_PROTOCOL = 'tp-shell.v1'
export const SHELL_TICKET_PROTOCOL_PREFIX = 'tp-ticket.'

export const SHELL_FRAME_VERSION = 0x01
export const SHELL_HEADER_BYTES = 26
/** Header, the plaintext type byte and the 16-byte GCM tag. */
export const SHELL_FRAME_OVERHEAD_BYTES = SHELL_HEADER_BYTES + 1 + 16
/** The daemon's hard ceiling on one frame's plaintext. */
export const SHELL_MAX_PLAINTEXT_BYTES = 64 * 1024

export const SHELL_DIR_TO_DAEMON = 0x00
export const SHELL_DIR_TO_BROWSER = 0x01

/** What `shell-open` asks of the daemon (it clamps again on its side). */
export const SHELL_IDLE_SEC_DEFAULT = 15 * 60
export const SHELL_MAX_SEC_CONTAINER = 8 * 60 * 60
export const SHELL_WINDOW_BYTES_DEFAULT = 256 * 1024
export const SHELL_MAX_FRAME_BYTES_DEFAULT = 16 * 1024

/** A pending open is good for this long: the browser must connect inside it. */
export const SHELL_PENDING_TTL_MS = 30_000
/**
 * Daemon output that arrives before the browser does (the shell prompt) is held,
 * up to this many frames and bytes, and sent in order when the browser connects.
 * Past either bound the session is ended.
 */
export const SHELL_EARLY_MAX_FRAMES = 64
export const SHELL_EARLY_MAX_BYTES = 1024 * 1024
/** An ended session stays known this long, so a late `shell-closed` still finds it. */
export const SHELL_ENDED_TTL_MS = 5 * 60_000

/** Close codes on the browser's shell socket (4000 range = application). */
export const SHELL_CLOSE = {
  /** A text frame, a bad frame, or one not for this socket's session. */
  protocol: 4428,
  /** The socket's own message or byte budget ran out. */
  budget: 4429,
  /** Past the session's hard maximum age. */
  expired: 4430,
  /** The daemon connection the session ran on is gone. */
  daemonLost: 4431,
  /** Ended by the control plane (switch off, revoked, admin). */
  killed: 4432,
  /** The daemon refused or could not open the session. */
  failed: 4433,
  /** The shell exited, idled out or hit its maximum on the daemon. */
  ended: 1000,
} as const

/** The browser's own budget on its shell socket. */
export const SHELL_BROWSER_BUDGET = {
  windowMs: 10_000,
  maxMessages: 2000,
  maxBytes: 8 * 1024 * 1024,
} as const

/**
 * The daemon's output toward one browser. The daemon already stops reading the
 * terminal at its unacknowledged-bytes window, so this is a ceiling for a
 * misbehaving peer, not the throttle: it is much higher than the browser's.
 */
export const SHELL_DAEMON_BUDGET = {
  windowMs: 10_000,
  maxMessages: 40_000,
  maxBytes: 128 * 1024 * 1024,
} as const

/**
 * Lookups of the audit trail for a sid nobody here remembers, per daemon
 * connection. A well-behaved daemon sends one for a session that outlived a
 * deploy or eviction; a flood of them is dropped and logged.
 */
export const SHELL_LATE_CLOSE_BUDGET = {
  windowMs: 60_000,
  // Twice the daemon's 16 sessions per server: a deploy can leave that many unknown at once.
  maxMessages: 32,
  maxBytes: Number.MAX_SAFE_INTEGER,
} as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isShellSid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Largest frame (header and tag included) a session may relay. */
export function maxShellFrameBytes(maxFrameBytes: number): number {
  return Math.min(maxFrameBytes, SHELL_MAX_PLAINTEXT_BYTES) + SHELL_FRAME_OVERHEAD_BYTES
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** The session id as lower-case UUID text, from 16 raw bytes. */
export function sidFromBytes(raw: Uint8Array): string {
  const h = hex(raw)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export type ShellFrameHeader = { sid: string; dir: number; length: number }

/**
 * The routing fields of a frame, or null when it cannot be one: too short for a
 * header and a tag, or not version 1. Nothing past the header is read.
 */
export function peekShellFrame(frame: Uint8Array): ShellFrameHeader | null {
  if (frame.length < SHELL_FRAME_OVERHEAD_BYTES) return null
  if (frame[0] !== SHELL_FRAME_VERSION) return null
  const dir = frame[17]
  if (dir !== SHELL_DIR_TO_DAEMON && dir !== SHELL_DIR_TO_BROWSER) return null
  return { sid: sidFromBytes(frame.subarray(1, 17)), dir, length: frame.length }
}

/** True when a binary daemon message looks like a shell frame rather than text. */
export function looksLikeShellFrame(frame: Uint8Array): boolean {
  return frame.length >= SHELL_HEADER_BYTES && frame[0] === SHELL_FRAME_VERSION
}

export type ShellRelayVerdict =
  { ok: true } | { ok: false; reason: 'malformed' | 'direction' | 'foreign_sid' | 'oversize' }

/**
 * Whether one frame may be relayed. `expectedDir` is the direction the sender is
 * allowed to speak in; `ownSid` the one session this sender belongs to.
 */
export function checkShellFrame(
  frame: Uint8Array,
  expect: { dir: number; sid: string; maxFrameBytes: number }
): ShellRelayVerdict {
  const header = peekShellFrame(frame)
  if (!header) return { ok: false, reason: 'malformed' }
  if (header.dir !== expect.dir) return { ok: false, reason: 'direction' }
  if (header.sid !== expect.sid) return { ok: false, reason: 'foreign_sid' }
  if (header.length > maxShellFrameBytes(expect.maxFrameBytes)) {
    return { ok: false, reason: 'oversize' }
  }
  return { ok: true }
}

export type ShellBudgetLimits = { windowMs: number; maxMessages: number; maxBytes: number }

/** Fixed-window message and byte budget for one socket. In memory, no timers. */
export class ShellBudget {
  readonly #limits: ShellBudgetLimits
  #windowStartMs = 0
  #messages = 0
  #bytes = 0

  constructor(limits: ShellBudgetLimits) {
    this.#limits = limits
  }

  /** False when this message is over budget (the caller closes the socket). */
  take(bytes: number, nowMs: number): boolean {
    if (nowMs - this.#windowStartMs >= this.#limits.windowMs) {
      this.#windowStartMs = nowMs
      this.#messages = 0
      this.#bytes = 0
    }
    this.#messages += 1
    this.#bytes += bytes
    return this.#messages <= this.#limits.maxMessages && this.#bytes <= this.#limits.maxBytes
  }
}

/** One authorized open, waiting for the browser to connect. */
export type PendingShellOpen = {
  sid: string
  serverId: string
  orgId: string
  userId: string
  authSessionId: string
  kind: 'container' | 'host'
  containerId: string
  loginUser: string
  maxFrameBytes: number
  /** The daemon connection the `shell-open` went out on. */
  daemonConnectionId: string
  /** Hard maximum age of the session, from the open. */
  maxMs: number
  createdAtMs: number
  expiresAtMs: number
  /** A report that arrived before the browser did; sent to it as its first frame. */
  outcome?: ShellControlFrame
  /** The close audit row for this session was written. */
  audited?: boolean
  /** Daemon frames that arrived before the browser, in order. */
  early?: ArrayBuffer[]
  earlyBytes?: number
}

/** Pending opens by sid, each good for {@link SHELL_PENDING_TTL_MS}. Single use. */
export class PendingShellOpens {
  readonly #byId = new Map<string, PendingShellOpen>()
  readonly #onExpire?: (open: PendingShellOpen) => void

  /** `onExpire` is told of each open the TTL dropped, so its session can be ended. */
  constructor(onExpire?: (open: PendingShellOpen) => void) {
    this.#onExpire = onExpire
  }

  add(open: PendingShellOpen, nowMs: number): void {
    this.#sweep(nowMs)
    this.#byId.set(open.sid, open)
  }

  has(sid: string, nowMs: number): boolean {
    this.#sweep(nowMs)
    return this.#byId.has(sid)
  }

  get(sid: string, nowMs: number): PendingShellOpen | null {
    this.#sweep(nowMs)
    return this.#byId.get(sid) ?? null
  }

  /** Remove and return the open for `sid`; a second take finds nothing. */
  take(sid: string, nowMs: number): PendingShellOpen | null {
    this.#sweep(nowMs)
    const open = this.#byId.get(sid) ?? null
    if (open) this.#byId.delete(sid)
    return open
  }

  /**
   * Hold one daemon frame for a browser that has not connected yet. `overflow`
   * means a bound was crossed (the caller ends the session); `unknown` that no
   * open is pending for the sid.
   */
  bufferEarly(sid: string, frame: ArrayBuffer, nowMs: number): 'buffered' | 'overflow' | 'unknown' {
    const open = this.get(sid, nowMs)
    if (!open) return 'unknown'
    const frames = open.early ?? []
    const bytes = (open.earlyBytes ?? 0) + frame.byteLength
    if (frames.length >= SHELL_EARLY_MAX_FRAMES || bytes > SHELL_EARLY_MAX_BYTES) return 'overflow'
    frames.push(frame)
    open.early = frames
    open.earlyBytes = bytes
    return 'buffered'
  }

  list(nowMs: number): PendingShellOpen[] {
    this.#sweep(nowMs)
    return [...this.#byId.values()]
  }

  delete(sid: string): void {
    this.#byId.delete(sid)
  }

  clear(): void {
    this.#byId.clear()
  }

  #sweep(nowMs: number): void {
    for (const [sid, open] of this.#byId) {
      if (open.expiresAtMs > nowMs) continue
      this.#byId.delete(sid)
      this.#onExpire?.(open)
    }
  }
}

/** What the control plane keeps about one session, for control frames and the close audit. */
export type ShellSessionMeta = {
  sid: string
  serverId: string
  orgId: string
  userId: string
  authSessionId: string
  kind: 'container' | 'host'
  containerId: string
  loginUser: string
  openedAtMs: number
  maxAtMs: number
  maxFrameBytes: number
  daemonConnectionId: string
}

/** The text control frames a browser's shell socket receives (never binary, never secrets). */
export type ShellControlFrame =
  | { type: 'opened'; sid: string; shell: string; user: string }
  | {
      type: 'closed'
      sid: string
      reason: string
      exitCode?: number
      confirmed: boolean
    }
  | { type: 'error'; sid: string; code: string }

export function controlFrameText(frame: ShellControlFrame): string {
  return JSON.stringify(frame)
}
