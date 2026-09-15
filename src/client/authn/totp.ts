/**
 * RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits, \u00b11 window) plus RFC 4648
 * base32 without padding. Web Crypto only — no Node crypto, Workers-safe.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_ISSUER = "TurboPanel";

const textEncoder = new TextEncoder();

/**
 * RFC 4648 base32, no padding. Output is uppercase.
 */
export function encodeBase32(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return output;
}

/**
 * RFC 4648 base32 decode (no padding required). Accepts lower-case and
 * strips spaces. Throws {@link TypeError} on illegal alphabet.
 */
export function decodeBase32(input: string): Uint8Array {
  const normalized = input.trim().replaceAll(" ", "").toUpperCase();
  if (normalized.length === 0) {
    throw new TypeError("empty base32 secret");
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new TypeError("invalid base32 secret");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** 20 cryptographically random bytes — the RFC 6238 SHA-1 shared secret size. */
export function generateTotpSecretBytes(): Uint8Array {
  const secret = new Uint8Array(TOTP_SECRET_BYTES);
  crypto.getRandomValues(secret);
  return secret;
}

export function generateTotpSecret(): string {
  return encodeBase32(generateTotpSecretBytes());
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function dynamicTruncate(hmac: Uint8Array, digits: number): string {
  const offset = hmac.at(-1)! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const modulus = 10 ** digits;
  return String(binary % modulus).padStart(digits, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

export type TotpGenerateOptions = Readonly<{
  unixSeconds: number;
  digits?: number;
  stepSeconds?: number;
}>;

/**
 * RFC 6238 TOTP. `digits` defaults to 6 (production); pass 8 for the
 * Appendix B test vectors.
 */
export async function generateTotp(
  secret: Uint8Array,
  options: TotpGenerateOptions,
): Promise<string> {
  const digits = options.digits ?? TOTP_DIGITS;
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const counter = Math.floor(options.unixSeconds / step);
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    counterBytes(counter) as BufferSource,
  );
  return dynamicTruncate(new Uint8Array(mac), digits);
}

export function normalizeTotpCode(code: string): string {
  return code.trim().replaceAll(" ", "");
}

/**
 * Accept a 6-digit code within \u00b1{@link TOTP_WINDOW_STEPS} time steps.
 * Always evaluates the full window so comparison time does not leak the
 * matching offset.
 */
export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  unixSeconds: number = Date.now() / 1000,
): Promise<boolean> {
  const normalized = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(normalized)) return false;

  let matched = false;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const candidate = await generateTotp(secret, {
      unixSeconds: unixSeconds + delta * TOTP_STEP_SECONDS,
    });
    if (constantTimeEqual(candidate, normalized)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * `otpauth://totp/TurboPanel:<email>?secret=\u2026&issuer=TurboPanel&algorithm=SHA1&digits=6&period=30`
 */
export function buildOtpAuthUri(email: string, base32Secret: string): string {
  const label = `${TOTP_ISSUER}:${email.trim().toLowerCase()}`;
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
