/**
 * Byte rules for what the control plane signs on the daemon session. Twin of
 * `turbopaneld/src/instance/panel-identity/frame-envelope.ts`; the prefixes and
 * the marker are pinned in both contract-drift scripts.
 *
 * The sender builds the frame without `sig`, runs `JSON.stringify`, signs
 * those bytes behind a per-kind prefix, and writes `,"sig":"<base64url>"}` in
 * place of the final `}`. The receiver splits at the last marker, verifies
 * the bytes before it plus `}`, and only then parses. No canonicaliser.
 */
export const HELLO_PREFIX = 'tp-hello\n'
export const FRAME_PREFIX = 'tp-frame\n'
export const HTTP_PREFIX = 'tp-http\n'
export const SIG_SUFFIX_MARKER = ',"sig":"'

const textEncoder = new TextEncoder()

/** `json` must be a serialized object; the signature goes in as its last member. */
export function appendSignature(json: string, sigB64u: string): string {
  if (!json.endsWith('}')) {
    throw new TypeError('signed frame must be a JSON object')
  }
  return `${json.slice(0, -1)}${SIG_SUFFIX_MARKER}${sigB64u}"}`
}

/** The unsigned bytes and the signature text, or null when the frame carries no trailing signature. */
export function splitSignature(raw: string): { unsigned: string; sig: string } | null {
  const at = raw.lastIndexOf(SIG_SUFFIX_MARKER)
  if (at < 0 || !raw.endsWith('"}')) return null
  const sig = raw.slice(at + SIG_SUFFIX_MARKER.length, -2)
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return null
  return { unsigned: `${raw.slice(0, at)}}`, sig }
}

export function helloSigningInput(unsignedJson: string): Uint8Array {
  return textEncoder.encode(`${HELLO_PREFIX}${unsignedJson}`)
}

export function frameSigningInput(type: string, unsignedJson: string): Uint8Array {
  return textEncoder.encode(`${FRAME_PREFIX}${type}\n${unsignedJson}`)
}

export function httpSigningInput(path: string, body: string): Uint8Array {
  return textEncoder.encode(`${HTTP_PREFIX}${path}\n${body}`)
}
