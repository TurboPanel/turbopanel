import {
  encryptSecret,
  ENVELOPE_MAGIC,
  isSealedEnvelope,
} from "../authn/data-encryption.ts";
import type { DerivedSecretsConfig } from "../authn/secrets.ts";
import {
  assembleTlsMetadata,
  metadataFromParsed,
  mintOrganizationCa,
  mintSelfSignedCertificate,
  parseCertificatePem,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  refreshTlsStatus,
  splitCertificateChain,
  TLS_SOURCES,
  type TlsMetadata,
  type TlsOptions,
  type TlsSource,
} from "../../lib/tls/index.ts";

export const TLS_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTlsUuid(value: string): boolean {
  return TLS_UUID_RE.test(value);
}

export type TlsPublicRow = {
  id: string;
  displayName: string | null;
  source: string;
  organizationId: string;
  metadata: TlsMetadata;
  options: TlsOptions | null;
  certificatePem: string | null;
  /**
   * Active+retired Organization CA PEM bundle. Present on GET /tls/ca only —
   * list/detail rows omit it. Signing still uses `certificatePem` (active).
   */
  trustBundlePem?: string;
  /**
   * Organization CA generation. Present on Organization CA rows; `null` for
   * other library certificates.
   */
  caGeneration?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TlsRowForPublic = {
  id: string;
  displayName: string | null;
  source: string;
  organizationId: string;
  status: string;
  notAfter: string | null;
  fingerprintSha256: string | null;
  metadata: unknown;
  options: unknown;
  certificatePem: string | null;
  createdAt: string;
  updatedAt: string;
  caGeneration?: number | null;
};

export function toPublicTlsRow(
  row: TlsRowForPublic,
  extras?: { trustBundlePem?: string },
): TlsPublicRow | null {
  const metadata = assembleTlsMetadata(
    {
      status: row.status,
      notAfter: row.notAfter,
      fingerprintSha256: row.fingerprintSha256,
    },
    row.metadata,
  );
  if (!metadata) return null;
  const publicRow: TlsPublicRow = {
    id: row.id,
    displayName: row.displayName,
    source: row.source,
    organizationId: row.organizationId,
    metadata: refreshTlsStatus(metadata),
    options: parseTlsOptions(row.options),
    certificatePem: row.certificatePem,
    caGeneration: row.caGeneration ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (extras?.trustBundlePem !== undefined) {
    publicRow.trustBundlePem = extras.trustBundlePem;
  }
  return publicRow;
}

/** Private keys at rest must be `tpsecret` envelopes — never PEM plaintext. */
export function assertTpSecretPrivateKey(sealed: string): void {
  if (
    !isSealedEnvelope(sealed) ||
    !sealed.startsWith(`${ENVELOPE_MAGIC}.`) ||
    sealed.includes("BEGIN")
  ) {
    throw new TypeError("tls private key must be a tpsecret envelope");
  }
}

export type CaRotationConflictReason =
  | "ca_rotation_in_progress"
  | "no_pending_rotation"
  | "ca_rotation_not_converged";

export type CaRotationApiResult = {
  serverId: string;
  status: string;
  kind?: string;
  managedId?: string;
  commandId?: string;
  error?: string;
};

export type CaRotationStatusBody = {
  rotationId: string;
  fromGeneration: number;
  toGeneration: number;
  state: string;
  results: CaRotationApiResult[];
  retiredCaStillRequired: boolean;
};

export function rotationConflictResponse(reason: CaRotationConflictReason): {
  body: { error: CaRotationConflictReason };
  status: 409;
} {
  return { body: { error: reason }, status: 409 };
}

export function toCaRotationApiResult(row: {
  serverId: string;
  status: string;
  kind?: string;
  managedId?: string;
  commandId?: string;
  error?: string;
}): CaRotationApiResult {
  const result: CaRotationApiResult = {
    serverId: row.serverId,
    status: row.status,
  };
  if (row.kind) result.kind = row.kind;
  if (row.managedId) result.managedId = row.managedId;
  if (row.commandId) result.commandId = row.commandId;
  if (row.error) result.error = row.error;
  return result;
}

export function rotationStatusResponse(params: {
  rotationId: string;
  fromGeneration: number;
  toGeneration: number;
  state: string;
  results: readonly CaRotationApiResult[];
}): CaRotationStatusBody {
  return {
    rotationId: params.rotationId,
    fromGeneration: params.fromGeneration,
    toGeneration: params.toGeneration,
    state: params.state,
    results: [...params.results],
    retiredCaStillRequired: params.state !== "completed",
  };
}

export function tlsFailurePayload(material: CreateTlsFailure): {
  body: { error: string; detail?: string };
  status: 400;
} {
  if (material.detail === undefined) {
    return { body: { error: material.error }, status: material.status };
  }
  return {
    body: { error: material.error, detail: material.detail },
    status: material.status,
  };
}

export function isOrganizationCaExistsCode(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ORGANIZATION_CA_EXISTS"
  );
}

export type TlsInsertConflict =
  | { error: "organization_ca_exists"; status: 409 }
  | { error: "tls_fingerprint_conflict"; status: 409 };

export function classifyTlsInsertConflict(
  err: unknown,
): TlsInsertConflict | null {
  if (isOrganizationCaExistsCode(err) || isOrganizationCaUniqueViolation(err)) {
    return { error: "organization_ca_exists", status: 409 };
  }
  if (isTlsFingerprintUniqueViolation(err)) {
    return { error: "tls_fingerprint_conflict", status: 409 };
  }
  return null;
}

export const ORGANIZATION_CA_DOWNLOAD_HEADERS = {
  "Content-Type": "application/x-pem-file",
  "Content-Disposition": 'attachment; filename="organization-ca.pem"',
} as const;

export function shouldRevokeTlsFromBody(
  body: Record<string, unknown>,
): boolean {
  return body.revoke === true;
}

export type CreateTlsMaterial = {
  certificatePem: string | null;
  privateKeyPemSealed: string | null;
  metadata: TlsMetadata;
  options: TlsOptions | null;
};

export type CreateTlsFailure = {
  error: string;
  detail?: string;
  status: 400;
};

export type CreateTlsResult = CreateTlsMaterial | CreateTlsFailure;

export function parseSource(value: unknown): TlsSource | null {
  if (typeof value !== "string") return null;
  return (TLS_SOURCES as readonly string[]).includes(value)
    ? (value as TlsSource)
    : null;
}

export function parseHostnames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);
  return names.length > 0 ? names : null;
}

export function isCreateTlsFailure(
  result: CreateTlsResult,
): result is CreateTlsFailure {
  return "status" in result;
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    "code" in err && (err as { code: string }).code === "23505";
}

export function isTlsFingerprintUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("uniq_tls_organization_fingerprint_sha256");
}

export function isOrganizationCaUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("uniq_tls_organization_active_ca");
}

export function createFailure(
  error: string,
  detail?: string,
): CreateTlsFailure {
  if (detail === undefined) {
    return { error, status: 400 };
  }
  return { error, detail, status: 400 };
}

export function materialFromLetsEncrypt(
  body: Record<string, unknown>,
): CreateTlsResult {
  const hostnames = parseHostnames(body.hostnames);
  if (!hostnames) {
    return createFailure("Invalid request");
  }
  return {
    certificatePem: null,
    privateKeyPemSealed: null,
    metadata: {
      dnsNames: hostnames,
      hasWildcard: hostnames.some((n) => n.startsWith("*.")),
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      fingerprintSha256: "",
      subject: "",
      issuer: "",
      status: "pending",
      acme: {
        challengeType: body.challengeType === "dns-01" ? "dns-01" : "http-01",
      },
    },
    options: {
      autoRenew: body.autoRenew !== false,
      requestedHostnames: hostnames,
    },
  };
}

export function withPreferOption(
  options: TlsOptions | null,
  prefer: unknown,
): TlsOptions | null {
  if (typeof prefer !== "number" || !Number.isFinite(prefer)) {
    return options;
  }
  if (options) {
    return { ...options, prefer };
  }
  return { prefer };
}

export type OptionsPatchResult =
  | { ok: true; options: TlsOptions; changed: boolean }
  | { ok: false };

export function applyTlsOptionsPatch(
  currentOptions: TlsOptions,
  body: Record<string, unknown>,
): OptionsPatchResult {
  const nextOptions: TlsOptions = { ...currentOptions };
  let changed = false;

  if (body.prefer !== undefined) {
    if (body.prefer === null) {
      delete nextOptions.prefer;
      changed = true;
    } else if (
      typeof body.prefer === "number" && Number.isFinite(body.prefer)
    ) {
      nextOptions.prefer = body.prefer;
      changed = true;
    } else {
      return { ok: false };
    }
  }

  if (body.autoRenew !== undefined) {
    if (typeof body.autoRenew !== "boolean") {
      return { ok: false };
    }
    nextOptions.autoRenew = body.autoRenew;
    changed = true;
  }

  return { ok: true, options: nextOptions, changed };
}

export async function materialFromUpload(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  if (
    typeof body.certificatePem !== "string" ||
    typeof body.privateKeyPem !== "string"
  ) {
    return createFailure("Invalid request");
  }
  try {
    // Normalize chain ordering (leaf first).
    const certificatePem = splitCertificateChain(body.certificatePem).join("");
    const parsed = await parseCertificatePem(certificatePem);
    const matches = await privateKeyMatchesCertificate(
      body.privateKeyPem,
      parsed,
    );
    if (!matches) {
      return createFailure("certificate_key_mismatch");
    }
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      body.privateKeyPem.trim(),
    );
    assertTpSecretPrivateKey(privateKeyPemSealed);
    return {
      certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(parsed, "ready"),
      options: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid certificate";
    return createFailure("invalid_certificate", message);
  }
}

export async function materialFromSelfSigned(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  const hostnames = parseHostnames(body.hostnames);
  if (!hostnames) {
    return createFailure("Invalid request");
  }
  try {
    const material = await mintSelfSignedCertificate(hostnames);
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      material.privateKeyPem,
    );
    assertTpSecretPrivateKey(privateKeyPemSealed);
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, "ready"),
      options: { requestedHostnames: hostnames },
    };
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : "self-signed mint failed";
    return createFailure("invalid_certificate", message);
  }
}

export async function materialFromOrganizationCa(
  secrets: DerivedSecretsConfig,
  opts?: { commonName?: string },
): Promise<CreateTlsResult> {
  try {
    const material = await mintOrganizationCa(
      opts?.commonName === undefined
        ? undefined
        : { commonName: opts.commonName },
    );
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      material.privateKeyPem,
    );
    assertTpSecretPrivateKey(privateKeyPemSealed);
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, "ready"),
      options: null,
    };
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : "organization CA mint failed";
    return createFailure("invalid_certificate", message);
  }
}

export async function buildCreateTlsMaterial(
  source: TlsSource,
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  switch (source) {
    case "upload":
      return await materialFromUpload(body, secrets);
    case "self_signed":
      return await materialFromSelfSigned(body, secrets);
    case "lets_encrypt":
      return materialFromLetsEncrypt(body);
    case "organization_ca":
      return await materialFromOrganizationCa(
        secrets,
        typeof body.commonName === "string"
          ? { commonName: body.commonName }
          : undefined,
      );
  }
}
