import type { Hono } from "hono";
import type { AppEnv } from "../app/app.ts";
import { getDb } from "../db/connection.ts";
import {
  instanceAcmeSettingsToApiShape,
  instanceAcmeUpdatesRequireEncryption,
  resolveInstanceAcmeSettings,
  updateInstanceAcmeSettings,
} from "../features/install/instance-acme-settings.ts";
import {
  attachUploadedCertificateToHostnames,
  listUploadedCertificates,
  storeUploadedCertificate,
} from "../features/install/instance-certificates.ts";
import {
  listInstanceHostnames,
  replaceInstanceHostnames,
} from "../features/install/instance-hostnames.ts";
import {
  parseCertificateHostnamesBody,
  parseCertificateUploadBody,
  parseInstanceAcmeSettingsUpdates,
  parseInstanceHostnamesBody,
  resolvePlatformEnv,
} from "./routes-helpers.ts";

const ENCRYPTION_UNAVAILABLE = {
  error: "Encryption unavailable — no encryption key configured",
} as const;

function failureStatus(error: string): 404 | 422 {
  if (error === "Certificate not found") return 404;
  return 422;
}

/**
 * Admin routes for control-plane hostnames, uploaded certificates, and
 * instance ACME settings. Mounted on the same admin Hono instance as
 * `/instance/public-urls`.
 */
export function registerInstanceHostnameAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    getEnv?: () => Record<string, string | undefined>;
  },
): void {
  admin.get("/instance/hostnames", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: true, hostnames: [] });
    const hostnames = await listInstanceHostnames(db);
    return c.json({ ok: true, hostnames });
  });

  admin.put("/instance/hostnames", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseInstanceHostnamesBody(body);
    if (!parsed.ok) return c.json(parsed, 400);
    const replaced = await replaceInstanceHostnames(db, parsed.hostnames);
    if (!replaced.ok) return c.json(replaced, 422);
    return c.json({ ok: true, hostnames: replaced.hostnames });
  });

  admin.get("/instance/certificates", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: true, certificates: [] });
    const certificates = await listUploadedCertificates(db);
    return c.json({ ok: true, certificates });
  });

  admin.post("/instance/certificates", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) return c.json(ENCRYPTION_UNAVAILABLE, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseCertificateUploadBody(body);
    if (!parsed.ok) return c.json(parsed, 400);
    const stored = await storeUploadedCertificate(
      db,
      dataEncryptionSecrets,
      parsed,
    );
    if (!stored.ok) return c.json(stored, 422);
    return c.json({
      ok: true,
      id: stored.id,
      label: parsed.label.trim(),
      dnsNames: stored.dnsNames,
      hasWildcard: stored.hasWildcard,
      notAfter: stored.notAfter,
      fingerprintSha256: stored.fingerprintSha256,
    }, 201);
  });

  admin.patch("/instance/certificates/:id/hostnames", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseCertificateHostnamesBody(body);
    if (!parsed.ok) return c.json(parsed, 400);
    const attached = await attachUploadedCertificateToHostnames(
      db,
      c.req.param("id"),
      parsed.hosts,
    );
    if (!attached.ok) return c.json(attached, failureStatus(attached.error));
    return c.json({ ok: true, hostnames: attached.hostnames });
  });

  admin.get("/instance/acme", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const resolved = await resolveInstanceAcmeSettings(
      db,
      resolvePlatformEnv(c, opts),
      c.get("dataEncryptionSecrets"),
    );
    return c.json({ settings: instanceAcmeSettingsToApiShape(resolved) });
  });

  admin.put("/instance/acme", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseInstanceAcmeSettingsUpdates(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (
      instanceAcmeUpdatesRequireEncryption(parsed.updates) &&
      !dataEncryptionSecrets
    ) {
      return c.json(ENCRYPTION_UNAVAILABLE, 503);
    }
    const updated = await updateInstanceAcmeSettings(
      db,
      resolvePlatformEnv(c, opts),
      parsed.updates,
      dataEncryptionSecrets,
    );
    if (!updated.ok) return c.json({ error: updated.error }, 422);
    return c.json({
      settings: instanceAcmeSettingsToApiShape(updated.settings),
    });
  });
}
