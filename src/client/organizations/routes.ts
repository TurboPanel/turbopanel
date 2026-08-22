import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { createOrganizationForUser } from "../authn/install-state.ts";
import { assertOrgOwnerOr403 } from "../authz/index.ts";
import {
  canAccessOrganization,
  listAccessibleOrganizations,
} from "../org-context.ts";
import {
  assertCanManageOr403,
  assertCanReadOr403,
  parseJsonBody,
} from "../shared.ts";
import { type Db, getContainerLogStore, getDb } from "../../db.ts";
import { organization } from "../../lib/db/schema.ts";
import { parseOrganizationOptions } from "../../lib/organization-options.ts";
import { loadOrgServerCapacity } from "../../lib/server-capacity.ts";
import { listTimezones } from "../../lib/timezones.ts";
import { isDisabledContainerLogStore } from "../../lib/container-logs/store-selection.ts";
import { resolveContainerLogsEnabled } from "../../lib/container-logs/org-settings.ts";
import { ContainerLogStoreUnavailableError } from "../../lib/container-logs/cloudflare/pipeline-store.ts";
import {
  applyManagedDefaultsPatch,
  containerLogSettingsGetResponse,
  containerLogSettingsPutResponse,
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  hostDefaultsGetResponse,
  hostDefaultsPutResponse,
  managedDefaultsGetResponse,
  managedDefaultsPutResponse,
  parseContainerLogQueryParams,
  parseContainerLogSettingsPatch,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseHostDefaultsPatch,
  parseManagedDefaultsPatch,
  parseOrganizationCreateDisplayName,
  parseOrganizationPatchDisplayName,
  parseServerCapacityPutBody,
  toOrganizationRecord,
  validateManagedDefaults,
} from "./routes-helpers.ts";
import { registerOrganizationFabricRoutes } from "./fabric-routes.ts";

async function loadOrganizationRecord(db: Db, id: string) {
  const [orgRow] = await db
    .select({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1);
  return orgRow ?? null;
}

export function registerOrganizationRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for organization routes");
  }
  const secrets = opts.secrets;

  router.use("/organizations", createSessionMiddleware(secrets));
  router.use("/organizations/:id", createSessionMiddleware(secrets));
  router.use(
    "/organizations/:id/default-timezone",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/host-defaults",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/default-environment",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/server-capacity",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/managed-defaults",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/container-logs-settings",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/container-logs",
    createSessionMiddleware(secrets),
  );
  router.use("/timezones", createSessionMiddleware(secrets));
  registerOrganizationFabricRoutes(router, opts);

  router.get("/organizations", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const organizations = await listAccessibleOrganizations(db, session.userId);
    return c.json({ organizations });
  });

  router.post("/organizations", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedDisplayName = parseOrganizationCreateDisplayName(body);
    if (!parsedDisplayName.ok) {
      return c.json(
        { error: parsedDisplayName.error },
        parsedDisplayName.status,
      );
    }

    const { organizationId } = await createOrganizationForUser(
      db,
      session.userId,
      parsedDisplayName.name,
    );

    return c.json({ ok: true as const, id: organizationId });
  });

  router.get("/organizations/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const allowed = await canAccessOrganization(db, session.userId, id);
    if (!allowed) return c.json({ error: "Not found" }, 404);

    const orgRow = await loadOrganizationRecord(db, id);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    return c.json({ organization: toOrganizationRecord(orgRow) });
  });

  router.patch("/organizations/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseOrganizationPatchDisplayName(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const orgRow = await loadOrganizationRecord(db, id);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      name: parsed.name,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const updated = await loadOrganizationRecord(db, id);
    if (!updated) return c.json({ error: "Not found" }, 404);

    return c.json({
      ok: true as const,
      organization: toOrganizationRecord(updated),
    });
  });

  router.get("/organizations/:id/default-timezone", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(defaultTimezoneGetResponse(options));
  });

  router.put("/organizations/:id/default-timezone", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseDefaultTimezonePatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(defaultTimezonePutResponse(options));
  });

  router.get("/organizations/:id/host-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(hostDefaultsGetResponse(options));
  });

  router.put("/organizations/:id/host-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseHostDefaultsPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(hostDefaultsPutResponse(options));
  });

  /**
   * Container-log retention switch. Manage-gated: turning this on starts every
   * daemon in the org tailing its containers (via the presence ack) and starts
   * billing for the storage, so it is not a read-level setting.
   */
  router.get("/organizations/:id/container-logs-settings", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(containerLogSettingsGetResponse(options));
  });

  router.put("/organizations/:id/container-logs-settings", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseContainerLogSettingsPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(containerLogSettingsPutResponse(options));
  });

  /**
   * Read one newest-first page of container output.
   *
   * Read-gated through the repo's standard helper, not `canAccessOrganization`:
   * that one is true for any teammate of the organization, which would hand
   * container output — application logs, and whatever a container prints into
   * them — to every member. `assertCanReadOr403` is the same read contract the
   * rest of the client API uses (today it resolves to manage-level access).
   *
   * The organization comes from the **path** after the access check, never from
   * the query string: `parseContainerLogQueryParams` has no way to set it, so a
   * caller cannot widen a read past the org they were authorized for.
   */
  router.get("/organizations/:id/container-logs", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const denied = await assertCanReadOr403(c, "organization", id);
    if (denied) return denied;

    // `organization.options.containerLogsEnabled` is the authoritative
    // retention gate, and it is checked **before** the backend: an org that
    // never turned retention on has nothing stored no matter how healthy
    // ClickHouse/R2 SQL is, and reading it back would be a page of another
    // era's data at best. The runtime store is only backend availability.
    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);
    if (!resolveContainerLogsEnabled(parseOrganizationOptions(orgRow.options))) {
      return c.json({ error: "container_logs_disabled" }, 503);
    }

    const store = getContainerLogStore(c);
    // An empty page would be indistinguishable from "the operator never turned
    // this on" — say so explicitly instead.
    if (!store || isDisabledContainerLogStore(store)) {
      return c.json({ error: "container_logs_disabled" }, 503);
    }

    const parsed = parseContainerLogQueryParams(c.req.query(), id);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    try {
      const page = await store.query(parsed.query);
      return c.json(page);
    } catch (err) {
      // The Cloudflare backend is public beta: a transport/envelope failure is
      // an availability problem, not a bad request.
      if (err instanceof ContainerLogStoreUnavailableError) {
        return c.json({ error: "container_logs_unavailable" }, 503);
      }
      throw err;
    }
  });

  router.get("/organizations/:id/default-environment", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(defaultEnvironmentGetResponse(options));
  });

  router.put("/organizations/:id/default-environment", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseDefaultEnvironmentPutBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({
          defaultEnvironmentName: parsed.defaultEnvironmentName,
        })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(defaultEnvironmentPutResponse(options));
  });

  router.get("/organizations/:id/server-capacity", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const capacity = await loadOrgServerCapacity(db, id);
    if (!capacity) return c.json({ error: "Not found" }, 404);

    return c.json(capacity);
  });

  router.put("/organizations/:id/server-capacity", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertOrgOwnerOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseServerCapacityPutBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ maxServers: parsed.maxServers })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const capacity = await loadOrgServerCapacity(db, id);
    if (!capacity) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true as const, ...capacity });
  });

  router.get("/organizations/:id/managed-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(managedDefaultsGetResponse(options.managedDatabase ?? {}));
  });

  router.put("/organizations/:id/managed-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseManagedDefaultsPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    // Nested object: merge in app code, then write the whole `managedDatabase`
    // value — jsonb `||` is shallow and would drop sibling keys.
    const next = applyManagedDefaultsPatch(
      parseOrganizationOptions(orgRow.options).managedDatabase ?? {},
      parsedPatch.patch,
    );

    // Collisions only exist post-merge: one family's override can land on the
    // other family's still-inherited default.
    const invalid = validateManagedDefaults(next);
    if (invalid) return c.json({ error: invalid.error }, invalid.status);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ managedDatabase: next })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    return c.json(managedDefaultsPutResponse(next));
  });

  router.get("/timezones", (c) => {
    return c.json({ timezones: listTimezones() });
  });
}
