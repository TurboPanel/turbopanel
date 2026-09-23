/**
 * Uploaded certificate pairs for the control plane's own names.
 *
 * Parsing and key match call `src/lib/tls/` as pure functions. This module
 * does not add instance-ACME imports into that tree, and it does not read or
 * write organization `tls` rows.
 *
 * Instance ACME is independent of every organization. This module must not
 * import the organization options module, must not read or write an
 * organization's ACME opt-in, and must not touch any `tls` table row.
 */

import { isNotNull } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
} from "../../db/schema.ts";
import { encryptSecret } from "../../lib/secrets/data-encryption.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import {
  privateKeyMatchesCertificate,
  TlsKeyError,
} from "../../lib/tls/keys.ts";
import {
  CertificateParseError,
  parseCertificatePem,
} from "../../lib/tls/parse.ts";
import {
  applyUploadedCertificateHosts,
  type InstanceHostnameFailure,
} from "./instance-hostnames.ts";

export type CertificateUploadSuccess = {
  ok: true;
  dnsNames: string[];
  hasWildcard: boolean;
  notAfter: string;
  fingerprintSha256: string;
};

export type CertificateUploadFailure = {
  ok: false;
  error: string;
};

export type UploadedCertificateRecord = {
  id: string;
  label: string;
  dnsNames: string[];
  notAfter: string;
  createdAt: string;
  hostnames: string[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function validationError(
  err: unknown,
  fallback: string,
): CertificateUploadFailure {
  if (err instanceof CertificateParseError || err instanceof TlsKeyError) {
    return { ok: false, error: err.message };
  }
  if (err instanceof Error && err.message.trim() !== "") {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: fallback };
}

/**
 * Parse a leaf PEM, collect DNS and IP names, and prove the private key
 * matches. Does not write anything.
 */
export async function validateCertificateUpload(
  certPem: string,
  keyPem: string,
): Promise<CertificateUploadSuccess | CertificateUploadFailure> {
  let parsed;
  try {
    parsed = await parseCertificatePem(certPem);
  } catch (err) {
    return validationError(err, "Invalid certificate PEM");
  }

  try {
    const matches = await privateKeyMatchesCertificate(keyPem, parsed);
    if (!matches) {
      return { ok: false, error: "Private key does not match the certificate" };
    }
  } catch (err) {
    return validationError(err, "Private key does not match the certificate");
  }

  const dnsNames = [...parsed.dnsNames, ...parsed.ipAddresses];
  return {
    ok: true,
    dnsNames,
    hasWildcard: parsed.hasWildcard ||
      dnsNames.some((name) => name.startsWith("*.")),
    notAfter: parsed.notAfter.toISOString(),
    fingerprintSha256: parsed.fingerprintSha256,
  };
}

export async function storeUploadedCertificate(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: { label: string; certPem: string; keyPem: string },
): Promise<
  | (CertificateUploadSuccess & { id: string })
  | CertificateUploadFailure
> {
  const label = input.label.trim();
  if (label === "" || label.length > 255) {
    return { ok: false, error: "Certificate label is required" };
  }
  const validated = await validateCertificateUpload(
    input.certPem,
    input.keyPem,
  );
  if (!validated.ok) return validated;

  const keyPem = await encryptSecret(dataEncryptionSecrets, input.keyPem);
  const inserted = await db
    .insert(instanceUploadedCertificate)
    .values({
      label,
      certPem: input.certPem,
      keyPem,
      dnsNames: validated.dnsNames,
      notAfter: validated.notAfter,
    })
    .returning({ id: instanceUploadedCertificate.id });
  const id = inserted[0]?.id;
  if (!id) return { ok: false, error: "Failed to store the certificate" };
  return { ...validated, id };
}

export async function listUploadedCertificates(
  db: Db,
): Promise<UploadedCertificateRecord[]> {
  const certs = await db
    .select()
    .from(instanceUploadedCertificate)
    .where(isNotNull(instanceUploadedCertificate.id));
  const names = await db
    .select({
      host: instanceHostname.host,
      uploadedCertId: instanceHostname.uploadedCertId,
    })
    .from(instanceHostname)
    .where(isNotNull(instanceHostname.id));

  return certs
    .map((cert) => ({
      id: cert.id,
      label: cert.label,
      dnsNames: asStringArray(cert.dnsNames),
      notAfter: cert.notAfter,
      createdAt: cert.createdAt,
      hostnames: names
        .filter((row) => row.uploadedCertId === cert.id)
        .map((row) => row.host)
        .sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export async function attachUploadedCertificateToHostnames(
  db: Db,
  certId: string,
  hosts: string[],
  opts: { allowHttp?: boolean } = {},
): Promise<
  | { ok: true; hostnames: string[] }
  | InstanceHostnameFailure
  | CertificateUploadFailure
> {
  const certs = await listUploadedCertificates(db);
  const cert = certs.find((item) => item.id === certId);
  if (!cert) return { ok: false, error: "Certificate not found" };
  return await applyUploadedCertificateHosts(
    db,
    { id: cert.id, dnsNames: cert.dnsNames, notAfter: cert.notAfter },
    hosts,
    opts,
  );
}
