/**
 * Wire-format helpers for TurboPanel-authored serialized secrets.
 *
 * Grammar: `<scheme>.v<version>.<fields…>`
 * - `tpsecret.v<version>.<payloadB64u>` (1 field) — at-rest sealed secrets
 * - `tpdaemon.v<version>.<serverId>.<keyId>.<payloadB64u>` (3 fields) — daemon delivery
 * - `tpsession.v<version>.<token>.<sigB64u>` (2 fields) — session cookies
 * - `tpotp.v<version>.<hmacHex>` (1 field) — email OTP verifiers
 * - `tpchallenge.v<version>.<payloadB64u>.<sigB64u>` (2 fields) — daemon challenges
 *
 * Password hashes deliberately stay PHC Argon2id (not this grammar).
 *
 * Pure string helpers only — no crypto, no platform imports — so the module is
 * trivially Workers-bundle-safe.
 */

export const ENVELOPE_SCHEME_SECRET = "tpsecret";
export const ENVELOPE_SCHEME_DAEMON = "tpdaemon";
export const ENVELOPE_SCHEME_SESSION = "tpsession";
export const ENVELOPE_SCHEME_OTP = "tpotp";
export const ENVELOPE_SCHEME_CHALLENGE = "tpchallenge";

export const ENVELOPE_PREFIX_SECRET = `${ENVELOPE_SCHEME_SECRET}.`;
export const ENVELOPE_PREFIX_DAEMON = `${ENVELOPE_SCHEME_DAEMON}.`;

const VERSION_TOKEN = /^v([1-9]\d*)$/;

/**
 * Serialize an envelope: `scheme.v{version}.{fields…}`.
 */
export function formatEnvelope(
  scheme: string,
  version: number,
  ...fields: string[]
): string {
  return [scheme, `v${version}`, ...fields].join(".");
}

/**
 * Cheap structural parse. Never throws — returns `null` when the value is not a
 * well-formed envelope for `scheme` with exactly `expectedFieldCount` non-empty
 * fields after the version token.
 */
export function parseEnvelope(
  scheme: string,
  value: string,
  expectedFieldCount: number,
): { version: number; fields: string[] } | null {
  const prefix = `${scheme}.`;
  if (!value.startsWith(prefix)) {
    return null;
  }

  const tokens = value.split(".");
  if (tokens.length !== 2 + expectedFieldCount) {
    return null;
  }

  const [tokenScheme, versionToken, ...fields] = tokens;
  if (tokenScheme !== scheme || fields.length !== expectedFieldCount) {
    return null;
  }

  const match = VERSION_TOKEN.exec(versionToken);
  if (!match) {
    return null;
  }

  const version = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(version) || version < 1) {
    return null;
  }

  // Reject non-canonical forms (e.g. `v01`) that parseInt would still accept.
  if (versionToken !== `v${version}`) {
    return null;
  }

  for (const field of fields) {
    if (field.length === 0) {
      return null;
    }
  }

  return { version, fields };
}

/** True when `value` begins with `<scheme>.` (regardless of further validity). */
export function hasEnvelopeScheme(scheme: string, value: string): boolean {
  return value.startsWith(`${scheme}.`);
}
