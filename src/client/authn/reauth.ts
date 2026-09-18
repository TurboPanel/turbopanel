import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDb } from "../../db.ts";
import { account } from "../../lib/db/schema.ts";
import { verifyPassword } from "./password.ts";
import type { SessionData } from "./session-store.ts";

/**
 * How recently a session counts as "just authenticated" for users without a
 * credential (password) account — passkeys / OAuth phases reuse this.
 */
export const REAUTH_WINDOW_MS = 15 * 60 * 1000;

/**
 * Was this session created within {@link REAUTH_WINDOW_MS}?
 *
 * The session half of {@link assertRecentAuthOr403}, on its own, for the one
 * step-up that cannot carry a password: the OAuth link redirect is a browser
 * `GET`, so there is no body to resubmit a password in. A stale session is
 * refused there rather than being allowed to plant a permanent
 * attacker-controlled sign-in method.
 */
export function isSessionRecentlyAuthenticated(
  session: Pick<SessionData, "createdAt">,
): boolean {
  if (!session.createdAt) return false;
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= REAUTH_WINDOW_MS;
}

/**
 * Step-up auth for sensitive 2FA mutations.
 *
 * Credential accounts must resubmit `body.password`. Everyone else (passkey /
 * OAuth, once those phases land) must have a session created within
 * {@link REAUTH_WINDOW_MS}.
 *
 * Returns a 403 `Response` when the check fails, or `null` when it passes.
 */
export async function assertRecentAuthOr403(
  c: Context<AppEnv>,
  session: SessionData,
  body: { password?: unknown },
): Promise<Response | null> {
  const db = getDb(c);
  if (db === undefined) {
    return c.json({ ok: false, error: "Database unavailable" }, 503);
  }

  const rows = await db
    .select({ password: account.password })
    .from(account)
    .where(
      and(
        eq(account.userId, session.userId),
        eq(account.providerId, "credential"),
      ),
    )
    .limit(1);

  const credential = rows[0];
  if (credential?.password) {
    if (typeof body.password !== "string" || body.password.length === 0) {
      return c.json({ ok: false, error: "Reauthentication required" }, 403);
    }
    const valid = await verifyPassword(body.password, credential.password);
    if (!valid) {
      return c.json({ ok: false, error: "Reauthentication required" }, 403);
    }
    return null;
  }

  if (!isSessionRecentlyAuthenticated(session)) {
    return c.json({ ok: false, error: "Reauthentication required" }, 403);
  }
  return null;
}
