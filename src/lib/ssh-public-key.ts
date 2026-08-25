/**
 * Strict parser for an OpenSSH public key line, for keys an operator pastes in.
 *
 * The output of this module is written into an `authorized_keys` file on a
 * tenant host, so it is a credential parser, not a formatter. Two rules follow
 * from that and both are load-bearing:
 *
 * 1. **Nothing the operator typed is ever stored or rendered.** A key that
 *    parses is re-rendered from its decoded parts as `<type> <base64>`. There is
 *    no path by which an input byte reaches the file unexamined.
 * 2. **The blob decides the algorithm, not the label.** An SSH public key blob
 *    begins with its own length-prefixed algorithm name, and `sshd` trusts that
 *    name — the text before the base64 is a convention. A validator that only
 *    pattern-matches the prefix accepts `ssh-ed25519 AAAAB3NzaC1yc2E…`, which is
 *    an RSA key wearing an Ed25519 label. So the blob is fully decoded and its
 *    embedded name compared against the declared one.
 *
 * Web Crypto only (`crypto.subtle.digest`), so this stays reachable from
 * `src/workers.ts` alongside `./git/ssh-keypair.ts`, whose wire-format helpers
 * this mirrors.
 */

/** Key types a principal may authenticate with. */
export const ALLOWED_SSH_KEY_TYPES = [
  'ssh-ed25519',
  'sk-ssh-ed25519@openssh.com',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa',
] as const

export type SshKeyType = (typeof ALLOWED_SSH_KEY_TYPES)[number]

/**
 * Smallest RSA modulus accepted.
 *
 * A 1024-bit key is a perfectly well-formed `ssh-rsa` line and is not an
 * acceptable credential in 2026; OpenSSH itself refuses to *generate* below
 * 1024 but will happily authenticate one. The floor has to be ours.
 */
export const MIN_RSA_MODULUS_BITS = 2048

/** Whole-line cap. Real keys are well under 1 KiB; RSA-16384 is ~3.2 KiB. */
const MAX_KEY_LINE_LENGTH = 8192
/** Comment cap, matching the display column it feeds. */
const MAX_COMMENT_LENGTH = 255

export type ParsedSshPublicKey = {
  keyType: SshKeyType
  /**
   * Canonical `<type> <base64>` — re-rendered from the decoded blob, with the
   * comment deliberately absent. The comment is display metadata and is stored
   * in its own column; keeping it out of this string means the value written to
   * `authorized_keys` has exactly two fields and cannot grow a third.
   */
  publicKey: string
  /** Sanitized display comment, or `undefined` when there was none worth keeping. */
  comment?: string
  /** `SHA256:<base64 without padding>`, byte-identical to `ssh-keygen -lf`. */
  fingerprint: string
  /** RSA modulus size. Omitted for fixed-size key types. */
  bits?: number
}

export type SshPublicKeyParseResult =
  | { ok: true; value: ParsedSshPublicKey }
  | { ok: false; error: string }

const textDecoder = new TextDecoder('utf-8', { fatal: true })

function fail(error: string): SshPublicKeyParseResult {
  return { ok: false, error }
}

/**
 * Reader over the SSH wire encoding: a sequence of `uint32` length-prefixed
 * strings, big-endian, with nothing else in it.
 */
class SshBlobReader {
  #bytes: Uint8Array
  #offset = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get exhausted(): boolean {
    return this.#offset === this.#bytes.length
  }

  /** Next length-prefixed field, or `null` when the blob is malformed. */
  readString(): Uint8Array | null {
    if (this.#offset + 4 > this.#bytes.length) return null
    const view = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      4,
    )
    const length = view.getUint32(0, false)
    this.#offset += 4
    // A length field can claim up to 4 GiB. Compare against what is actually
    // left rather than allocating on the claim.
    if (length > this.#bytes.length - this.#offset) return null
    const out = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return out
  }

  readAsciiString(): string | null {
    const bytes = this.readString()
    if (bytes === null) return null
    try {
      return textDecoder.decode(bytes)
    } catch {
      return null
    }
  }
}

/**
 * Bit length of an SSH `mpint`.
 *
 * `mpint` is two's-complement big-endian in minimal form, so a positive value
 * whose top bit is set carries a leading `0x00` that is padding, not magnitude.
 * Counting it would report a 2048-bit modulus as 2056 and quietly move the
 * floor; skipping leading zero bytes and then the leading zero bits of the
 * first significant byte is the whole calculation.
 */
function mpintBitLength(bytes: Uint8Array): number {
  let index = 0
  while (index < bytes.length && bytes[index] === 0) index += 1
  if (index === bytes.length) return 0
  const leading = bytes[index] as number
  let bits = (bytes.length - index - 1) * 8
  for (let bit = 7; bit >= 0; bit -= 1) {
    if ((leading >> bit) & 1) {
      bits += bit + 1
      break
    }
  }
  return bits
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  return btoa(binary)
}

/**
 * Strict base64 decode.
 *
 * `atob` is lenient in ways that matter here: it tolerates missing padding and,
 * in some runtimes, stray characters. Two keys whose text differs but whose
 * bytes match would then produce two rows with one fingerprint, so the
 * alphabet and padding are checked before decoding rather than after.
 */
function decodeBase64Strict(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  let binary: string
  try {
    binary = atob(value)
  } catch {
    return null
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** `SHA256:<base64 without padding>` over the public blob, as `ssh-keygen -l`. */
async function fingerprintOf(blob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', blob as BufferSource)
  return `SHA256:${base64Encode(new Uint8Array(digest)).replace(/=+$/, '')}`
}

/**
 * Keep only printable ASCII, and drop the two characters that would be
 * structural if this ever reached a config file (`"` and `\`).
 */
function sanitizeComment(value: string): string | undefined {
  const cleaned = [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\'
    })
    .join('')
    .trim()
    .slice(0, MAX_COMMENT_LENGTH)
  return cleaned.length > 0 ? cleaned : undefined
}

function isAllowedKeyType(value: string): value is SshKeyType {
  return (ALLOWED_SSH_KEY_TYPES as readonly string[]).includes(value)
}

/** Uncompressed EC point sizes, keyed by the curve name inside the blob. */
const EC_CURVE_POINT_BYTES: Readonly<Record<string, number>> = {
  nistp256: 65,
  nistp384: 97,
  // P-521's field is 66 bytes: 2 × 66 + 1.
  nistp521: 133,
}

/** The curve an `ecdsa-*` key type declares in its name. */
function ecCurveForKeyType(keyType: SshKeyType): string | null {
  const match = /nistp(256|384|521)/.exec(keyType)
  return match === null ? null : `nistp${match[1]}`
}

/**
 * Walk the type-specific body of the blob.
 *
 * Returning the RSA size (and only ever that) keeps the caller from having to
 * know which types carry a variable-length parameter.
 */
function readKeyBody(
  keyType: SshKeyType,
  reader: SshBlobReader,
): { ok: true; bits?: number } | { ok: false; error: string } {
  const malformed = { ok: false as const, error: 'the key data is malformed' }

  if (keyType === 'ssh-rsa') {
    const exponent = reader.readString()
    const modulus = reader.readString()
    if (exponent === null || modulus === null) return malformed
    const bits = mpintBitLength(modulus)
    if (bits < MIN_RSA_MODULUS_BITS) {
      return {
        ok: false,
        error:
          `RSA keys must be at least ${MIN_RSA_MODULUS_BITS} bits; this one is ${bits}. Generate a new key with \`ssh-keygen -t ed25519\`.`,
      }
    }
    return { ok: true, bits }
  }

  if (keyType === 'ssh-ed25519' || keyType === 'sk-ssh-ed25519@openssh.com') {
    const publicKey = reader.readString()
    if (publicKey === null || publicKey.length !== 32) return malformed
    if (keyType === 'sk-ssh-ed25519@openssh.com') {
      // FIDO keys carry the relying-party application string.
      if (reader.readString() === null) return malformed
    }
    return { ok: true }
  }

  // Every remaining allowed type is ECDSA: curve name, then an uncompressed
  // point, then (for the FIDO variant) the application string.
  const declaredCurve = ecCurveForKeyType(keyType)
  if (declaredCurve === null) return malformed
  const curve = reader.readAsciiString()
  if (curve === null) return malformed
  if (curve !== declaredCurve) {
    return {
      ok: false,
      error:
        `the key declares curve \`${declaredCurve}\` but its data carries \`${curve}\``,
    }
  }
  const point = reader.readString()
  if (point === null) return malformed
  if (point.length !== EC_CURVE_POINT_BYTES[curve] || point[0] !== 0x04) {
    return { ok: false, error: 'the key data is not an uncompressed EC point' }
  }
  if (keyType === 'sk-ecdsa-sha2-nistp256@openssh.com') {
    if (reader.readString() === null) return malformed
  }
  return { ok: true }
}

/**
 * Why a line's leading token is not an acceptable key type.
 *
 * Split out so the three cases each get the message that tells the operator
 * what to do next — "unsupported" is true of all three and useful for none.
 */
function explainRejectedKeyType(
  declaredType: string,
  tokens: readonly string[],
): string {
  if (declaredType === 'ssh-dss') {
    return 'DSA keys (`ssh-dss`) are not accepted — OpenSSH disabled them by default in 7.0. Generate a new key with `ssh-keygen -t ed25519`.'
  }
  // A line may legally begin with an options field
  // (`command="…",no-pty ssh-ed25519 AAAA…`). Rejecting it is deliberate and so
  // is refusing to strip it: silently dropping a `from="10.0.0.0/8"` would mean
  // the operator's own restriction quietly stopped applying, which is worse
  // than not accepting the line at all.
  if (tokens.length >= 3 && isAllowedKeyType(tokens[1] as string)) {
    return 'remove the options in front of the key (`command=`, `from=`, `no-pty`, …) — TurboPanel sets those itself and will not honour pasted ones'
  }
  return `unsupported key type \`${declaredType.slice(0, 40)}\` — supported: ${
    ALLOWED_SSH_KEY_TYPES.join(', ')
  }`
}

/**
 * Parse one `authorized_keys`-style public key line.
 *
 * Async only because the fingerprint is, and the fingerprint is part of the
 * parse rather than a later step: a caller that could hold a `ParsedSshPublicKey`
 * without one would be able to persist a key it cannot uniquely identify.
 */
export async function parseSshPublicKey(
  input: unknown,
): Promise<SshPublicKeyParseResult> {
  if (typeof input !== 'string') return fail('a public key must be text')
  if (input.length > MAX_KEY_LINE_LENGTH) {
    return fail(`a public key must be under ${MAX_KEY_LINE_LENGTH} characters`)
  }
  // Checked before any trim, so they can never be silently stripped. A newline
  // is not a formatting problem here — it is a second `authorized_keys` entry,
  // which is arbitrary key injection.
  if (/[\0\r\n]/.test(input)) {
    return fail('a public key must be a single line')
  }

  const tokens = input.trim().split(/[ \t]+/).filter((token) => token.length > 0)
  if (tokens.length < 2) {
    return fail(
      'expected a key in `ssh-ed25519 AAAA…` form — paste the contents of your `.pub` file',
    )
  }

  const [declaredType, encoded] = tokens as [string, string, ...string[]]

  if (!isAllowedKeyType(declaredType)) {
    return fail(explainRejectedKeyType(declaredType, tokens))
  }

  const blob = decodeBase64Strict(encoded)
  if (blob === null) return fail('the key data is not valid base64')

  const reader = new SshBlobReader(blob)
  const embeddedType = reader.readAsciiString()
  if (embeddedType === null) return fail('the key data is malformed')
  if (embeddedType !== declaredType) {
    return fail(
      `the key is labelled \`${declaredType}\` but its data is \`${
        embeddedType.slice(0, 40)
      }\` — \`sshd\` trusts the data, so this key would not do what the label says`,
    )
  }

  const body = readKeyBody(declaredType, reader)
  if (!body.ok) return fail(body.error)
  // Trailing bytes mean the line carries something beyond the key.
  if (!reader.exhausted) return fail('the key data has trailing bytes')

  const comment = tokens.length > 2
    ? sanitizeComment(tokens.slice(2).join(' '))
    : undefined

  return {
    ok: true,
    value: {
      keyType: declaredType,
      // Re-rendered from the decoded blob, never echoed from the input.
      publicKey: `${declaredType} ${base64Encode(blob)}`,
      ...(comment === undefined ? {} : { comment }),
      fingerprint: await fingerprintOf(blob),
      ...(body.bits === undefined ? {} : { bits: body.bits }),
    },
  }
}

/**
 * `<type> <base64>`, anchored, with no third field.
 *
 * The shape a *parsed* key is re-rendered into, and therefore the shape every
 * later gate checks: the deploy/reconcile payload validator here, and
 * `isCanonicalSshPublicKey` in the daemon's `src/deploy/ssh/key-types.ts`.
 *
 * Deliberately not a re-parse. The full decode happened once, at the point an
 * operator pasted the key; what the downstream gates enforce is that nothing
 * *structural* — a second line, an options field, a trailing comment — can
 * reach a file `sshd` authenticates against.
 */
const CANONICAL_KEY_LINE_RE = new RegExp(
  `^(?:${
    ALLOWED_SSH_KEY_TYPES.map((type) =>
      type.replaceAll(/[.*+?^${}()|[\]\\@]/g, '\\$&')
    ).join('|')
  }) [A-Za-z0-9+/]+={0,2}$`,
)

export function isCanonicalSshPublicKey(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_KEY_LINE_RE.test(value)
}
