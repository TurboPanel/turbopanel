/**
 * DNS-01 challenge records on Cloudflare: one TXT record per challenge,
 * created and removed by id. A separate small file from the tunnel client so
 * the certificate work and the tunnel work stay apart. The token goes only in
 * the Authorization header and every error message is scrubbed of it.
 */
import type {
  ChallengeRecordInput,
  ChallengeRecordRef,
  DnsChallengeProvider,
} from '../tls/dns-certificates/dns-provider.ts'
import { CLOUDFLARE_API_BASE } from './cloudflare-client.ts'
import { codeForStatus, TunnelProviderError } from './errors.ts'

const REQUEST_TIMEOUT_MS = 15_000

type Envelope = {
  success?: boolean
  errors?: { message?: string }[]
  result?: { id?: string; content?: string } | { content?: string }[] | null
}

export function createCloudflareDnsChallenge(options: {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
}): DnsChallengeProvider {
  const base = options.baseUrl ?? CLOUDFLARE_API_BASE
  // Called as a plain function so the Workers runtime accepts it.
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function call(method: string, path: string, body?: unknown): Promise<Envelope | null> {
    let response: Response
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'request failed'
      throw new TunnelProviderError(
        'unreachable',
        `Cloudflare could not be reached: ${reason}`,
        null,
        [options.token]
      )
    }
    const envelope = (await response.json().catch(() => null)) as Envelope | null
    if (!response.ok || envelope?.success === false) {
      const detail = (envelope?.errors ?? [])
        .map((e) => e.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
        .join('; ')
      const reason = detail ? `: ${detail}` : ''
      throw new TunnelProviderError(
        codeForStatus(response.status),
        `Cloudflare refused the request (${response.status})${reason}`,
        response.status,
        [options.token]
      )
    }
    return envelope
  }

  return {
    async lookupCname(input): Promise<string | null> {
      const query = `type=CNAME&name=${encodeURIComponent(input.name)}&per_page=1`
      const envelope = await call(
        'GET',
        `/zones/${encodeURIComponent(input.zoneId)}/dns_records?${query}`
      )
      const rows = Array.isArray(envelope?.result) ? envelope.result : []
      const content = rows[0]?.content
      return typeof content === 'string' && content.length > 0
        ? content.toLowerCase().replace(/\.$/, '')
        : null
    },

    async present(input: ChallengeRecordInput): Promise<ChallengeRecordRef> {
      const envelope = await call(
        'POST',
        `/zones/${encodeURIComponent(input.zoneId)}/dns_records`,
        {
          type: 'TXT',
          name: input.name,
          content: input.value,
          ttl: 60,
        }
      )
      const created = envelope?.result
      const recordId = created && !Array.isArray(created) ? created.id : undefined
      if (!recordId) {
        throw new TunnelProviderError(
          'provider_error',
          'Cloudflare did not return the record id',
          null
        )
      }
      return { zoneId: input.zoneId, recordId }
    },

    async remove(ref: ChallengeRecordRef): Promise<void> {
      try {
        await call(
          'DELETE',
          `/zones/${encodeURIComponent(ref.zoneId)}/dns_records/${encodeURIComponent(ref.recordId)}`
        )
      } catch (err) {
        if (err instanceof TunnelProviderError && err.code === 'not_found') return
        throw err
      }
    },
  }
}
