/**
 * Field and body-size caps shared by every public auth surface
 * (`http.ts`, `otp-http.ts`, `lib/install/routes.ts`). Applied before any
 * hashing / verifying work — an over-length password or OTP is rejected on
 * shape alone, never handed to argon2 or an HMAC compare.
 */

/** Matches `validateSuperadminEmail`'s own ceiling — kept in lockstep here. */
export const MAX_AUTH_EMAIL_CHARS = 255

/**
 * Well above any password the complexity policy would accept, and far below
 * a size that makes argon2 hashing an attacker-controlled cost.
 */
export const MAX_AUTH_PASSWORD_CHARS = 256

/** OTPs are 6 digits (`generateOtp`); this only guards against a hostile oversized field. */
export const MAX_AUTH_OTP_CHARS = 16

/** Display name submitted at OTP sign-in auto-registration. */
export const MAX_AUTH_NAME_CHARS = 200

/** PAM/host username for the install wizard. */
export const MAX_AUTH_USERNAME_CHARS = 255

// Per-route body-byte budgets. Every one of these routes carries a handful of
// short string fields — a few KB is already generous headroom over the JSON
// encoding of the field caps above, while keeping a hostile body far from
// buffer-worthy.
export const AUTH_SIGN_IN_MAX_BODY_BYTES = 4 * 1024
export const AUTH_SIGN_UP_MAX_BODY_BYTES = 4 * 1024
export const AUTH_SEND_OTP_MAX_BODY_BYTES = 2 * 1024
export const AUTH_VERIFY_OTP_MAX_BODY_BYTES = 2 * 1024
export const AUTH_SIGN_IN_OTP_MAX_BODY_BYTES = 4 * 1024
export const AUTH_VERIFY_EMAIL_OTP_MAX_BODY_BYTES = 2 * 1024
export const AUTH_RESET_PASSWORD_REQUEST_MAX_BODY_BYTES = 2 * 1024
export const AUTH_RESET_PASSWORD_MAX_BODY_BYTES = 4 * 1024
export const INSTALL_BOOTSTRAP_MAX_BODY_BYTES = 4 * 1024
export const INSTALL_COMPLETE_MAX_BODY_BYTES = 4 * 1024
