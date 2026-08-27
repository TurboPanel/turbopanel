/**
 * Host-free coverage for TLS route helpers and HTTP short-circuits.
 * Organization CA material stays in memory — never Platform CA paths.
 */

import { assertEquals } from "@std/assert";
import { getTableName } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from "../authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from "../authn/secrets.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import {
  buildTlsRowPatch,
  overlayRotationResults,
  registerTlsRoutes,
  rotationCommandsSucceeded,
  rotationNeedsCommands,
} from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TLS_ID = "33333333-3333-4333-8333-333333333333";
const ROTATION_ID = "44444444-4444-4444-8444-444444444444";
const SERVER_ID = "55555555-5555-4555-8555-555555555555";
const COMMAND_ID = "66666666-6666-4666-8666-666666666666";

const LIBRARY_METADATA = {
  dnsNames: ["app.example.com"],
  hasWildcard: false,
  notBefore: "2026-01-01T00:00:00.000Z",
  subject: "CN=app.example.com",
  issuer: "CN=app.example.com",
};

const LIBRARY_EXISTING = {
  options: { prefer: 1 },
  status: "ready",
  notAfter: "2099-01-01T00:00:00.000Z",
  fingerprintSha256: "a".repeat(64),
  metadata: LIBRARY_METADATA,
  source: "self_signed",
};

function tableName(value: unknown): string {
  try {
    return getTableName(value as never);
  } catch {
    return "";
  }
}

function thenableWhere(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const afterOrderBy = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: () => Promise.resolve(rows),
  };
  const afterWhere = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: () => Promise.resolve(rows),
    orderBy: () => afterOrderBy,
  };
  return {
    where: () => afterWhere,
    orderBy: () => Promise.resolve(rows),
  };
}

function organizationCaRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TLS_ID,
    name: "Organization CA",
    source: "organization_ca",
    organizationId: ORG_ID,
    status: "ready",
    notAfter: "2099-01-01T00:00:00.000Z",
    fingerprintSha256: "a".repeat(64),
    metadata: {
      dnsNames: [],
      hasWildcard: false,
      notBefore: "2026-01-01T00:00:00.000Z",
      subject: `O=TurboPanel, OU=Organization CA, CN=${ORG_ID}`,
      issuer: `O=TurboPanel, OU=Organization CA, CN=${ORG_ID}`,
    },
    options: null,
    certificatePem:
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    privateKeyPem: "tpsecret.v1.sealed",
    caState: "active",
    caGeneration: 1,
    ...overrides,
  };
}

function journalRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: ROTATION_ID,
    organizationId: ORG_ID,
    fromCaGeneration: 1,
    toCaGeneration: 2,
    state: "in_progress",
    startedAt: now,
    completedAt: null,
    results: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type TlsAppOptions = {
  tlsRows?: unknown[] | (() => unknown[]);
  rotationRows?: unknown[];
  executeRows?: unknown[] | ((phase: number) => unknown[]);
  encryption?: boolean;
  transaction?: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;
};

async function buildTlsApp(opts: TlsAppOptions = {}): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `tls-hostfree-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `tls-hostfree-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: ORG_ID, name: "TLS Hostfree Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  let executePhase = 0;
  const db = Object.assign(authDb, {
    execute: () => {
      executePhase += 1;
      if (typeof opts.executeRows === "function") {
        return Promise.resolve(opts.executeRows(executePhase));
      }
      return Promise.resolve(opts.executeRows ?? [{ allowed: true }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        if (name === "tls") {
          const rows = typeof opts.tlsRows === "function"
            ? opts.tlsRows()
            : (opts.tlsRows ?? []);
          return thenableWhere(rows);
        }
        if (name === "changeover") {
          return thenableWhere(opts.rotationRows ?? []);
        }
        if (name === "leaf") {
          return thenableWhere([{ dueCount: 0 }]);
        }
        return origSelect(fields).from(table);
      },
    }),
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  }) as unknown as Db;

  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", secretsConfig);
    if (opts.encryption !== false) {
      c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    }
    return next();
  });
  registerTlsRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
}

function authHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    ...extra,
  };
}

async function expectJson(
  response: Response,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  assertEquals(response.status, status);
  assertEquals(await response.json(), body);
}

async function expectForbidden(response: Response): Promise<void> {
  assertEquals(response.status, 403);
  const body = await response.json() as { error?: unknown };
  assertEquals(body.error, "Forbidden");
}

test("buildTlsRowPatch rejects invalid name and options", () => {
  const badName = buildTlsRowPatch({ name: 12 }, LIBRARY_EXISTING);
  assertEquals(badName, { ok: false, error: "Invalid request", status: 400 });

  const badOptions = buildTlsRowPatch({ prefer: "high" }, LIBRARY_EXISTING);
  assertEquals(badOptions, {
    ok: false,
    error: "Invalid request",
    status: 400,
  });
});

test("buildTlsRowPatch refuses to revoke an Organization CA", () => {
  const result = buildTlsRowPatch({ revoke: true }, {
    ...LIBRARY_EXISTING,
    source: "organization_ca",
  });
  assertEquals(result, {
    ok: false,
    error: "organization_ca_retire_required",
    status: 409,
  });
});

test("buildTlsRowPatch revokes a library cert and patches options", () => {
  const revoked = buildTlsRowPatch({ revoke: true }, LIBRARY_EXISTING);
  if (!revoked.ok) throw new TypeError("expected revoke patch");
  assertEquals(revoked.patch.status, "revoked");

  const options = buildTlsRowPatch({ prefer: 3, name: "Leaf" }, LIBRARY_EXISTING);
  if (!options.ok) throw new TypeError("expected options patch");
  assertEquals(options.patch.name, "Leaf");
  assertEquals(options.patch.options?.prefer, 3);
});

test("buildTlsRowPatch returns 500 when revoke metadata cannot assemble", () => {
  const result = buildTlsRowPatch({ revoke: true }, {
    options: null,
    status: "ready",
    notAfter: null,
    fingerprintSha256: null,
    metadata: "not-an-object",
    source: "upload",
  });
  assertEquals(result, { ok: false, error: "Invalid request", status: 500 });
});

test("overlayRotationResults prefers live command status", () => {
  const overlaid = overlayRotationResults(
    [
      {
        serverId: SERVER_ID,
        kind: "ingress",
        status: "queued",
        commandId: COMMAND_ID,
        error: undefined,
      },
      {
        serverId: SERVER_ID,
        kind: "binding",
        managedId: TLS_ID,
        status: "failed",
        error: "binding_ca_unavailable",
      },
    ],
    [{ id: COMMAND_ID, status: "succeeded", error: null }],
  );
  assertEquals(overlaid[0]?.status, "succeeded");
  assertEquals(overlaid[1]?.status, "failed");
  assertEquals(overlaid[1]?.error, "binding_ca_unavailable");
});

test("rotationCommandsSucceeded requires every tracked command", () => {
  assertEquals(
    rotationCommandsSucceeded(
      [{ serverId: SERVER_ID, kind: "apply", status: "queued" }],
      [],
    ),
    false,
  );
  assertEquals(
    rotationCommandsSucceeded(
      [{
        serverId: SERVER_ID,
        kind: "apply",
        status: "queued",
        commandId: COMMAND_ID,
      }],
      [{ id: COMMAND_ID, status: "queued" }],
    ),
    false,
  );
  assertEquals(
    rotationCommandsSucceeded(
      [{
        serverId: SERVER_ID,
        kind: "apply",
        status: "queued",
        commandId: COMMAND_ID,
      }],
      [{ id: COMMAND_ID, status: "succeeded" }],
    ),
    true,
  );
});

test("rotationNeedsCommands is true when apply or ingress targets exist", () => {
  assertEquals(
    rotationNeedsCommands({ managedIds: [], ingressServerIds: [] }),
    false,
  );
  assertEquals(
    rotationNeedsCommands({ managedIds: [TLS_ID], ingressServerIds: [] }),
    true,
  );
  assertEquals(
    rotationNeedsCommands({ managedIds: [], ingressServerIds: [SERVER_ID] }),
    true,
  );
});

test("registerTlsRoutes requires session secrets", () => {
  const app = new Hono<AppEnv>();
  let threw = false;
  try {
    registerTlsRoutes(app, {
      runtime: "deno",
      signupEnvOverride: undefined,
    });
  } catch (error) {
    threw = true;
    assertEquals(error instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

test("GET /tls returns 400 without an organization and [] when none are visible", async () => {
  const { app, cookie } = await buildTlsApp({ executeRows: [] });
  const missingOrg = await app.request("/tls", {
    headers: { Cookie: cookie },
  });
  await expectJson(missingOrg, 400, { error: "organizationId required" });

  const empty = await app.request("/tls", { headers: authHeaders(cookie) });
  await expectJson(empty, 200, { tls: [] });
});

test("GET /tls lists visible rows and drops unassemblable ones", async () => {
  const { app, cookie } = await buildTlsApp({
    executeRows: [{ item_id: TLS_ID, allowed: true }],
    tlsRows: [
      organizationCaRow({ source: "self_signed", caState: null }),
      organizationCaRow({
        id: "77777777-7777-4777-8777-777777777777",
        metadata: "not-an-object",
        notAfter: null,
        fingerprintSha256: null,
      }),
    ],
  });
  const res = await app.request("/tls", { headers: authHeaders(cookie) });
  assertEquals(res.status, 200);
  const body = await res.json() as { tls: Array<{ id: string }> };
  assertEquals(body.tls.length, 1);
  assertEquals(body.tls[0]?.id, TLS_ID);
});

test("GET /tls/ca returns 503 when encryption is missing and 403 when create is denied", async () => {
  const noKey = await buildTlsApp({ encryption: false, tlsRows: [] });
  const missing = await noKey.app.request("/tls/ca", {
    headers: authHeaders(noKey.cookie),
  });
  await expectJson(missing, 503, {
    error: "Encryption unavailable — no encryption key configured",
  });

  const deniedCreate = await buildTlsApp({
    tlsRows: [],
    executeRows: [{ allowed: false }],
  });
  const forbiddenCreate = await deniedCreate.app.request("/tls/ca", {
    headers: authHeaders(deniedCreate.cookie),
  });
  await expectJson(forbiddenCreate, 403, { error: "Forbidden" });

  const deniedRead = await buildTlsApp({
    tlsRows: [organizationCaRow()],
    executeRows: [{ allowed: false }],
  });
  const forbiddenRead = await deniedRead.app.request("/tls/ca", {
    headers: authHeaders(deniedRead.cookie),
  });
  await expectJson(forbiddenRead, 403, { error: "Forbidden" });
});

test("GET /tls/ca returns 500 when the active Organization CA cannot be published", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [organizationCaRow({
      metadata: "not-an-object",
      notAfter: null,
      fingerprintSha256: null,
    })],
  });
  const res = await app.request("/tls/ca", { headers: authHeaders(cookie) });
  await expectJson(res, 500, { error: "Invalid request" });
});

test("GET /tls/ca unique-violation reuse returns the raced Organization CA", async () => {
  let tlsSelects = 0;
  const { app, cookie } = await buildTlsApp({
    tlsRows: () => {
      tlsSelects += 1;
      return tlsSelects === 1 ? [] : [organizationCaRow()];
    },
    transaction: () =>
      Promise.reject(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uniq_tls_organization_active_ca"',
          ),
          { code: "23505" },
        ),
      ),
  });
  const res = await app.request("/tls/ca", { headers: authHeaders(cookie) });
  assertEquals(res.status, 200);
  const body = await res.json() as { tls: { id: string; source: string } };
  assertEquals(body.tls.id, TLS_ID);
  assertEquals(body.tls.source, "organization_ca");
});

test("GET /tls/ca unique-violation without a raced row is 409", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [],
    transaction: () =>
      Promise.reject(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uniq_tls_organization_fingerprint_sha256"',
          ),
          { code: "23505" },
        ),
      ),
  });
  const res = await app.request("/tls/ca", { headers: authHeaders(cookie) });
  await expectJson(res, 409, { error: "organization_ca_exists" });
});

test("GET /tls/ca returns 404 when ensure inserted but the signer vanished", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [],
    transaction: () => Promise.resolve(TLS_ID),
  });
  const res = await app.request("/tls/ca", { headers: authHeaders(cookie) });
  await expectJson(res, 404, { error: "Not found" });
});

test("GET /tls/ca/download returns 404 or 403 without a readable bundle", async () => {
  const missing = await buildTlsApp({ tlsRows: [] });
  const notFound = await missing.app.request("/tls/ca/download", {
    headers: authHeaders(missing.cookie),
  });
  await expectJson(notFound, 404, { error: "Not found" });

  const denied = await buildTlsApp({
    tlsRows: [organizationCaRow()],
    executeRows: [{ allowed: false }],
  });
  const forbidden = await denied.app.request("/tls/ca/download", {
    headers: authHeaders(denied.cookie),
  });
  await expectJson(forbidden, 403, { error: "Forbidden" });
});

test("GET /tls/:id hides foreign or unreadable rows", async () => {
  const missing = await buildTlsApp({ tlsRows: [] });
  const notFound = await missing.app.request(`/tls/${TLS_ID}`, {
    headers: authHeaders(missing.cookie),
  });
  await expectJson(notFound, 404, { error: "Not found" });

  const foreign = await buildTlsApp({
    tlsRows: [organizationCaRow({ organizationId: OTHER_ORG })],
  });
  const hidden = await foreign.app.request(`/tls/${TLS_ID}`, {
    headers: authHeaders(foreign.cookie),
  });
  await expectJson(hidden, 404, { error: "Not found" });

  const denied = await buildTlsApp({
    tlsRows: [organizationCaRow()],
    executeRows: [{ allowed: false }],
  });
  const forbidden = await denied.app.request(`/tls/${TLS_ID}`, {
    headers: authHeaders(denied.cookie),
  });
  await expectJson(forbidden, 403, { error: "Forbidden" });
});

test("GET /tls/:id returns 500 when the stored row cannot be published", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [organizationCaRow({
      metadata: "not-an-object",
      notAfter: null,
      fingerprintSha256: null,
    })],
  });
  const res = await app.request(`/tls/${TLS_ID}`, {
    headers: authHeaders(cookie),
  });
  await expectJson(res, 500, { error: "Invalid request" });
});

test("POST /tls rejects invalid source, name, and missing encryption", async () => {
  const { app, cookie } = await buildTlsApp();
  const json = { "content-type": "application/json" };
  const denied = await buildTlsApp({ executeRows: [{ allowed: false }] });
  const forbidden = await denied.app.request("/tls", {
    method: "POST",
    headers: authHeaders(denied.cookie, json),
    body: JSON.stringify({ source: "lets_encrypt" }),
  });
  await expectJson(forbidden, 403, { error: "Forbidden" });

  const badJson = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, json),
    body: "{",
  });
  await expectJson(badJson, 400, { error: "Invalid request" });

  const badSource = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ source: "acme" }),
  });
  await expectJson(badSource, 400, { error: "Invalid request" });

  const badName = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ source: "lets_encrypt", name: 1 }),
  });
  await expectJson(badName, 400, { error: "Invalid request" });

  const noKey = await buildTlsApp({ encryption: false });
  const missing = await noKey.app.request("/tls", {
    method: "POST",
    headers: authHeaders(noKey.cookie, json),
    body: JSON.stringify({
      source: "lets_encrypt",
      hostnames: ["le.example.com"],
    }),
  });
  await expectJson(missing, 503, {
    error: "Encryption unavailable — no encryption key configured",
  });
});

test("POST /tls returns create-material failures and insert conflicts", async () => {
  const { app, cookie } = await buildTlsApp({
    transaction: () =>
      Promise.reject(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uniq_tls_organization_fingerprint_sha256"',
          ),
          { code: "23505" },
        ),
      ),
  });
  const json = { "content-type": "application/json" };
  const material = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ source: "upload" }),
  });
  await expectJson(material, 400, { error: "Invalid request" });

  const conflict = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({
      source: "lets_encrypt",
      hostnames: ["dup.example.com"],
    }),
  });
  await expectJson(conflict, 409, { error: "tls_fingerprint_conflict" });
});

test("POST /tls organization_ca returns 409 when an active signer already exists", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [organizationCaRow()],
  });
  const res = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ source: "organization_ca" }),
  });
  await expectJson(res, 409, { error: "organization_ca_exists" });
});

test("POST /tls organization_ca races the in-transaction unique row", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [],
    transaction: async (fn) =>
      fn({
        select: () => ({
          from: () => thenableWhere([organizationCaRow()]),
        }),
      } as unknown as Db),
  });
  const res = await app.request("/tls", {
    method: "POST",
    headers: authHeaders(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ source: "organization_ca" }),
  });
  await expectJson(res, 409, { error: "organization_ca_exists" });
});

test("POST /tls rethrows non-conflict insert errors", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [],
    transaction: () => Promise.reject(new TypeError("insert boom")),
  });
  let caught: unknown;
  try {
    const res = await app.request("/tls", {
      method: "POST",
      headers: authHeaders(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({
        source: "lets_encrypt",
        hostnames: ["boom.example.com"],
      }),
    });
    assertEquals(res.status >= 500, true);
  } catch (error) {
    caught = error;
  }
  if (caught !== undefined) {
    assertEquals(caught instanceof TypeError, true);
  }
});

test("PATCH /tls/:id covers revoke, invalid patches, and missing rows", async () => {
  const json = { "content-type": "application/json" };
  const missing = await buildTlsApp({ tlsRows: [] });
  const notFound = await missing.app.request(`/tls/${TLS_ID}`, {
    method: "PATCH",
    headers: authHeaders(missing.cookie, json),
    body: JSON.stringify({ prefer: 2 }),
  });
  await expectJson(notFound, 404, { error: "Not found" });

  const existing = {
    ...organizationCaRow({ source: "self_signed" }),
    ...LIBRARY_EXISTING,
  };
  const { app, cookie } = await buildTlsApp({ tlsRows: [existing] });

  const badName = await app.request(`/tls/${TLS_ID}`, {
    method: "PATCH",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ name: 1 }),
  });
  await expectJson(badName, 400, { error: "Invalid request" });

  const badOptions = await app.request(`/tls/${TLS_ID}`, {
    method: "PATCH",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ prefer: "nope" }),
  });
  await expectJson(badOptions, 400, { error: "Invalid request" });

  const revoked = await app.request(`/tls/${TLS_ID}`, {
    method: "PATCH",
    headers: authHeaders(cookie, json),
    body: JSON.stringify({ revoke: true }),
  });
  await expectJson(revoked, 200, { ok: true });

  const orgCa = await buildTlsApp({
    tlsRows: [organizationCaRow()],
  });
  const refuse = await orgCa.app.request(`/tls/${TLS_ID}`, {
    method: "PATCH",
    headers: authHeaders(orgCa.cookie, json),
    body: JSON.stringify({ revoke: true }),
  });
  await expectJson(refuse, 409, { error: "organization_ca_retire_required" });
});

test("DELETE /tls/:id covers uuid, not-found, children, and success", async () => {
  const { app, cookie } = await buildTlsApp({
    tlsRows: [organizationCaRow({ source: "upload" })],
  });
  const badId = await app.request("/tls/not-a-uuid", {
    method: "DELETE",
    headers: authHeaders(cookie),
  });
  await expectJson(badId, 404, { error: "Not found" });

  const missing = await buildTlsApp({ tlsRows: [] });
  const notFound = await missing.app.request(`/tls/${TLS_ID}`, {
    method: "DELETE",
    headers: authHeaders(missing.cookie),
  });
  await expectJson(notFound, 404, { error: "Not found" });

  const denied = await buildTlsApp({
    tlsRows: [organizationCaRow({ source: "upload" })],
    executeRows: [{ allowed: false }],
  });
  const forbidden = await denied.app.request(`/tls/${TLS_ID}`, {
    method: "DELETE",
    headers: authHeaders(denied.cookie),
  });
  await expectForbidden(forbidden);

  const children = await buildTlsApp({
    tlsRows: [organizationCaRow({ source: "upload" })],
    transaction: () =>
      Promise.reject(Object.assign(new Error("fk"), { code: "23503" })),
  });
  const blocked = await children.app.request(`/tls/${TLS_ID}`, {
    method: "DELETE",
    headers: authHeaders(children.cookie),
  });
  assertEquals(blocked.status, 409);

  const ok = await app.request(`/tls/${TLS_ID}`, {
    method: "DELETE",
    headers: authHeaders(cookie),
  });
  await expectJson(ok, 200, { ok: true });
});

test("POST /tls/ca/rotate returns 503 without encryption and 404 when the minted CA vanished", async () => {
  const noKey = await buildTlsApp({ encryption: false });
  const missing = await noKey.app.request("/tls/ca/rotate", {
    method: "POST",
    headers: authHeaders(noKey.cookie),
  });
  await expectJson(missing, 503, {
    error: "Encryption unavailable — no encryption key configured",
  });

  const vanished = await buildTlsApp({
    tlsRows: [],
    rotationRows: [journalRow()],
  });
  const notFound = await vanished.app.request("/tls/ca/rotate", {
    method: "POST",
    headers: authHeaders(vanished.cookie),
  });
  await expectJson(notFound, 404, { error: "Not found" });
});

test("GET /tls/ca/rotation and POST /tls/ca/retire cover missing journals", async () => {
  const { app, cookie } = await buildTlsApp({ rotationRows: [] });
  const missing = await app.request("/tls/ca/rotation", {
    headers: authHeaders(cookie),
  });
  await expectJson(missing, 404, { error: "Not found" });

  const retire = await app.request("/tls/ca/retire", {
    method: "POST",
    headers: authHeaders(cookie),
  });
  await expectJson(retire, 409, { error: "no_pending_rotation" });

  const blocked = await buildTlsApp({
    rotationRows: [journalRow({ state: "awaiting_retire" })],
  });
  const inFlight = await blocked.app.request("/tls/ca/rotate", {
    method: "POST",
    headers: authHeaders(blocked.cookie),
  });
  await expectJson(inFlight, 409, { error: "ca_rotation_in_progress" });

  const status = await blocked.app.request("/tls/ca/rotation", {
    headers: authHeaders(blocked.cookie),
  });
  await expectJson(status, 200, {
    rotationId: ROTATION_ID,
    fromGeneration: 1,
    toGeneration: 2,
    state: "awaiting_retire",
    results: [],
    retiredCaStillRequired: true,
  });

  const notConverged = await buildTlsApp({
    rotationRows: [
      journalRow({
        state: "awaiting_retire",
        results: [{
          serverId: SERVER_ID,
          kind: "ingress",
          status: "queued",
        }],
      }),
    ],
  });
  const waiting = await notConverged.app.request("/tls/ca/retire", {
    method: "POST",
    headers: authHeaders(notConverged.cookie),
  });
  await expectJson(waiting, 409, { error: "ca_rotation_not_converged" });

  const denied = await buildTlsApp({
    rotationRows: [journalRow({ state: "awaiting_retire" })],
    executeRows: [{ allowed: false }],
  });
  const forbiddenRotate = await denied.app.request("/tls/ca/rotate", {
    method: "POST",
    headers: authHeaders(denied.cookie),
  });
  await expectForbidden(forbiddenRotate);
  const forbiddenRetire = await denied.app.request("/tls/ca/retire", {
    method: "POST",
    headers: authHeaders(denied.cookie),
  });
  await expectForbidden(forbiddenRetire);
  const forbiddenStatus = await denied.app.request("/tls/ca/rotation", {
    headers: authHeaders(denied.cookie),
  });
  await expectForbidden(forbiddenStatus);
});
