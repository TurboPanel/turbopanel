import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertCanOr403, listVisible } from "../authz/index.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import { type Db, getDb } from "../../db.ts";
import { datacenter, network, server } from "../../lib/db/schema.ts";
import { parseDatacenterOptions } from "../../lib/datacenter-options.ts";
import { suggestDatacenterNames } from "../../lib/datacenter-name-suggestions.ts";
import { loadDatacenterCidrs } from "../../lib/net/datacenter-networks.ts";
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDescription,
  parseDisplayName,
  parseJsonbObject,
  parseJsonBody,
} from "../shared.ts";
import {
  parseAssignServerIds,
  resolveSeededFields,
  type CreateDatacenterInput,
  type SelectedServerRow,
} from "./create-input.ts";

export {
  mergeDatacenterMetadata,
  parseAssignServerIds,
  resolveSeededFields,
} from "./create-input.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false };

function parseOptionalUuid(value: unknown): ParseResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parseCreateDatacenterInput(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateDatacenterInput | Response {
  let displayName: string | null;
  let description: string | null;
  try {
    displayName = parseDisplayName(body);
    description = parseDescription(body);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const sourceServerId = parseOptionalUuid(body.sourceServerId);
  const assignServerIds = parseAssignServerIds(body.assignServerIds);
  if (!sourceServerId.ok || !assignServerIds.ok) {
    return c.json({ error: "Invalid request" }, 400);
  }

  const metadata = parseJsonbObject(c, body, "metadata");
  if (metadata instanceof Response) return metadata;
  const rawOptions = parseJsonbObject(c, body, "options");
  if (rawOptions instanceof Response) return rawOptions;

  return {
    displayName,
    description,
    metadata,
    options: rawOptions === null ? null : parseDatacenterOptions(rawOptions),
    sourceServerId: sourceServerId.value,
    assignServerIds: assignServerIds.value,
  };
}

type AssignableServersResult =
  | { ok: true; rows: SelectedServerRow[] }
  | { ok: false; status: 404 }
  | { ok: false; status: 409; serverId: string };

async function loadAssignableServers(
  db: Db,
  userId: string,
  organizationId: string,
  serverIds: string[],
): Promise<AssignableServersResult> {
  if (serverIds.length === 0) return { ok: true, rows: [] };

  const visibleIds = await listVisible(db, {
    kind: "server",
    userId,
    organizationId,
  });
  if (serverIds.some((id) => !visibleIds.includes(id))) {
    return { ok: false, status: 404 };
  }

  const rows = await db
    .select({
      id: server.id,
      datacenterId: server.datacenterId,
      metadata: server.metadata,
    })
    .from(server)
    .where(
      and(
        inArray(server.id, serverIds),
        eq(server.organizationId, organizationId),
      ),
    );
  if (rows.length !== serverIds.length) {
    return { ok: false, status: 404 };
  }
  const assignedRow = rows.find((row) => row.datacenterId);
  if (assignedRow) {
    return { ok: false, status: 409, serverId: assignedRow.id };
  }
  return { ok: true, rows };
}

function attachPrivateCidrs<T extends { id: string }>(
  rows: T[],
  cidrsByDc: Map<string, string[]>,
): Array<T & { privateCidrs: string[] }> {
  return rows.map((row) => ({
    ...row,
    privateCidrs: cidrsByDc.get(row.id) ?? [],
  }));
}

export function registerDatacenterRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for datacenter routes");
  }
  const secrets = opts.secrets;

  router.use("/datacenters", createSessionMiddleware(secrets));
  router.use("/datacenters/:id", createSessionMiddleware(secrets));

  router.get("/datacenters", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const manageDenied = await assertCanManageOr403(
      c,
      "organization",
      organizationId,
    );
    if (manageDenied) return manageDenied;

    const visibleIds = await listVisible(db, {
      kind: "datacenter",
      userId: session.userId,
      organizationId,
    });

    if (visibleIds.length === 0) {
      return c.json({ datacenters: [] });
    }

    const rows = await db
      .select({
        id: datacenter.id,
        displayName: datacenter.name,
        description: datacenter.description,
        organizationId: datacenter.organizationId,
        metadata: datacenter.metadata,
        options: datacenter.options,
        createdAt: datacenter.createdAt,
        updatedAt: datacenter.updatedAt,
      })
      .from(datacenter)
      .where(
        and(
          inArray(datacenter.id, visibleIds),
          eq(datacenter.organizationId, organizationId),
        ),
      )
      .orderBy(datacenter.createdAt);

    const cidrsByDc = await loadDatacenterCidrs(
      db,
      rows.map((row) => row.id),
    );

    return c.json({ datacenters: attachPrivateCidrs(rows, cidrsByDc) });
  });

  router.get("/datacenters/name-suggestions", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const manageDenied = await assertCanManageOr403(
      c,
      "organization",
      organizationId,
    );
    if (manageDenied) return manageDenied;

    const unassignedOnly = c.req.query("unassignedOnly") !== "0";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 8 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0 || limit > 32) {
      return c.json({ error: "Invalid request" }, 400);
    }

    const visibleIds = await listVisible(db, {
      kind: "server",
      userId: session.userId,
      organizationId,
    });
    if (visibleIds.length === 0) {
      return c.json({ suggestions: [] });
    }

    const rows = await db
      .select({
        id: server.id,
        displayName: server.name,
        datacenterId: server.datacenterId,
        metadata: server.metadata,
      })
      .from(server)
      .where(
        and(
          inArray(server.id, visibleIds),
          eq(server.organizationId, organizationId),
        ),
      );

    const suggestions = suggestDatacenterNames(
      rows.map((row) => {
        const meta =
          typeof row.metadata === "object" && row.metadata !== null &&
            !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null;
        const hostname =
          typeof meta?.hostname === "string" && meta.hostname.trim()
            ? meta.hostname.trim()
            : null;
        return {
          id: row.id,
          displayName: row.displayName,
          hostname,
          datacenterId: row.datacenterId,
          metadata: row.metadata,
        };
      }),
      { limit, unassignedOnly },
    );

    return c.json({ suggestions });
  });

  router.get("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanReadOr403(c, "datacenter", id);
    if (denied) return denied;

    const [row] = await db
      .select({
        id: datacenter.id,
        displayName: datacenter.name,
        description: datacenter.description,
        organizationId: datacenter.organizationId,
        metadata: datacenter.metadata,
        options: datacenter.options,
        createdAt: datacenter.createdAt,
        updatedAt: datacenter.updatedAt,
      })
      .from(datacenter)
      .where(eq(datacenter.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);

    const cidrsByDc = await loadDatacenterCidrs(db, [row.id]);
    const [withCidrs] = attachPrivateCidrs([row], cidrsByDc);

    return c.json({ datacenter: withCidrs });
  });

  router.post("/datacenters", async (c) => {
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

    const input = parseCreateDatacenterInput(c, body);
    if (input instanceof Response) return input;
    const serverIdsToAssign = [
      ...new Set([
        ...input.assignServerIds,
        ...(input.sourceServerId ? [input.sourceServerId] : []),
      ]),
    ];
    const assignableServers = await loadAssignableServers(
      db,
      session.userId,
      organizationId,
      serverIdsToAssign,
    );
    if (!assignableServers.ok) {
      if (assignableServers.status === 409) {
        return c.json({
          error: "server_already_assigned",
          serverId: assignableServers.serverId,
        }, 409);
      }
      return c.json({ error: "Not found" }, 404);
    }
    const seeded = resolveSeededFields(
      input,
      assignableServers.rows,
    );

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(datacenter)
        .values({
          organizationId,
          name: seeded.displayName,
          description: input.description,
          ...(seeded.metadata !== null ? { metadata: seeded.metadata } : {}),
          ...(input.options !== null ? { options: input.options } : {}),
        })
        .returning({ id: datacenter.id });

      if (serverIdsToAssign.length > 0) {
        await tx
          .update(server)
          .set({
            datacenterId: inserted.id,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              inArray(server.id, serverIdsToAssign),
              eq(server.organizationId, organizationId),
            ),
          );
      }

      return inserted.id;
    });

    return c.json({ ok: true as const, id });
  });

  router.patch("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    let patchFields: {
      displayName?: string | null;
      description?: string | null;
      metadata?: Record<string, unknown> | null;
      options?: ReturnType<typeof parseDatacenterOptions>;
      updatedAt: string;
    };
    try {
      patchFields = buildPatchUpdateFields(body);
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }

    const metadataResult = parseJsonbObject(c, body, "metadata");
    if (metadataResult instanceof Response) return metadataResult;
    if (metadataResult !== null) patchFields.metadata = metadataResult;

    const optionsResult = parseJsonbObject(c, body, "options");
    if (optionsResult instanceof Response) return optionsResult;
    if (optionsResult !== null) {
      patchFields.options = parseDatacenterOptions(optionsResult);
    }

    await db.update(datacenter).set(patchFields).where(eq(datacenter.id, id));

    return c.json({ ok: true as const });
  });

  router.delete("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const [scopedNetwork] = await db
      .select({ id: network.id })
      .from(network)
      .where(eq(network.datacenterId, id))
      .limit(1);
    if (scopedNetwork) {
      return c.json({ error: "datacenter_has_networks" }, 409);
    }

    await db.delete(datacenter).where(eq(datacenter.id, id));

    return c.json({ ok: true as const });
  });
}
