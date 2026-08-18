import type { Context } from "hono";
import { getDb } from "../db.ts";
import {
  isValidDescription,
  isValidDisplayName,
  normalizeDisplayName,
} from "../lib/display-name-format.ts";
import { can } from "./authz/index.ts";
import { resolveOrgId } from "./org-context.ts";

export {
  assertNotSystemOwnedOr403,
  SYSTEM_RESOURCE_IMMUTABLE_ERROR,
} from "./authz/http.ts";

export class BadRequestError extends Error {}

export async function getOrgId(
  c: Context,
  userId: string,
): Promise<string | Response> {
  return resolveOrgId(c, userId);
}

/**
 * Prefer `displayName` (OpenAPI / client UI); fall back to legacy `name`.
 */
function pickDisplayNameRaw(body: Record<string, unknown>): unknown {
  if (body.displayName !== undefined) {
    return body.displayName;
  }
  if (body.name !== undefined) {
    return body.name;
  }
  return undefined;
}

/**
 * Parse resource name from the wire body.
 *
 * Prefer `displayName` (OpenAPI / client UI). Accept legacy `name` for older
 * callers and tests. (`parseDisplayName` is the historical export name.)
 */
export function parseDisplayName(body: Record<string, unknown>): string | null {
  const raw = pickDisplayNameRaw(body);
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new BadRequestError("Invalid request");
  }
  const name = normalizeDisplayName(raw);
  if (!isValidDisplayName(name)) {
    throw new BadRequestError("Invalid request");
  }
  return name;
}

export function parseDescription(body: Record<string, unknown>): string | null {
  if (body.description === undefined) {
    return null;
  }
  if (typeof body.description !== "string") {
    throw new BadRequestError("Invalid request");
  }
  const description = normalizeDisplayName(body.description);
  if (!isValidDescription(description)) {
    throw new BadRequestError("Invalid request");
  }
  return description.length === 0 ? null : description;
}

export function parseJsonbObject(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null | Response {
  if (body[field] === undefined) {
    return null;
  }
  const value = body[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return c.json({ error: "Invalid request" }, 400);
  }
  return value as Record<string, unknown>;
}

/**
 * Drop column-promoted keys from inbound metadata before JSONB persist.
 * Callers still extract those keys onto real columns; responses may re-synthesize
 * them for API compatibility.
 */
export function stripPromotedMetadataKeys(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

/** PATCH payload: omit `name` when absent so partial updates do not clear it. */
export function buildPatchUpdateFields(
  body: Record<string, unknown>,
): { name?: string | null; description?: string | null; updatedAt: string } {
  const updatedAt = new Date().toISOString();
  const result: {
    name?: string | null;
    description?: string | null;
    updatedAt: string;
  } = { updatedAt };

  const rawName = pickDisplayNameRaw(body);
  if (rawName !== undefined) {
    if (typeof rawName !== "string") {
      throw new BadRequestError("Invalid request");
    }
    const name = normalizeDisplayName(rawName);
    if (!isValidDisplayName(name)) {
      throw new BadRequestError("Invalid request");
    }
    result.name = name;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new BadRequestError("Invalid request");
    }
    const description = normalizeDisplayName(body.description);
    if (!isValidDescription(description)) {
      throw new BadRequestError("Invalid request");
    }
    result.description = description.length === 0 ? null : description;
  }

  return result;
}

/**
 * Manage access: org owners/managers and platform admins may manage entities in
 * the org. This is the canonical broad (owner-or-manager) org-access check — it
 * uses `organization:manage`, which the evaluator satisfies for either an owner
 * or a manager grant. Do NOT use `organization:own` for broad access: after the
 * evaluator was tightened, `organization:own` is an exact owner-only check.
 */
export async function assertCanManageOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c);
  if (!db) return c.json({ error: "Database unavailable" }, 503);

  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const allowed = await can(
    db,
    session.userId,
    "organization:manage",
    kind,
    entityId,
  );

  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null;
}

/**
 * Read access: org owners/managers and platform admins may read any entity in
 * the org. There is no lower "viewer" grant, so read access currently maps to
 * manage-level access. Delegates to {@link assertCanManageOr403} so the broad
 * org-access check stays in one place.
 */
export async function assertCanReadOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  return assertCanManageOr403(c, kind, entityId);
}

/**
 * Create access: org owners/managers and platform admins may create under the
 * parent scope. This is a broad (owner-or-manager) org-access check; it
 * delegates to {@link assertCanManageOr403}. Do NOT use `organization:own`
 * here — that is now an exact owner-only check.
 */
export async function assertCanCreateOr403(
  c: Context,
  parentKind: string,
  parentId: string,
): Promise<Response | null> {
  return assertCanManageOr403(c, parentKind, parentId);
}

export async function parseJsonBody(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  const rawBody = await c.req.text().catch(() => "");
  if (!rawBody.trim()) {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request" }, 400);
  }
  return body as Record<string, unknown>;
}

export function requireStringField(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): string | Response {
  const value = body[field];
  if (typeof value !== "string" || !value) {
    return c.json({ error: "Invalid request" }, 400);
  }
  return value;
}
