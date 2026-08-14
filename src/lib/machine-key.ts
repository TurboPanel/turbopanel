/**
 * Host machine key derivation.
 *
 * `TURBOPANEL_MACHINE_ID_NAMESPACE` is **not a secret** — it is a fixed
 * application-id constant. Both the daemon and the instance compute the same
 * HMAC independently and must never diverge. Keep the literal identical to
 * `turbopaneld/src/host/machine-key.ts`.
 *
 * Argument ordering matches systemd `sd_id128_get_machine_app_specific`:
 * key = raw machine id, message = namespace.
 *
 * Web Crypto + local hex only — no `@std/*` / `jsr:` imports so Wrangler can
 * bundle this module (Deno import maps are not available to the Workers
 * esbuild step).
 */

/**
 * Fixed application-id UUID for machine-key derivation.
 * Not a secret — both sides compute independently; must never diverge.
 */
export const TURBOPANEL_MACHINE_ID_NAMESPACE =
  '57fd317c-089a-4d52-9d3d-bbf76ba30383'

/** HMAC-SHA256 digest as lowercase hex — the only shape stored or indexed. */
const MACHINE_KEY_HEX_RE = /^[0-9a-f]{64}$/

const textEncoder = new TextEncoder()

/** Lowercase hex — matches `@std/encoding/hex` `encodeHex` output. */
function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

/**
 * Normalize a client-supplied machine key to the canonical 64-char lowercase
 * hex HMAC shape. Returns `undefined` for missing, blank, or invalid values so
 * callers never persist a raw `/etc/machine-id` (typically 32 hex chars).
 */
export function normalizeMachineKey(
  value: string | null | undefined,
): string | undefined {
  if (value == null) return undefined
  const normalized = value.trim().toLowerCase()
  if (!MACHINE_KEY_HEX_RE.test(normalized)) return undefined
  return normalized
}

/**
 * Derive a deterministic, non-reversible machine key from a raw `/etc/machine-id`.
 * Returns `undefined` for empty input (never derive from an empty string).
 *
 * HMAC-SHA256 with key = machine id, message = namespace (systemd app-specific
 * ordering). Web Crypto only so the identical logic works on Workers.
 */
export async function deriveMachineKey(
  rawMachineId: string,
): Promise<string | undefined> {
  const normalized = rawMachineId.trim().toLowerCase()
  if (!normalized) return undefined

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(normalized),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    textEncoder.encode(TURBOPANEL_MACHINE_ID_NAMESPACE),
  )
  return encodeHex(new Uint8Array(signature))
}
