/**
 * Read-only side channels: the Mailpit sink (loopback only, GET only) and SSH
 * (explicitly named hosts only, never studio).
 */
import type { FetchLike } from './http.ts'
import { SafetyError, assertSshHost, isRecord } from './safety.ts'
import type { Json, MailMessage, MailSink, SshExec } from './types.ts'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Mailpit on testing listens on the instance's loopback, so it is reached
 * through a tunnel (`ssh -L 8025:127.0.0.1:8025 <testing host>`). Only a
 * loopback URL is accepted, and only GET is ever sent.
 */
export function mailpitSink(rawUrl: string, fetchImpl: FetchLike): MailSink {
  const url = new URL(rawUrl)
  if (!LOOPBACK.has(url.hostname)) {
    throw new SafetyError(`MAILPIT_URL must be a loopback tunnel, got ${url.hostname}`)
  }
  const base = url.origin
  const getJson = async (path: string): Promise<Json> => {
    const res = await fetchImpl(`${base}${path}`, { method: 'GET', redirect: 'manual' })
    if (res.status !== 200) throw new Error(`mailpit ${path}: HTTP ${res.status}`)
    return (await res.json()) as Json
  }
  return {
    async messagesTo(to) {
      const body = await getJson(`/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
      const list = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
      return list
        .filter(isRecord)
        .map((m): MailMessage => ({ id: String(m.ID ?? ''), subject: String(m.Subject ?? '') }))
    },
    async text(id) {
      const body = await getJson(`/api/v1/message/${encodeURIComponent(id)}`)
      return isRecord(body) ? String(body.Text ?? body.HTML ?? '') : ''
    },
  }
}

export type CommandRunner = (args: string[]) => Promise<{ code: number; stdout: string }>

export const denoCommandRunner: CommandRunner = async (args) => {
  const out = await new Deno.Command('ssh', { args, stdout: 'piped', stderr: 'null' }).output()
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) }
}

export interface SshOptions {
  /** Hosts passed with `--ssh-host`; nothing else is reachable. */
  allowed: readonly string[]
  /** Optional `CHECKLIST_SSH_USER`; otherwise ~/.ssh/config decides. */
  user?: string
  /** Optional `CHECKLIST_SSH_IDENTITY` key path. */
  identity?: string
  run?: CommandRunner
}

/** SSH in batch mode with strict host keys; refuses every host not named explicitly. */
export function sshExec(options: SshOptions): SshExec {
  const run = options.run ?? denoCommandRunner
  return async (host, command) => {
    assertSshHost(host, options.allowed)
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
    args.push('-o', 'StrictHostKeyChecking=yes')
    if (options.identity) args.push('-i', options.identity, '-o', 'IdentitiesOnly=yes')
    args.push(options.user ? `${options.user}@${host}` : host, command)
    const out = await run(args)
    if (out.code !== 0) throw new Error(`ssh ${host} exited ${out.code}`)
    return out.stdout
  }
}

/**
 * GET-only reachability probe for a published port on a testing host. Never
 * aimed at the panel (that goes through the API client) and never follows
 * redirects. Returns the status, or 0 when nothing answered in time.
 */
export function portProbe(
  fetchImpl: FetchLike,
  timeoutMs = 5000
): (url: string) => Promise<number> {
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SafetyError(`probe: unsupported scheme ${parsed.protocol}`)
    }
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      await res.body?.cancel()
      return res.status
    } catch {
      return 0
    }
  }
}
