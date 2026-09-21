/**
 * Baseline security response headers, set by the app itself on both runtimes.
 *
 * The self-hosted control plane sits behind Caddy, whose two Caddyfiles carry
 * the same three headers — but Caddy is not the only way an instance is
 * fronted (an operator's own nginx, a tunnel), and the hosted runtime has no
 * Caddy at all: turbopanel.app is served by the Worker directly, so before
 * this middleware the hosted product's clickjacking and MIME-sniffing
 * protection depended entirely on zone settings outside the repository.
 * Setting them here puts the guarantee in code, once, for every deployment.
 *
 * What is set, and why each one:
 *
 * - `Strict-Transport-Security` — only on an https request. Sending it over
 *   plaintext is meaningless (browsers ignore it), and the co-located dev
 *   surface is deliberately plain http; `preload` is left off because
 *   submitting a domain to the preload list is an operator decision with a
 *   slow undo, not a default.
 * - `X-Content-Type-Options: nosniff` — the API returns JSON and the instance
 *   also serves operator-uploaded content paths; never let a browser guess.
 * - `X-Frame-Options: DENY` plus `frame-ancestors 'none'` — nothing in the
 *   panel is meant to be embedded, and the two cover old and new browsers.
 * - `Referrer-Policy: strict-origin-when-cross-origin` — panel URLs carry
 *   organization and resource ids; they do not belong in a third party's
 *   referrer log.
 * - `Permissions-Policy` — the panel asks for none of these features, so the
 *   answer is no for itself and anything it embeds.
 *
 * A Content-Security-Policy is deliberately not set here: the API surface
 * needs none, and the one that matters is for the UI, which is served by
 * Caddy (self-hosted) or Workers assets (hosted) rather than through this
 * app — sending a policy from here would cover the JSON and miss the HTML.
 */
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  ],
] as const;

export const HSTS_HEADER = "Strict-Transport-Security";
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** True when the client reached this instance over TLS. */
export function isSecureRequest(url: string, forwardedProto?: string): boolean {
  // A proxy's declaration is honoured only as far as the existing
  // trusted-proxy handling already does for the rest of the app: this header
  // can only add headers, never remove them, so a spoofed value costs
  // nothing an attacker does not already control.
  if (forwardedProto) {
    const first = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return true;
    if (first === "http") return false;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** True when this request is a WebSocket handshake (Upgrade: websocket). */
export function isWebSocketUpgradeRequest(
  upgradeHeader: string | undefined,
): boolean {
  return upgradeHeader?.trim().toLowerCase() === "websocket";
}

/** Register the baseline headers on every response of `app`. */
export function registerSecurityHeaders(app: Hono<AppEnv>): void {
  app.use("*", async (c, next) => {
    // Snapshot before `next()`: a WebSocket handler hijacks the connection, and
    // Deno then refuses `c.req.header()` with `TypeError: Request closed`.
    // Reading after the upgrade also prevented returning the 101, which logged
    // "Upgrade response was not returned from callback" and left Caddy 502ing
    // `/api/*` (the unix socket name vanished while the process kept the inode).
    const upgrade = c.req.header("upgrade");
    const forwardedProto = c.req.header("x-forwarded-proto");
    const url = c.req.url;
    const isUpgrade = isWebSocketUpgradeRequest(upgrade);
    await next();
    if (isUpgrade || c.res.status === 101) {
      return;
    }
    for (const [name, value] of SECURITY_HEADERS) {
      c.header(name, value);
    }
    if (isSecureRequest(url, forwardedProto)) {
      c.header(HSTS_HEADER, HSTS_VALUE);
    }
  });
}
