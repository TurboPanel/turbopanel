import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertCanOr403, listVisible } from "../authz/index.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import { type Db, getDb } from "../../db.ts";
import { datacenter, ip, network, server } from "../../lib/db/schema.ts";
import { parseDatacenterOptions } from "../../lib/datacenter-options.ts";
import { suggestDatacenterNames } from "../../lib/datacenter-name-suggestions.ts";
import { loadDatacenterCidrs } from "../../lib/net/datacenter-networks.ts";
import {
  countUnassignedServersAmong,
  loadDatacenterMembershipsForDatacenter,
  loadDatacenterMembershipsForServers,
  loadSiteNetworkId,
  siteCidrForAddress,
  validateMemberPinAddress,
} from "../../lib/net/datacenter-membership.ts";
import { isIpAddressUniqueViolation } from "../ips/ip-create-validation.ts";
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
  attachPrivateCidrs,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  resolveSeededFields,
  type CreateDatacenterInput,
  type ParsedMemberPin,
  type SelectedServerRow,
} from "./create-input.ts";

export {
  attachPrivateCidrs,
  mergeDatacenterMetadata,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  parseRequiredCidr,
  resolveSeededFields,
} from "./create-input.ts";

function parseCreateDatacenterInput(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateDatacenterInput | Response {
  let name: string | null;
  let description: string | null;
  try {
    name = parseDisplayName(body);
    description = parseDescription(body);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const members = parseMemberPins(body.members);
  const sourceServerId = parseOptionalUuid(body.sourceServerId);
  if (!members.ok || !sourceServerId.ok) {
    return c.json({ error: "Invalid request" }, 400);
  }

  const metadata = parseJsonbObject(c, body, "metadata");
  if (metadata instanceof Response) return metadata;
  const rawOptions = parseJsonbObject(c, body, "options");
  if (rawOptions instanceof Response) return rawOptions;

  return {
    name,
    description,
    metadata,
    options: rawOptions === null ? null : parseDatacenterOptions(rawOptions),
    members: members.value,
    sourceServerId: sourceServerId.value,
  };
}

type MemberServersResult =
  | { ok: true; rows: SelectedServerRow[] }
  | { ok: false; status: 404 }
  | {
    ok: false;
    status: 400;
    error:
      | "invalid_address"
      | "invalid_cidr"
      | "address_not_in_cidr"
      | "address_not_reported"
      | "address_cidr_unreported";
    serverId?: string;
  }
  | { ok: false; status: 409; error: "server_already_member"; serverId: string };

async function loadVisibleMemberServerRows(
  db: Db,
  userId: string,
  organizationId: string,
  members: ParsedMemberPin[],
): Promise<
  | { ok: true; rows: SelectedServerRow[] }
  | { ok: false; status: 404 }
> {
  const serverIds = members.map((m) => m.serverId);
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
  return { ok: true, rows };
}

function validateLoadedMemberPins(
  members: ParsedMemberPin[],
  rows: SelectedServerRow[],
  cidr: string,
): MemberServersResult {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const member of members) {
    const row = byId.get(member.serverId);
    if (!row) return { ok: false, status: 404 };
    const validated = validateMemberPinAddress(
      member.address,
      cidr,
      row.metadata,
    );
    if (!validated.ok) {
      return {
        ok: false,
        status: 400,
        error: validated.error,
        serverId: member.serverId,
      };
    }
  }
  return { ok: true, rows };
}

async function loadMemberServers(
  db: Db,
  userId: string,
  organizationId: string,
  members: ParsedMemberPin[],
  cidr: string,
): Promise<MemberServersResult> {
  const loaded = await loadVisibleMemberServerRows(
    db,
    userId,
    organizationId,
    members,
  );
  if (!loaded.ok) return loaded;
  return validateLoadedMemberPins(members, loaded.rows, cidr);
}

function deriveCreateCidr(
  members: ParsedMemberPin[],
  rows: SelectedServerRow[],
):
  | { ok: true; cidr: string }
  | Exclude<MemberServersResult, { ok: true }> {
  const seed = members[0];
  if (!seed) return { ok: false, status: 404 };
  const seedRow = rows.find((row) => row.id === seed.serverId);
  if (!seedRow) return { ok: false, status: 404 };
  const cidr = siteCidrForAddress(seedRow.metadata, seed.address);
  if (!cidr) {
    return {
      ok: false,
      status: 400,
      error: "address_cidr_unreported",
      serverId: seed.serverId,
    };
  }
  return { ok: true, cidr };
}

async function assertNotAlreadyMemberOfTarget(
  db: Db,
  members: ParsedMemberPin[],
  datacenterId: string,
): Promise<MemberServersResult | null> {
  const memberships = await loadDatacenterMembershipsForServers(
    db,
    members.map((m) => m.serverId),
  );
  for (const member of members) {
    const pins = memberships.get(member.serverId) ?? [];
    if (pins.some((pin) => pin.datacenterId === datacenterId)) {
      return {
        ok: false,
        status: 409,
        error: "server_already_member",
        serverId: member.serverId,
      };
    }
  }
  return null
}

function memberValidationResponse(
  c: Context<AppEnv>,
  result: Exclude<MemberServersResult, { ok: true }>,
): Response {
  if (result.status === 404) return c.json({ error: "Not found" }, 404);
  if (result.status === 409) {
    return c.json({ error: result.error, serverId: result.serverId }, 409);
  }
  return c.json(
    {
      error: result.error,
      ...(result.serverId ? { serverId: result.serverId } : {}),
    },
    400,
  );
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
  router.use("/datacenters/:id/members", createSessionMiddleware(secrets));
  router.use(
    "/datacenters/:id/members/:serverId",
    createSessionMiddleware(secrets),
  );

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

    const query = parseNameSuggestionsQuery(
      c.req.query("unassignedOnly"),
      c.req.query("limit"),
    );
    if (query === "invalid") {
      return c.json({ error: "Invalid request" }, 400);
    }
    const { unassignedOnly, limit } = query;

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
        name: server.name,
        metadata: server.metadata,
      })
      .from(server)
      .where(
        and(
          inArray(server.id, visibleIds),
          eq(server.organizationId, organizationId),
        ),
      );

    const { memberServerIds } = await countUnassignedServersAmong(
      db,
      rows.map((row) => row.id),
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
          name: row.name,
          hostname,
          // Name suggestions treat "unassigned" as zero memberships.
          datacenterId: memberServerIds.has(row.id) ? "member" : null,
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
    const members = await loadDatacenterMembershipsForDatacenter(db, row.id);

    return c.json({
      datacenter: withCidrs,
      members: members.map((m) => ({
        serverId: m.serverId,
        address: m.address,
        ipId: m.ipId,
        networkId: m.networkId,
      })),
    });
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

    const loaded = await loadVisibleMemberServerRows(
      db,
      session.userId,
      organizationId,
      input.members,
    );
    if (!loaded.ok) {
      return memberValidationResponse(c, loaded);
    }

    const derived = deriveCreateCidr(input.members, loaded.rows);
    if (!derived.ok) {
      return memberValidationResponse(c, derived);
    }
    const cidr = derived.cidr;

    const memberServers = validateLoadedMemberPins(
      input.members,
      loaded.rows,
      cidr,
    );
    if (!memberServers.ok) {
      return memberValidationResponse(c, memberServers);
    }

    const seeded = resolveSeededFields(input, memberServers.rows);

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(datacenter)
          .values({
            organizationId,
            name: seeded.name,
            description: input.description,
            ...(seeded.metadata !== null ? { metadata: seeded.metadata } : {}),
            ...(input.options !== null ? { options: input.options } : {}),
          })
          .returning({ id: datacenter.id });

        const [siteNetwork] = await tx
          .insert(network)
          .values({
            organizationId,
            datacenterId: inserted.id,
            kind: "datacenter",
            cidr,
            name: seeded.name,
          })
          .returning({ id: network.id });

        for (const member of input.members) {
          await tx.insert(ip).values({
            organizationId,
            datacenterId: inserted.id,
            networkId: siteNetwork.id,
            serverId: member.serverId,
            address: member.address,
            allocation: "dedicated",
            scope: "datacenter",
          });
        }

        return inserted.id;
      });

      return c.json({ ok: true as const, id });
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: "address_in_use" }, 409);
      }
      throw err;
    }
  });

  router.post("/datacenters/:id/members", async (c) => {
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

    const members = parseMemberPins(body.members ?? [body]);
    if (!members.ok) return c.json({ error: "Invalid request" }, 400);

    const site = await loadSiteNetworkId(db, id);
    if (!site) {
      return c.json({ error: "datacenter_cidr_required" }, 422);
    }

    const memberServers = await loadMemberServers(
      db,
      session.userId,
      organizationId,
      members.value,
      site.cidr,
    );
    if (!memberServers.ok) {
      return memberValidationResponse(c, memberServers);
    }

    const already = await assertNotAlreadyMemberOfTarget(
      db,
      members.value,
      id,
    );
    if (already && !already.ok) {
      return memberValidationResponse(c, already);
    }

    try {
      await db.transaction(async (tx) => {
        for (const member of members.value) {
          await tx.insert(ip).values({
            organizationId,
            datacenterId: id,
            networkId: site.networkId,
            serverId: member.serverId,
            address: member.address,
            allocation: "dedicated",
            scope: "datacenter",
          });
        }
      });
      return c.json({ ok: true as const });
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: "address_in_use" }, 409);
      }
      throw err;
    }
  });

  router.delete("/datacenters/:id/members/:serverId", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const serverId = c.req.param("serverId");
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

    const deleted = await db
      .delete(ip)
      .where(
        and(
          eq(ip.scope, "datacenter"),
          eq(ip.datacenterId, id),
          eq(ip.serverId, serverId),
        ),
      )
      .returning({ id: ip.id });

    if (deleted.length === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ ok: true as const });
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
      name?: string | null;
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

    const members = await loadDatacenterMembershipsForDatacenter(db, id);
    if (members.length > 0) {
      return c.json({ error: "datacenter_has_members" }, 409);
    }

    const scopedNetworks = await db
      .select({ id: network.id, kind: network.kind })
      .from(network)
      .where(eq(network.datacenterId, id));
    if (scopedNetworks.some((row) => row.kind !== "datacenter")) {
      return c.json({ error: "datacenter_has_networks" }, 409);
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(network)
        .where(
          and(
            eq(network.datacenterId, id),
            eq(network.kind, "datacenter"),
          ),
        );
      await tx.delete(datacenter).where(eq(datacenter.id, id));
    });

    return c.json({ ok: true as const });
  });
}
