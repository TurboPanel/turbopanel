/**
 * Shared types for the Testing Checklist live-proof runner.
 *
 * A check proves one Road row (`rowId`, the id in the Road page data) against
 * a live testing or canary panel. Every check declares its safety class; the
 * runner decides from that class, never from the check body, whether it may
 * run at all and which HTTP verbs its client accepts.
 */

/** What a check may do to the target. Ordered from least to most impact. */
export type Safety = 'readonly' | 'creates-objects' | 'host-affecting'

export type Verdict = 'pass' | 'fail' | 'skip'

/**
 * Capabilities a check needs. `api` is the signed-in client API; `mail` is a
 * read-only mail sink (Mailpit) reachable on loopback; `ssh:<host>` is a
 * read-only SSH session to that host (see `RunnerEnv.sshHosts`).
 */
export type Capability = 'api' | 'mail' | `ssh:${string}`

export interface CheckOutcome {
  verdict: Verdict
  evidence: string
}

/** One row of the results file; same shape as `.cl-tmp/track-c/results-*.json`. */
export interface CheckResult extends CheckOutcome {
  id: string
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface ApiResponse {
  status: number
  body: Json
  headers: Headers
}

export interface ApiRequestInit {
  body?: Json
  /** Retry once after `/auth/reauth` when the route asks for a recent sign-in. */
  reauth?: boolean
}

/** The signed-in client API, scoped to one organization. */
export interface Api {
  readonly orgId: string
  get(path: string): Promise<ApiResponse>
  post(path: string, init?: ApiRequestInit): Promise<ApiResponse>
  put(path: string, init?: ApiRequestInit): Promise<ApiResponse>
  patch(path: string, init?: ApiRequestInit): Promise<ApiResponse>
  del(path: string, init?: ApiRequestInit): Promise<ApiResponse>
}

/** A separate, initially signed-out session on the same panel (its own cookies). */
export interface SessionClient extends Api {
  signIn(credentials: { email: string; password: string }): Promise<void>
  trySignIn(credentials: { email: string; password: string }): Promise<number>
}

/** Read-only view of the mail sink. */
export interface MailSink {
  /** Newest-first summaries of the messages addressed to `to`. */
  messagesTo(to: string): Promise<MailMessage[]>
  /** Full text body of one message. */
  text(id: string): Promise<string>
}

export interface MailMessage {
  id: string
  subject: string
}

/** Runs one read-only command over SSH and returns stdout. */
export type SshExec = (host: string, command: string) => Promise<string>

/** Runs a cleanup step registered by a check. */
export type Cleanup = () => Promise<void>

export interface CheckContext {
  api: Api
  /** Present only when the `mail` capability is available. */
  mail?: MailSink
  /** A fresh signed-out session; present only on an applied run. */
  session?: () => SessionClient
  /** Present only when an `ssh:*` capability is available. */
  ssh?: SshExec
  /** Unique per run, e.g. `clr-k3j9q`. Every object a check creates is named with it. */
  prefix: string
  /** Register a cleanup step; steps run LIFO in `finally`, even when the check throws. */
  defer(label: string, step: Cleanup): void
  /** Wait between polls (injected so tests do not sleep). */
  sleep(ms: number): Promise<void>
  /** Hosts given on the command line with `--host` (for host-affecting checks). */
  hosts: string[]
  /** Hosts passed with `--ssh-host` (the spelling `ssh` accepts). */
  sshHosts: string[]
  /**
   * GET a URL that is not the panel (a published port on a testing host) and
   * return the HTTP status, or 0 when nothing answered within a few seconds.
   */
  probe(url: string): Promise<number>
  log(message: string): void
}

export interface Check {
  rowId: string
  title: string
  requires: Capability[]
  safety: Safety
  run(ctx: CheckContext): Promise<CheckOutcome>
}
