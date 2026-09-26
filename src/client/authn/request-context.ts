/**
 * Per-request helpers every authn route module shares: TLS detection, the
 * session cookie header, the signed-in session, and an optional JSON body.
 * One copy, so a cookie-attribute change is one edit.
 */
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { getDb } from "../../db/connection.ts";
import { readBoundedBodyText } from "../../lib/http/bounded-body.ts";
import {
  resolveRequestTls,
  resolveSessionCookieName,
  verifySignedCookie,
} from "./crypto.ts";
import type { AuthRouteOpts } from "./http.ts";
import { getSession, type SessionData } from "./session-store.ts";

export function requestTls(c: Context, runtime: "deno" | "workers") {
  return resolveRequestTls({
    requestUrl: c.req.url,
    runtime,
    forwardedProto: c.req.header("x-forwarded-proto"),
  });
}

/** `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` over HTTPS. */
export function buildCookieHeader(
  cookieValue: string,
  maxAge: number,
  cookieName: string,
  isHttps: boolean,
): string {
  let header =
    `${cookieName}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  if (isHttps) {
    header += "; Secure";
  }
  return header;
}

/** The session behind the request's signed session cookie, if any. */
export async function readActiveSession(
  c: Context,
  opts: Pick<AuthRouteOpts, "runtime" | "secrets">,
): Promise<SessionData | null> {
  const db = getDb(c);
  const cookieName = resolveSessionCookieName({
    requestUrl: c.req.url,
    runtime: opts.runtime,
    forwardedProto: c.req.header("x-forwarded-proto"),
  });
  const cookieValue = getCookie(c, cookieName) ?? null;
  if (!cookieValue) return null;

  const secrets = opts.secrets;
  if (!secrets) return null;

  const result = await verifySignedCookie(cookieValue, secrets);
  if (!result) return null;

  return getSession(db, result.token);
}

/**
 * A size-capped JSON object body. An empty or non-object body reads as `{}`;
 * malformed JSON is a 400.
 */
export async function readOptionalJsonObject(
  c: Context,
  maxBytes: number,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const read = await readBoundedBodyText(c, maxBytes);
  if (!read.ok) return { ok: false, response: read.response };
  if (!read.text.trim()) {
    return { ok: true, body: {} };
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      return { ok: true, body: {} };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: c.json({ ok: false, error: "Invalid request" }, 400),
    };
  }
}
