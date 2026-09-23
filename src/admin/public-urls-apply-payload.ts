/**
 * Build the `public-urls-update` body for the co-located daemon.
 *
 * A daemon below `instance-cert-sources-per-hostname` receives the flat
 * `urls` list only. Capable daemons also receive each hostname's source and,
 * for `uploaded`, the decrypted pair for this one hop.
 */

import { inArray } from "drizzle-orm";
import type { PublicUrlsApplyPayload } from "./routes-helpers.ts";
import type { Db } from "../db/connection.ts";
import { instanceUploadedCertificate } from "../db/schema.ts";
import type {
  InstanceAcmeWireSettings,
  InstanceHostnameWireEntry,
} from "../contracts/cell-protocol.ts";
import { resolveInstanceAcmeSettings } from "../features/install/instance-acme-settings.ts";
import { listInstanceHostnames } from "../features/install/instance-hostnames.ts";
import { decryptSecret } from "../lib/secrets/data-encryption.ts";
import type { DerivedSecretsConfig } from "../lib/secrets/secrets.ts";
import { resolveDaemonCapabilities } from "../lib/version-wire.ts";

export class PublicUrlsApplyPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlsApplyPayloadError";
  }
}

export async function resolvePublicUrlsApplyPayload(
  db: Db,
  urls: string[],
  daemonVersion: string | undefined,
  secrets: DerivedSecretsConfig | undefined,
  env: Record<string, string | undefined>,
): Promise<PublicUrlsApplyPayload> {
  const capable = resolveDaemonCapabilities(daemonVersion)[
    "instance-cert-sources-per-hostname"
  ] === true;
  if (!capable) return { urls };

  const rows = await listInstanceHostnames(db);
  const uploadedIds = [
    ...new Set(
      rows
        .filter((row) => row.source === "uploaded" && row.uploadedCertId)
        .map((row) => row.uploadedCertId as string),
    ),
  ];
  const decrypted = await decryptUploadedPairs(db, uploadedIds, secrets);
  const hostnames: InstanceHostnameWireEntry[] = rows.map((row) => {
    const entry: InstanceHostnameWireEntry = {
      host: row.host,
      source: row.source,
    };
    if (row.source !== "uploaded" || !row.uploadedCertId) return entry;
    const pair = decrypted.get(row.uploadedCertId);
    if (!pair) {
      throw new PublicUrlsApplyPayloadError(
        `uploaded certificate ${row.uploadedCertId} is missing`,
      );
    }
    return {
      ...entry,
      uploadedCertId: row.uploadedCertId,
      certPem: pair.certPem,
      keyPem: pair.keyPem,
    };
  });
  const letsEncrypt = hostnames.some((entry) =>
    entry.source === "lets-encrypt"
  );
  if (!letsEncrypt) return { urls, hostnames };
  const instanceAcme = await loadInstanceAcme(db, env);
  return { urls, hostnames, instanceAcme };
}

async function loadInstanceAcme(
  db: Db,
  env: Record<string, string | undefined>,
): Promise<InstanceAcmeWireSettings> {
  const resolved = await resolveInstanceAcmeSettings(db, env);
  return {
    contactEmail: resolved.contactEmail,
    tosAccepted: resolved.tosAccepted,
    directoryUrl: resolved.directoryUrl,
    useStaging: resolved.useStaging,
  };
}

async function decryptUploadedPairs(
  db: Db,
  ids: string[],
  secrets: DerivedSecretsConfig | undefined,
): Promise<Map<string, { certPem: string; keyPem: string }>> {
  const out = new Map<string, { certPem: string; keyPem: string }>();
  if (ids.length === 0) return out;
  if (!secrets) {
    throw new PublicUrlsApplyPayloadError(
      "data encryption secrets are required to apply an uploaded certificate",
    );
  }
  const rows = await db
    .select({
      id: instanceUploadedCertificate.id,
      certPem: instanceUploadedCertificate.certPem,
      keyPem: instanceUploadedCertificate.keyPem,
    })
    .from(instanceUploadedCertificate)
    .where(inArray(instanceUploadedCertificate.id, ids));
  for (const row of rows) {
    out.set(row.id, {
      certPem: row.certPem,
      keyPem: await decryptSecret(secrets, row.keyPem),
    });
  }
  return out;
}
