import type { Context } from 'hono'
import { isDeveloperSurfaceEnabled } from '../dev-mode.ts'

const LOCAL_CONSOLE_SCHEME = 'Local-Console'
const LOCAL_CONSOLE_MAX_SKEW_MS = 60_000
const LOCAL_CONSOLE_INFO = 'local-console-v1'

function isLocalConsoleAuthEnabled(): boolean {
  return typeof Deno !== 'undefined' && isDeveloperSurfaceEnabled()
}

function resolveLocalConsoleRootSecret(): string | undefined {
  if (typeof Deno === 'undefined') return undefined
  const direct = Deno.env.get('TURBOPANEL_SECRET')?.trim()
  if (direct) return direct
  const secrets = Deno.env.get('TURBOPANEL_SECRETS')?.trim()
  if (!secrets) return undefined
  let highest: { version: number; value: string } | null = null
  for (const entry of secrets.split(',')) {
    const colon = entry.indexOf(':')
    if (colon <= 0) continue
    const version = Number.parseInt(entry.slice(0, colon), 10)
    const value = entry.slice(colon + 1).trim()
    if (!Number.isInteger(version) || !value) continue
    if (!highest || version > highest.version) {
      highest = { version, value }
    }
  }
  return highest?.value
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.codePointAt(i) ?? 0
    }
    return bytes
  } catch {
    return null
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

async function hmacSha256(keyMaterial: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  return new Uint8Array(signature)
}

function buildLocalConsolePayload(
  timestamp: string,
  method: string,
  path: string,
): string {
  return `${LOCAL_CONSOLE_INFO}\0${timestamp}\0${method.toUpperCase()}\0${path}`
}

/** Verify HMAC local-console auth presented by the co-located dev terminal console. */
export async function verifyLocalConsoleAuthorization(
  c: Context,
  rootSecret?: string,
): Promise<boolean> {
  if (!isLocalConsoleAuthEnabled()) return false
  const secret = rootSecret ?? resolveLocalConsoleRootSecret()
  if (!secret) return false

  const header = c.req.header('Authorization')?.trim()
  if (!header?.startsWith(`${LOCAL_CONSOLE_SCHEME} `)) return false

  const token = header.slice(LOCAL_CONSOLE_SCHEME.length + 1)
  const dot = token.indexOf('.')
  if (dot <= 0) return false

  const timestampBytes = decodeBase64Url(token.slice(0, dot))
  const signatureBytes = decodeBase64Url(token.slice(dot + 1))
  if (!timestampBytes || !signatureBytes) return false

  const timestamp = new TextDecoder().decode(timestampBytes)
  const issuedAt = Date.parse(timestamp)
  if (!Number.isFinite(issuedAt)) return false
  const skew = Math.abs(Date.now() - issuedAt)
  if (skew > LOCAL_CONSOLE_MAX_SKEW_MS) return false

  const payload = buildLocalConsolePayload(timestamp, c.req.method, c.req.path)
  const expected = await hmacSha256(secret, payload)
  return constantTimeEqual(expected, signatureBytes)
}
