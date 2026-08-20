/**
 * Org TLS library routes (`/api/client/v1/tls` and `/tls/ca`).
 *
 * Organization CA material is for hosting/managed-DB leaves only. These
 * handlers must never read or write the **Platform CA** files under
 * `<stateDir>/tls/` (see `src/lib/tls/AGENTS.md`).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import type { DerivedSecretsConfig } from "../authn/secrets.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertCanOr403, listVisible } from "../authz/index.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import { getDb } from "../../db.ts";
import {
  assembleTlsMetadata,
  parseTlsOptions,
  splitTlsMetadata,
  type TlsOptions,
  type TlsSource,
} from "../../lib/tls/index.ts";
import { tls } from "../../lib/db/schema.ts";
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
} from "../shared.ts";
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from "../hierarchy-delete.ts";
import {
  applyTlsOptionsPatch,
  buildCreateTlsMaterial,
  classifyTlsInsertConflict,
  type CreateTlsFailure,
  type CreateTlsMaterial,
  isCreateTlsFailure,
  isOrganizationCaUniqueViolation,
  isTlsFingerprintUniqueViolation,
  isTlsUuid,
  materialFromOrganizationCa,
  ORGANIZATION_CA_DOWNLOAD_HEADERS,
  parseSource,
  rotationConflictResponse,
  rotationStatusResponse,
  shouldRevokeTlsFromBody,
  tlsFailurePayload,
  type TlsPublicRow,
  toCaRotationApiResult,
  toPublicTlsRow,
  withPreferOption,
} from "./routes-helpers.ts";
import {
  loadOrganizationCaSet,
  nextOrganizationCaGeneration,
  type OrganizationCaSet,
} from "./organization-ca.ts";
import {
  caRotationHasMintedGeneration,
  loadLatestCaRotation,
  tryBeginCaRotation,
  updateCaRotationJournal,
  type CaRotationJournalRow,
} from "./rotation-lease.ts";
import { countDueTlsLeavesForOrganization } from "./leaf-renewal-sweep.ts";
import {
  type CaRotationResultRow,
  enumerateOrganizationRotationTargets,
  parseCaRotationResults,
  parseNeedsRedeploy,
  parseResumeAfterManagedId,
  runOrganizationCaRotationFanout,
} from "./rotation-fanout.ts";
import { assertDispatchInfrastructure } from "../servers/command-dispatch.ts";
import { listCommandRecordsByIds } from "../../lib/db/command-records.ts";

const TLS_PUBLIC_SELECT = {
  id: tls.id,
  displayName: tls.name,
  source: tls.source,
  organizationId: tls.organizationId,
  status: tls.status,
  notAfter: tls.notAfter,
  fingerprintSha256: tls.fingerprintSha256,
  metadata: tls.metadata,
  options: tls.options,
  certificatePem: tls.certificatePem,
  createdAt: tls.createdAt,
  updatedAt: tls.updatedAt,
  caGeneration: tls.caGeneration,
} as const;

function findActiveOrganizationCa(
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
): Promise<OrganizationCaSet | null> {
  return loadOrganizationCaSet(db, organizationId);
}

function createTlsFailureResponse(
  c: Context<AppEnv>,
  material: CreateTlsFailure,
): Response {
  const payload = tlsFailurePayload(material);
  return c.json(payload.body, payload.status);
}

async function organizationCaRowResponse(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  set: OrganizationCaSet,
): Promise<Response> {
  const publicRow = toPublicTlsRow(set.tls, {
    trustBundlePem: set.trustBundlePem,
  });
  if (!publicRow) return c.json({ error: "Invalid request" }, 500);
  const dueCount = await countDueTlsLeavesForOrganization(
    db,
    set.tls.organizationId,
    { activeCaGeneration: set.signer.caGeneration },
  );
  return c.json({
    tls: publicRow,
    trustBundlePem: set.trustBundlePem,
    leafHealth: {
      dueCount,
      caGeneration: set.signer.caGeneration,
      caNotAfter: set.tls.notAfter,
    },
  });
}

/**
 * Ensure-or-create the organization CA row inside a transaction, racing
 * against a concurrent ensure. Returns the row id, or a `Response` when a
 * concurrent create already won (existing row reused / unique violation).
 */
async function ensureOrganizationCaId(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
  material: CreateTlsMaterial,
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(material.metadata);
  try {
    return await db.transaction(async (tx) => {
      // Race: another concurrent ensure may have inserted first.
      const race = await loadOrganizationCaSet(tx, organizationId);
      if (race) return race.signer.id;

      const caGeneration = await nextOrganizationCaGeneration(
        tx,
        organizationId,
      );
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId,
          name: "Organization CA",
          source: "organization_ca",
          certificatePem: material.certificatePem,
          privateKeyPem: material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: null,
          caState: "active",
          caGeneration,
        })
        .returning({ id: tls.id });
      return inserted.id;
    });
  } catch (err) {
    if (
      isOrganizationCaUniqueViolation(err) ||
      isTlsFingerprintUniqueViolation(err)
    ) {
      const raced = await loadOrganizationCaSet(db, organizationId);
      if (raced) return organizationCaRowResponse(c, db, raced);
      return c.json({ error: "organization_ca_exists" }, 409);
    }
    throw err;
  }
}

async function insertTlsRow(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    organizationId: string;
    displayName: string | null;
    source: TlsSource;
    material: CreateTlsMaterial;
    options: TlsOptions | null;
  },
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(params.material.metadata);
  try {
    return await db.transaction(async (tx) => {
      if (params.source === "organization_ca") {
        const race = await loadOrganizationCaSet(tx, params.organizationId);
        if (race) {
          throw Object.assign(new Error("organization_ca_exists"), {
            code: "ORGANIZATION_CA_EXISTS",
          });
        }
      }
      const caGeneration = params.source === "organization_ca"
        ? await nextOrganizationCaGeneration(tx, params.organizationId)
        : null;
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId: params.organizationId,
          name: params.displayName,
          source: params.source,
          certificatePem: params.material.certificatePem,
          privateKeyPem: params.material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: params.options,
          ...(caGeneration === null
            ? {}
            : { caState: "active" as const, caGeneration }),
        })
        .returning({ id: tls.id });
      return inserted.id;
    });
  } catch (err) {
    const conflict = classifyTlsInsertConflict(err);
    if (conflict) {
      return c.json({ error: conflict.error }, conflict.status);
    }
    throw err;
  }
}

type TlsDb = NonNullable<ReturnType<typeof getDb>>;

function conflictJson(
  c: Context<AppEnv>,
  reason: Parameters<typeof rotationConflictResponse>[0],
): Response {
  const payload = rotationConflictResponse(reason);
  return c.json(payload.body, payload.status);
}

async function markRotationFailed(
  db: TlsDb,
  rotationId: string,
): Promise<void> {
  await updateCaRotationJournal(db, rotationId, { state: "failed" });
}

async function mintRotatedOrganizationCa(
  db: TlsDb,
  organizationId: string,
  material: CreateTlsMaterial,
): Promise<{ id: string; fromGeneration: number; toGeneration: number }> {
  const { columns, residual } = splitTlsMetadata(material.metadata);
  const now = new Date().toISOString();
  return await db.transaction(async (tx) => {
    const current = await loadOrganizationCaSet(tx, organizationId);
    const fromGeneration = current?.signer.caGeneration ?? 0;
    const toGeneration = await nextOrganizationCaGeneration(tx, organizationId);
    await tx
      .update(tls)
      .set({ caState: "retired", updatedAt: now })
      .where(
        and(
          eq(tls.organizationId, organizationId),
          eq(tls.source, "organization_ca"),
          eq(tls.caState, "active"),
        ),
      );
    const [inserted] = await tx
      .insert(tls)
      .values({
        organizationId,
        name: "Organization CA",
        source: "organization_ca",
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPemSealed,
        status: columns.status,
        notAfter: columns.notAfter,
        fingerprintSha256: columns.fingerprintSha256,
        metadata: residual,
        options: null,
        caState: "active",
        caGeneration: toGeneration,
      })
      .returning({ id: tls.id });
    return { id: inserted.id, fromGeneration, toGeneration };
  });
}

async function resolveRotatedOrganizationCa(
  c: Context<AppEnv>,
  db: TlsDb,
  params: {
    organizationId: string;
    journal: CaRotationJournalRow;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<{ activeCaId: string; generation: number } | Response> {
  if (caRotationHasMintedGeneration(params.journal)) {
    const current = await findActiveOrganizationCa(db, params.organizationId);
    if (!current) {
      await markRotationFailed(db, params.journal.id);
      return c.json({ error: "Not found" }, 404);
    }
    return {
      activeCaId: current.signer.id,
      generation: params.journal.toCaGeneration,
    };
  }

  const material = await materialFromOrganizationCa(
    params.dataEncryptionSecrets,
  );
  if (isCreateTlsFailure(material)) {
    await markRotationFailed(db, params.journal.id);
    return createTlsFailureResponse(c, material);
  }

  try {
    const minted = await mintRotatedOrganizationCa(
      db,
      params.organizationId,
      material,
    );
    await updateCaRotationJournal(db, params.journal.id, {
      fromCaGeneration: minted.fromGeneration,
      toCaGeneration: minted.toGeneration,
    });
    return { activeCaId: minted.id, generation: minted.toGeneration };
  } catch (err) {
    await markRotationFailed(db, params.journal.id);
    if (isTlsFingerprintUniqueViolation(err)) {
      return c.json({ error: "tls_fingerprint_conflict" }, 409);
    }
    throw err;
  }
}

function overlayRotationResults(
  rows: readonly CaRotationResultRow[],
  records: readonly { id: string; status: string; error: string | null }[],
) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return rows.map((row) => {
    const record = row.commandId ? byId.get(row.commandId) : undefined;
    return toCaRotationApiResult({
      serverId: row.serverId,
      kind: row.kind,
      managedId: row.managedId,
      status: record?.status ?? row.status,
      commandId: row.commandId,
      error: record?.error ?? row.error,
    });
  });
}

function rotationCommandsSucceeded(
  rows: readonly CaRotationResultRow[],
  records: readonly { id: string; status: string }[],
): boolean {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const row of rows) {
    if (!row.commandId) return false;
    if (byId.get(row.commandId)?.status !== "succeeded") return false;
  }
  return true;
}

function rotationNeedsCommands(targets: {
  managedIds: readonly string[];
  ingressServerIds: readonly string[];
}): boolean {
  return targets.managedIds.length > 0 || targets.ingressServerIds.length > 0;
}

async function runRotationFanoutStep(
  c: Context<AppEnv>,
  db: TlsDb,
  params: {
    organizationId: string;
    rotationId: string;
    actorId: string;
    cursor?: string;
    priorResults?: CaRotationResultRow[];
    priorNeedsRedeploy?: { serverId: string; environmentId: string }[];
  },
): Promise<
  | {
    results: CaRotationResultRow[];
    needsRedeploy: { serverId: string; environmentId: string }[];
  }
  | Response
> {
  const targets = await enumerateOrganizationRotationTargets(
    db,
    params.organizationId,
  );
  if (!rotationNeedsCommands(targets)) {
    await updateCaRotationJournal(db, params.rotationId, {
      state: "awaiting_retire",
    });
    return {
      results: params.priorResults ?? [],
      needsRedeploy: params.priorNeedsRedeploy ?? [],
    };
  }

  const commandQueue = assertDispatchInfrastructure(c);
  if (commandQueue instanceof Response) {
    await markRotationFailed(db, params.rotationId);
    return commandQueue;
  }

  const secretsConfig = c.get("secretsConfig");
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  if (!secretsConfig || !dataEncryptionSecrets) {
    await markRotationFailed(db, params.rotationId);
    return c.json({
      error: "Encryption unavailable — no encryption key configured",
    }, 503);
  }

  try {
    const outcome = await runOrganizationCaRotationFanout(c, db, commandQueue, {
      organizationId: params.organizationId,
      secretsConfig,
      dataEncryptionSecrets,
      actorType: "user",
      actorId: params.actorId,
      rotationId: params.rotationId,
      cursor: params.cursor,
      priorResults: params.priorResults,
      priorNeedsRedeploy: params.priorNeedsRedeploy,
    });
    if (outcome.complete) {
      await updateCaRotationJournal(db, params.rotationId, {
        state: "awaiting_retire",
      });
    }
    return { results: outcome.results, needsRedeploy: outcome.needsRedeploy };
  } catch (err) {
    await markRotationFailed(db, params.rotationId);
    throw err;
  }
}

async function revokeRetiredOrganizationCas(
  db: TlsDb,
  organizationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(tls)
    .set({ caState: "revoked", status: "revoked", updatedAt: now })
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, "organization_ca"),
        eq(tls.caState, "retired"),
      ),
    );
}

type TlsRowPatch = {
  name?: string | null;
  options?: TlsOptions | null;
  status?: string;
  updatedAt: string;
};

function buildTlsRowPatch(
  body: Record<string, unknown>,
  existing: {
    options: unknown;
    status: string;
    notAfter: string | null;
    fingerprintSha256: string | null;
    metadata: unknown;
    source: string;
  },
):
  | { ok: true; patch: TlsRowPatch }
  | { ok: false; error: string; status: 400 | 409 | 500 } {
  const patch: TlsRowPatch = { updatedAt: new Date().toISOString() };

  if (body.displayName !== undefined) {
    try {
      patch.name = parseDisplayName(body);
    } catch {
      return { ok: false, error: "Invalid request", status: 400 };
    }
  }

  const optionsPatch = applyTlsOptionsPatch(
    parseTlsOptions(existing.options) ?? {},
    body,
  );
  if (!optionsPatch.ok) {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  if (optionsPatch.changed) {
    patch.options = optionsPatch.options;
  }

  if (shouldRevokeTlsFromBody(body)) {
    if (existing.source === "organization_ca") {
      return {
        ok: false,
        error: "organization_ca_retire_required",
        status: 409,
      };
    }
    const metadata = assembleTlsMetadata(
      {
        status: existing.status,
        notAfter: existing.notAfter,
        fingerprintSha256: existing.fingerprintSha256,
      },
      existing.metadata,
    );
    if (!metadata) {
      return { ok: false, error: "Invalid request", status: 500 };
    }
    patch.status = "revoked";
  }

  return { ok: true, patch };
}

export function registerTlsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for tls routes");
  }
  const secrets = opts.secrets;

  router.use("/tls", createSessionMiddleware(secrets));
  router.use("/tls/*", createSessionMiddleware(secrets));
  router.use("/tls/:id", createSessionMiddleware(secrets));

  router.get("/tls", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const visibleIds = await listVisible(db, {
      kind: "tls",
      userId: session.userId,
      organizationId,
    });

    if (visibleIds.length === 0) {
      return c.json({ tls: [] });
    }

    const rows = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(
        and(
          inArray(tls.id, visibleIds),
          eq(tls.organizationId, organizationId),
        ),
      )
      .orderBy(tls.createdAt);

    const publicRows = rows
      .map((row) => toPublicTlsRow(row))
      .filter((row): row is TlsPublicRow => row !== null);

    return c.json({ tls: publicRows });
  });

  /**
   * Ensure-or-create the organization CA (at most one active row per org).
   * Managed provisioning later reuses this path without a dedicated wizard.
   */
  router.get("/tls/ca", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const existing = await findActiveOrganizationCa(db, organizationId);
    if (existing) {
      const denied = await assertCanReadOr403(c, "tls", existing.signer.id);
      if (denied) return denied;
      return organizationCaRowResponse(c, db, existing);
    }

    const deniedCreate = await assertCanCreateOr403(
      c,
      "organization",
      organizationId,
    );
    if (deniedCreate) return deniedCreate;

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({
        error: "Encryption unavailable — no encryption key configured",
      }, 503);
    }

    const material = await materialFromOrganizationCa(dataEncryptionSecrets);
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material);
    }

    const idOrResponse = await ensureOrganizationCaId(
      c,
      db,
      organizationId,
      material,
    );
    if (idOrResponse instanceof Response) return idOrResponse;

    const created = await findActiveOrganizationCa(db, organizationId);
    if (!created) return c.json({ error: "Not found" }, 404);
    return organizationCaRowResponse(c, db, created);
  });

  router.post("/tls/ca/rotate", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "organization",
      organizationId,
    );
    if (denied) return denied;

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({
        error: "Encryption unavailable — no encryption key configured",
      }, 503);
    }

    const journal = await tryBeginCaRotation(db, organizationId);
    if (!journal) return conflictJson(c, "ca_rotation_in_progress");

    const signer = await resolveRotatedOrganizationCa(c, db, {
      organizationId,
      journal,
      dataEncryptionSecrets,
    });
    if (signer instanceof Response) return signer;

    const fanout = await runRotationFanoutStep(c, db, {
      organizationId,
      rotationId: journal.id,
      actorId: session.userId,
      cursor: parseResumeAfterManagedId(journal.metadata),
      priorResults: parseCaRotationResults(journal.results),
      priorNeedsRedeploy: parseNeedsRedeploy(journal.metadata),
    });
    if (fanout instanceof Response) return fanout;

    return c.json({
      ok: true as const,
      id: signer.activeCaId,
      rotationId: journal.id,
      generation: signer.generation,
      results: overlayRotationResults(fanout.results, []),
      needsRedeploy: fanout.needsRedeploy,
    });
  });

  router.get("/tls/ca/rotation", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const denied = await assertCanReadOr403(c, "organization", organizationId);
    if (denied) return denied;

    const journal = await loadLatestCaRotation(db, organizationId);
    if (!journal) return c.json({ error: "Not found" }, 404);

    const rows = parseCaRotationResults(journal.results);
    const commandIds = rows.flatMap((
      row,
    ) => (row.commandId ? [row.commandId] : []));
    const records = await listCommandRecordsByIds(db, commandIds);
    return c.json(rotationStatusResponse({
      rotationId: journal.id,
      fromGeneration: journal.fromCaGeneration,
      toGeneration: journal.toCaGeneration,
      state: journal.state,
      results: overlayRotationResults(rows, records),
    }));
  });

  router.post("/tls/ca/retire", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "organization",
      organizationId,
    );
    if (denied) return denied;

    const journal = await loadLatestCaRotation(db, organizationId);
    if (journal?.state !== "awaiting_retire") {
      return conflictJson(c, "no_pending_rotation");
    }

    const rows = parseCaRotationResults(journal.results);
    const commandIds = rows.flatMap((
      row,
    ) => (row.commandId ? [row.commandId] : []));
    const records = await listCommandRecordsByIds(db, commandIds);
    if (!rotationCommandsSucceeded(rows, records)) {
      return conflictJson(c, "ca_rotation_not_converged");
    }

    await revokeRetiredOrganizationCas(db, organizationId);
    await updateCaRotationJournal(db, journal.id, {
      state: "completed",
      completedAt: new Date().toISOString(),
    });
    return c.json({ ok: true as const, rotationId: journal.id });
  });

  router.get("/tls/ca/download", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const set = await findActiveOrganizationCa(db, organizationId);
    if (!set?.trustBundlePem) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanReadOr403(c, "tls", set.signer.id);
    if (denied) return denied;

    return new Response(set.trustBundlePem, {
      status: 200,
      headers: { ...ORGANIZATION_CA_DOWNLOAD_HEADERS },
    });
  });

  router.get("/tls/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "tls", id);
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanReadOr403(c, "tls", id);
    if (denied) return denied;

    const [row] = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);
    const publicRow = toPublicTlsRow(row);
    if (!publicRow) return c.json({ error: "Invalid request" }, 500);

    return c.json({ tls: publicRow });
  });

  router.post("/tls", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const denied = await assertCanCreateOr403(
      c,
      "organization",
      organizationId,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const source = parseSource(body.source);
    if (!source) {
      return c.json({ error: "Invalid request" }, 400);
    }

    if (source === "organization_ca") {
      const existing = await findActiveOrganizationCa(db, organizationId);
      if (existing) {
        return c.json({ error: "organization_ca_exists" }, 409);
      }
    }

    let displayName: string | null;
    try {
      displayName = parseDisplayName(body);
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({
        error: "Encryption unavailable — no encryption key configured",
      }, 503);
    }

    const material = await buildCreateTlsMaterial(
      source,
      body,
      dataEncryptionSecrets,
    );
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material);
    }

    const options = withPreferOption(material.options, body.prefer);

    const idOrResponse = await insertTlsRow(c, db, {
      organizationId,
      displayName,
      source,
      material,
      options,
    });
    if (idOrResponse instanceof Response) return idOrResponse;

    return c.json({ ok: true as const, id: idOrResponse });
  });

  router.patch("/tls/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "tls", id);
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(c, "organization:manage", "tls", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const [existing] = await db
      .select({
        options: tls.options,
        status: tls.status,
        notAfter: tls.notAfter,
        fingerprintSha256: tls.fingerprintSha256,
        metadata: tls.metadata,
        source: tls.source,
      })
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const built = buildTlsRowPatch(body, existing);
    if (!built.ok) {
      return c.json({ error: built.error }, built.status);
    }

    await db.update(tls).set(built.patch).where(eq(tls.id, id));
    return c.json({ ok: true as const });
  });

  router.delete("/tls/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    if (!isTlsUuid(id)) {
      return c.json({ error: "Not found" }, 404);
    }

    const entityOrgId = await resolveEntityOrganizationId(db, "tls", id);
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(c, "organization:manage", "tls", id);
    if (denied) return denied;

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(tls).where(eq(tls.id, id));
    });
    if (result === "has_children") {
      return hierarchyDeleteHasChildrenResponse(c);
    }

    return c.json({ ok: true as const });
  });
}
