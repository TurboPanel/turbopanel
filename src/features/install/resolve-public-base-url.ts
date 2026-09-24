import type { Context } from "hono";
import {
  getPublicUrls,
  PANEL_HTTPS_PORT,
  publicHttpsOrigin,
  publicUrlEntryToInstallOrigin,
} from "./public-urls.ts";
import { getDb } from "../../db/connection.ts";
import { discoverHostIpv4 } from "../../platform/ports/host-ipv4-discovery.ts";

/**
 * Scheme-bearing HTTPS keeps its port (443 stays the standard origin).
 * A bare host is the self-hosted Caddy dial and becomes `:8443`.
 * Plaintext `http:` is rejected. `CADDY_PORT` is not consulted.
 */
function validatedPublicHttpsOrigin(
  candidate: string | undefined,
): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) return publicHttpsOrigin(trimmed);
  return publicUrlEntryToInstallOrigin(trimmed);
}

/**
 * Parse a user-supplied public base URL (install command override).
 * Plaintext `http:` is rejected. An already valid HTTPS origin keeps its
 * port. A bare host dials the self-hosted listener on {@link PANEL_HTTPS_PORT}.
 */
export function parseInstallBaseUrl(value: string | undefined): string | null {
  return validatedPublicHttpsOrigin(value);
}

/** First non-empty entry → install origin, or null when missing/unusable. */
function originFromFirstPublicUrlEntry(
  entries: readonly string[],
): string | null {
  const first = entries[0]?.trim();
  if (!first) return null;
  return validatedPublicHttpsOrigin(first);
}

async function resolveStoredPublicUrlOrigin(
  c: Context,
): Promise<string | null> {
  const db = getDb(c);
  if (db) {
    const parsed = originFromFirstPublicUrlEntry(await getPublicUrls(db));
    if (parsed) return parsed;
  }

  if (typeof Deno === "undefined") return null;

  const publicUrls = Deno.env.get("TURBOPANEL_PUBLIC_URLS")?.trim();
  if (!publicUrls) return null;

  return originFromFirstPublicUrlEntry(publicUrls.split(","));
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null —
 * prefer operator-managed public URLs, then TURBOPANEL_BASE_URL, forwarded headers, or
 * a discovered host address.
 *
 * Hosted and externally forwarded origins keep their HTTPS port. A bare
 * stored hostname, and the discovered-address fallback, dial the self-hosted
 * listener. Plaintext `http:` is rejected.
 */
export async function resolvePublicBaseUrl(
  c: Context,
  opts?: { baseUrl?: string },
): Promise<string> {
  const fromStored = await resolveStoredPublicUrlOrigin(c);
  if (fromStored) return fromStored;

  const fromOpts = validatedPublicHttpsOrigin(opts?.baseUrl);
  if (fromOpts) return fromOpts;

  const platformEnv = c.get("platformEnv") as
    | Record<string, string | undefined>
    | undefined;
  const fromWorkersEnv = validatedPublicHttpsOrigin(
    platformEnv?.TURBOPANEL_BASE_URL,
  );
  if (fromWorkersEnv) return fromWorkersEnv;

  if (typeof Deno !== "undefined") {
    const fromEnv = validatedPublicHttpsOrigin(
      Deno.env.get("TURBOPANEL_BASE_URL"),
    );
    if (fromEnv) return fromEnv;
  }

  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost && forwardedHost !== "null") {
    // Only accept https origins from forwarded headers — malformed hosts
    // (paths, query strings, shell metacharacters) are ignored.
    const fromForwarded = validatedPublicHttpsOrigin(
      `https://${forwardedHost}`,
    );
    if (fromForwarded) return fromForwarded;
  }

  try {
    const fromRequest = validatedPublicHttpsOrigin(new URL(c.req.url).origin);
    if (fromRequest) return fromRequest;
  } catch {
    // Unix socket or relative request URL — fall through.
  }

  const host = discoverHostIpv4() || "localhost";
  return `https://${host}:${PANEL_HTTPS_PORT}`;
}
