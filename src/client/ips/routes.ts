import { and, eq, inArray, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertCanOr403, listVisible } from "../authz/index.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import { type Db, getDb } from "../../db.ts";
import { hosting, ip, network } from "../../lib/db/schema.ts";
import {
  applyJsonbPatchFields,
  assertDatacenterMembershipNetwork,
  assertIpScopeFkRules,
  type ExistingIpScope,
  IP_ALLOCATIONS,
  IP_SCOPES,
  type IpPatchFields,
  type IpScopeFks,
  isIpAddressUniqueViolation,
  mergeIpScopeFks,
  parseCreateIpAddress,
  parseCreateIpEnums,
  parseEnumQueryFilter,
  parseScopeFkUuid,
  rejectImmutableIpPatchFields,
  serializeIpRow,
  UUID_RE,
} from "./ip-create-validation.ts";

export {
  assertIpScopeFkRules,
  isIpAddressUniqueViolation,
  parseCreateIpAddress,
} from "./ip-create-validation.ts";

import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDescription,
  parseJsonbObject,
  parseJsonBody,
} from "../shared.ts";

const IP_SELECT = {
  id: ip.id,
  organizationId: ip.organizationId,
  datacenterId: ip.datacenterId,
  networkId: ip.networkId,
  serverId: ip.serverId,
  address: ip.address,
  allocation: ip.allocation,
  scope: ip.scope,
  description: ip.description,
  metadata: ip.metadata,
  options: ip.options,
  createdAt: ip.createdAt,
  updatedAt: ip.updatedAt,
};

const IP_SCOPE_FK_FIELDS = [
  ["datacenterId", "datacenter"],
  ["networkId", "network"],
  ["serverId", "server"],
] as const;

type IpScopeFkField = (typeof IP_SCOPE_FK_FIELDS)[number][0];
type IpScopeFkKind = (typeof IP_SCOPE_FK_FIELDS)[number][1];

type CreateIpFields = {
  address: string;
  allocation: string;
  scope: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  options: Record<string, unknown> | null;
} & IpScopeFks;

async function assertSameOrgEntity(
  c: Context,
  db: Db,
  kind: Parameters<typeof resolveEntityOrganizationId>[1],
  entityId: string,
  organizationId: string,
): Promise<Response | null> {
  const entityOrgId = await resolveEntityOrganizationId(db, kind, entityId);
  if (entityOrgId !== organizationId) {
    return c.json({ error: "Not found" }, 404);
  }
  return null;
}

async function validateOptionalScopeFk(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  field: IpScopeFkField,
  kind: IpScopeFkKind,
): Promise<string | null | undefined | Response> {
  if (body[field] === undefined) return undefined;
  const parsed = parseScopeFkUuid(body[field]);
  if (!parsed.ok) {
    return c.json({ error: "Invalid request" }, 400);
  }
  if (parsed.value === null) return null;
  if (parsed.value === undefined) return undefined;
  const id = parsed.value;
  const denied = await assertSameOrgEntity(c, db, kind, id, organizationId);
  if (denied) return denied;
  return id;
}

async function resolveIpScopeFks(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<IpScopeFks | Response> {
  const result: IpScopeFks = {};
  for (const [field, kind] of IP_SCOPE_FK_FIELDS) {
    const value = await validateOptionalScopeFk(
      c,
      db,
      organizationId,
      body,
      field,
      kind,
    );
    if (value instanceof Response) return value;
    if (value !== undefined) result[field] = value;
  }
  return result;
}

async function assertMembershipPinNetwork(
  c: Context,
  db: Db,
  organizationId: string,
  scope: string,
  address: string,
  scopeFks: IpScopeFks,
): Promise<Response | null> {
  if (scope !== "datacenter") return null;
  const hasServer = scopeFks.serverId !== undefined &&
    scopeFks.serverId !== null;
  if (!hasServer) return null;

  const datacenterId = scopeFks.datacenterId;
  const networkId = scopeFks.networkId;
  if (!datacenterId || !networkId) {
    return c.json({ error: "Invalid request" }, 400);
  }

  const [row] = await db
    .select({
      kind: network.kind,
      datacenterId: network.datacenterId,
      cidr: network.cidr,
    })
    .from(network)
    .where(
      and(
        eq(network.id, networkId),
        eq(network.organizationId, organizationId),
      ),
    )
    .limit(1);

  return assertDatacenterMembershipNetwork(
    c,
    address,
    datacenterId,
    row ?? null,
  );
}

async function appendOrgScopedIdFilter(
  c: Context,
  db: Db,
  organizationId: string,
  conditions: SQL[],
  queryKey: "datacenterId" | "serverId" | "networkId",
  kind: "datacenter" | "server" | "network",
): Promise<Response | null> {
  const raw = c.req.query(queryKey)?.trim();
  if (!raw) return null;
  if (!UUID_RE.test(raw)) return c.json({ error: "Invalid request" }, 400);
  const denied = await assertSameOrgEntity(c, db, kind, raw, organizationId);
  if (denied) return denied;
  conditions.push(eq(ip[queryKey], raw));
  return null;
}

async function buildIpListConditions(
  c: Context,
  db: Db,
  organizationId: string,
  visibleIds: string[],
): Promise<SQL[] | Response> {
  const conditions: SQL[] = [
    inArray(ip.id, visibleIds),
    eq(ip.organizationId, organizationId),
  ];

  for (
    const [queryKey, kind] of [
      ["datacenterId", "datacenter"],
      ["serverId", "server"],
      ["networkId", "network"],
    ] as const
  ) {
    const denied = await appendOrgScopedIdFilter(
      c,
      db,
      organizationId,
      conditions,
      queryKey,
      kind,
    );
    if (denied) return denied;
  }

  const scopeFilter = parseEnumQueryFilter(c, "scope", IP_SCOPES);
  if (scopeFilter instanceof Response) return scopeFilter;
  if (scopeFilter) conditions.push(eq(ip.scope, scopeFilter));

  const allocationFilter = parseEnumQueryFilter(
    c,
    "allocation",
    IP_ALLOCATIONS,
  );
  if (allocationFilter instanceof Response) return allocationFilter;
  if (allocationFilter) conditions.push(eq(ip.allocation, allocationFilter));

  return conditions;
}

async function parseCreateIpFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<CreateIpFields | Response> {
  const addressFields = parseCreateIpAddress(c, body);
  if (addressFields instanceof Response) return addressFields;

  const enums = parseCreateIpEnums(c, body);
  if (enums instanceof Response) return enums;

  let description: string | null;
  try {
    description = parseDescription(body);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const metadata = parseJsonbObject(c, body, "metadata");
  if (metadata instanceof Response) return metadata;
  const options = parseJsonbObject(c, body, "options");
  if (options instanceof Response) return options;

  const scopeFks = await resolveIpScopeFks(c, db, organizationId, body);
  if (scopeFks instanceof Response) return scopeFks;

  const scopeDenied = assertIpScopeFkRules(c, enums.scope, scopeFks);
  if (scopeDenied) return scopeDenied;

  const membershipDenied = await assertMembershipPinNetwork(
    c,
    db,
    organizationId,
    enums.scope,
    addressFields.address,
    scopeFks,
  );
  if (membershipDenied) return membershipDenied;

  return {
    ...addressFields,
    ...enums,
    description,
    metadata,
    options,
    ...scopeFks,
  };
}

async function buildIpPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  existing: ExistingIpScope,
): Promise<IpPatchFields | Response> {
  const immutableDenied = rejectImmutableIpPatchFields(c, body);
  if (immutableDenied) return immutableDenied;

  let patchFields: IpPatchFields;
  try {
    const { name, ...rest } = buildPatchUpdateFields(body);
    if (name !== undefined) {
      return c.json({ error: "Invalid request" }, 400);
    }
    patchFields = rest;
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const jsonbDenied = applyJsonbPatchFields(c, body, patchFields);
  if (jsonbDenied) return jsonbDenied;

  const scopeFks = await resolveIpScopeFks(c, db, organizationId, body);
  if (scopeFks instanceof Response) return scopeFks;

  const finalScopeFks = mergeIpScopeFks(existing, scopeFks);

  // Reuse create-time scope/FK rules against the post-patch shape.
  const scopeDenied = assertIpScopeFkRules(c, existing.scope, finalScopeFks);
  if (scopeDenied) return scopeDenied;

  const membershipDenied = await assertMembershipPinNetwork(
    c,
    db,
    organizationId,
    existing.scope,
    existing.address,
    finalScopeFks,
  );
  if (membershipDenied) return membershipDenied;

  Object.assign(patchFields, scopeFks);

  return patchFields;
}

export function registerIpRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for ip routes");
  }
  const secrets = opts.secrets;

  router.use("/ips", createSessionMiddleware(secrets));
  router.use("/ips/:id", createSessionMiddleware(secrets));

  router.get("/ips", async (c) => {
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
      kind: "ip",
      userId: session.userId,
      organizationId,
    });

    if (visibleIds.length === 0) {
      return c.json({ ips: [] });
    }

    const conditions = await buildIpListConditions(
      c,
      db,
      organizationId,
      visibleIds,
    );
    if (conditions instanceof Response) return conditions;

    const rows = await db
      .select(IP_SELECT)
      .from(ip)
      .where(and(...conditions))
      .orderBy(ip.createdAt);

    return c.json({ ips: rows.map((row) => serializeIpRow(row)) });
  });

  router.get("/ips/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "ip", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanReadOr403(c, "ip", id);
    if (denied) return denied;

    const [row] = await db
      .select(IP_SELECT)
      .from(ip)
      .where(eq(ip.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);

    return c.json({ ip: serializeIpRow(row) });
  });

  router.post("/ips", async (c) => {
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

    const fields = await parseCreateIpFields(c, db, organizationId, body);
    if (fields instanceof Response) return fields;

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(ip)
          .values({
            organizationId,
            address: fields.address,
            allocation: fields.allocation,
            scope: fields.scope,
            description: fields.description,
            ...(fields.datacenterId !== undefined
              ? { datacenterId: fields.datacenterId }
              : {}),
            ...(fields.networkId !== undefined
              ? { networkId: fields.networkId }
              : {}),
            ...(fields.serverId !== undefined
              ? { serverId: fields.serverId }
              : {}),
            ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
            ...(fields.options !== null ? { options: fields.options } : {}),
          })
          .returning({ id: ip.id });
        return inserted.id;
      });
      return c.json({ ok: true as const, id });
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: "ip_address_in_use" }, 409);
      }
      throw err;
    }
  });

  router.patch("/ips/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "ip", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(c, "organization:manage", "ip", id);
    if (denied) return denied;

    const [existingIp] = await db
      .select({
        scope: ip.scope,
        serverId: ip.serverId,
        datacenterId: ip.datacenterId,
        networkId: ip.networkId,
        address: ip.address,
      })
      .from(ip)
      .where(eq(ip.id, id))
      .limit(1);
    if (!existingIp) return c.json({ error: "Not found" }, 404);

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const patchFields = await buildIpPatchFields(
      c,
      db,
      organizationId,
      body,
      existingIp,
    );
    if (patchFields instanceof Response) return patchFields;

    await db.update(ip).set(patchFields).where(eq(ip.id, id));

    return c.json({ ok: true as const });
  });

  router.delete("/ips/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "ip", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(c, "organization:manage", "ip", id);
    if (denied) return denied;

    const [hostingRow] = await db
      .select({ id: hosting.id })
      .from(hosting)
      .where(eq(hosting.ipId, id))
      .limit(1);
    if (hostingRow) {
      return c.json({ error: "ip_in_use" }, 409);
    }

    await db.delete(ip).where(eq(ip.id, id));

    return c.json({ ok: true as const });
  });
}
