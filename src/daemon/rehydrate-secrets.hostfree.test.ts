/**
 * Host-free coverage for daemon deployment secret rehydrate (no Postgres).
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { Context } from "hono";
import {
  encryptSecret,
  encryptSecretForDaemon,
  ENVELOPE_PREFIX_DAEMON,
} from "../client/authn/data-encryption.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
  type SecretsConfig,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import type { ServerDaemonState } from "./authn/daemon-state.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";
import {
  buildDeploymentSecretsRehydrate,
  parseRehydrateRequestBody,
} from "./rehydrate-secrets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_ID = "00000000-0000-4000-8000-0000000000b1";
const PROJECT_ID = "00000000-0000-4000-8000-0000000000p1";
const ENV_ID = "00000000-0000-4000-8000-0000000000e1";
const KEY_ID = "key-1";

const activeDaemon: ServerDaemonState = {
  key: {
    id: KEY_ID,
    algorithm: "Ed25519",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
    fingerprint: "fp-test",
    createdAt: "2020-01-01T00:00:00.000Z",
    revokedAt: null,
  },
};

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function secretPlanEntry(
  key: string,
  composeServiceName = "web",
): Record<string, unknown> {
  return {
    key,
    composeServiceName,
    source: key,
    target: key,
    relativePath: key,
    forBuild: false,
    forRuntime: true,
  };
}

type CtxBag = {
  dataEncryptionSecrets?: unknown;
  secretsConfig?: SecretsConfig;
  daemonServerId?: string;
};

function makeContext(vars: CtxBag): Context {
  const store = new Map<string, unknown>(Object.entries(vars));
  return {
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as unknown as Context;
}

/**
 * Ordered select pages for rehydrate:
 * 1) daemon identity (server)
 * 2) environment
 * 3) deployment
 * then per secret-plan service lookup + optional variable loads
 */
function rehydrateDb(pages: unknown[][]): Db {
  let n = 0;
  return {
    select: () => {
      const rows = pages[n] ?? [];
      n += 1;
      const whereResult = thenableRows(rows);
      const joinLeaf = {
        innerJoin: () => joinLeaf,
        where: () => whereResult,
      };
      return {
        from: () => joinLeaf,
      };
    },
  } as unknown as Db;
}

async function encryptionFixtures() {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  return { secretsConfig, dataEncryptionSecrets };
}

function daemonIdentityRow(daemon: ServerDaemonState | null = activeDaemon) {
  return {
    daemon,
    metadata: null,
    hostname: "host-1",
    machineKey: null,
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  };
}

test("parseRehydrateRequestBody requires deployments array", () => {
  assertThrows(
    () => parseRehydrateRequestBody({}),
    TypeError,
    "deployments must be an array",
  );
});

test("parseRehydrateRequestBody keeps valid entries and drops junk", () => {
  const parsed = parseRehydrateRequestBody({
    deployments: [
      { projectId: "p1", environmentId: "e1", generation: 3 },
      { projectId: "p2" },
      "nope",
      { projectId: "p3", environmentId: "e3" },
      { projectId: "p4", environmentId: "e4", generation: Number.NaN },
    ],
  });
  assertEquals(parsed, [
    { projectId: "p1", environmentId: "e1", generation: 3 },
    { projectId: "p3", environmentId: "e3" },
    { projectId: "p4", environmentId: "e4" },
  ]);
});

test("buildDeploymentSecretsRehydrate returns 503 without encryption", async () => {
  const c = makeContext({ daemonServerId: SERVER_ID });
  const result = await buildDeploymentSecretsRehydrate(c, rehydrateDb([]), {
    deployments: [],
  });
  if (!(result instanceof Response)) {
    throw new TypeError("expected Response");
  }
  assertEquals(result.status, 503);
  assertEquals(await result.json(), {
    ok: false,
    error: "encryption unavailable",
  });
});

test("buildDeploymentSecretsRehydrate returns 422 without active daemon key", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const result = await buildDeploymentSecretsRehydrate(
    c,
    rehydrateDb([[]]),
    { deployments: [] },
  );
  if (!(result instanceof Response)) {
    throw new TypeError("expected Response");
  }
  assertEquals(result.status, 422);
  assertEquals(await result.json(), {
    ok: false,
    error: "No encryption-capable daemon key",
  });
});

test("buildDeploymentSecretsRehydrate returns 400 for invalid body", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const result = await buildDeploymentSecretsRehydrate(
    c,
    rehydrateDb([[daemonIdentityRow()]]),
    { notDeployments: true },
  );
  if (!(result instanceof Response)) {
    throw new TypeError("expected Response");
  }
  assertEquals(result.status, 400);
  assertEquals(await result.json(), { ok: false, error: "invalid body" });
});

test("buildDeploymentSecretsRehydrate skips mismatched env / missing deployment", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: "other-project" }],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [],
  ]);
  const result = await buildDeploymentSecretsRehydrate(c, db, {
    deployments: [
      { projectId: PROJECT_ID, environmentId: ENV_ID },
      { projectId: PROJECT_ID, environmentId: ENV_ID },
    ],
  });
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});

test("buildDeploymentSecretsRehydrate seals server-scoped secrets via full path", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const sealed = await encryptSecret(dataEncryptionSecrets, "sealed-value");
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 7,
      options: {
        secretPlan: [
          secretPlanEntry("DB_PASS"),
          secretPlanEntry("NOT_SECRET"),
          secretPlanEntry("MISSING"),
        ],
      },
    }],
    // service lookup for DB_PASS → missing → server vars
    [],
    [
      {
        key: "DB_PASS",
        value: sealed,
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      },
      {
        key: "NOT_SECRET",
        value: "visible",
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      },
    ],
    // service lookup for PLAIN_SECRET (new compose name? same web — cached map)
    // Actually maps cache by composeServiceName, so only one service resolve.
  ]);

  const result = await buildDeploymentSecretsRehydrate(c, db, {
    deployments: [{
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      generation: 7,
    }],
  });
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments.length, 1);
  const row = result.deployments[0]!;
  assertEquals(row.projectId, PROJECT_ID);
  assertEquals(row.environmentId, ENV_ID);
  assertEquals(row.generation, 7);
  assertEquals(row.secretPlan.length, 3);
  assertEquals(row.variableMaterial.length, 1);
  assertEquals(row.variableMaterial[0]?.key, "DB_PASS");
  assertEquals(
    row.variableMaterial[0]?.valueEnvelope.startsWith(ENVELOPE_PREFIX_DAEMON),
    true,
  );
  assertEquals(row.variableMaterial[0]?.composeServiceName, "web");
  assertEquals(row.variableMaterial[0]?.isLiteral, false);
});

test("buildDeploymentSecretsRehydrate resolves via service inheritance chain", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const sealed = await encryptSecret(dataEncryptionSecrets, "from-service");
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 1,
      options: {
        secretPlan: [secretPlanEntry("API_KEY", "api")],
      },
    }],
    // service found
    [{ id: "svc-api" }],
    // resolveInheritedVariableBundleForService chain join
    [{
      organizationId: "org",
      workspaceId: "ws",
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
    }],
    // org vars
    [],
    // workspace vars
    [],
    // project vars
    [],
    // environment vars
    [],
    // service vars
    [{
      key: "API_KEY",
      value: sealed,
      isSecret: true,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    }],
    // mergeHostingVariablesForService — hosting ids
    [],
    // reapplyBindingOwnedVariables
    [],
    // resolveServerScopedVariables
    [],
  ]);

  const result = await buildDeploymentSecretsRehydrate(c, db, {
    deployments: [{ projectId: PROJECT_ID, environmentId: ENV_ID }],
  });
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments[0]?.variableMaterial.length, 1);
  assertEquals(result.deployments[0]?.variableMaterial[0]?.key, "API_KEY");
  assertEquals(
    result.deployments[0]?.variableMaterial[0]?.valueEnvelope.startsWith(
      ENVELOPE_PREFIX_DAEMON,
    ),
    true,
  );
});

test("buildDeploymentSecretsRehydrate tolerates invalid secretPlan options", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 2,
      options: { secretPlan: "not-an-array" },
    }],
    // second deploy: non-object options
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 3,
      options: null,
    }],
  ]);
  const result = await buildDeploymentSecretsRehydrate(c, db, {
    deployments: [
      { projectId: PROJECT_ID, environmentId: ENV_ID },
      { projectId: PROJECT_ID, environmentId: ENV_ID },
    ],
  });
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments.length, 2);
  assertEquals(result.deployments[0]?.secretPlan, []);
  assertEquals(result.deployments[0]?.variableMaterial, []);
  assertEquals(result.deployments[1]?.secretPlan, []);
  assertEquals(result.deployments[1]?.generation, 3);
});

async function rehydrateWithSecretValue(
  value: string,
  generation?: number,
): Promise<
  | { deployments: { generation: number; variableMaterial: unknown[] }[] }
  | Response
> {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 7,
      options: {
        secretPlan: [secretPlanEntry("DB_PASS")],
      },
    }],
    [],
    [{
      key: "DB_PASS",
      value,
      isSecret: true,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    }],
  ]);
  return buildDeploymentSecretsRehydrate(c, db, {
    deployments: [{
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      ...(generation === undefined ? {} : { generation }),
    }],
  });
}

test("buildDeploymentSecretsRehydrate omits deployment when requested generation differs", async () => {
  const { dataEncryptionSecrets } = await encryptionFixtures();
  const sealed = await encryptSecret(dataEncryptionSecrets, "sealed-value");
  const result = await rehydrateWithSecretValue(sealed, 3);
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});

test("buildDeploymentSecretsRehydrate omits deployment for plaintext secret rows", async () => {
  const result = await rehydrateWithSecretValue("plain-secret");
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});

test("buildDeploymentSecretsRehydrate omits deployment for malformed tpsecret rows", async () => {
  const result = await rehydrateWithSecretValue("tpsecret.not-a-version.abcde");
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});

test("buildDeploymentSecretsRehydrate omits deployment for unexpected tpdaemon rows", async () => {
  const { secretsConfig } = await encryptionFixtures();
  const daemonEnvelope = await encryptSecretForDaemon(
    secretsConfig,
    { serverId: SERVER_ID, keyId: KEY_ID },
    "daemon-bound",
  );
  const result = await rehydrateWithSecretValue(daemonEnvelope);
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});

test("buildDeploymentSecretsRehydrate omits whole deployment when any secret row is plaintext", async () => {
  const { secretsConfig, dataEncryptionSecrets } = await encryptionFixtures();
  const sealed = await encryptSecret(dataEncryptionSecrets, "sealed-value");
  const c = makeContext({
    dataEncryptionSecrets,
    secretsConfig,
    daemonServerId: SERVER_ID,
  });
  const db = rehydrateDb([
    [daemonIdentityRow()],
    [{ id: ENV_ID, projectId: PROJECT_ID }],
    [{
      environmentId: ENV_ID,
      serverId: SERVER_ID,
      desiredGeneration: 7,
      options: {
        secretPlan: [
          secretPlanEntry("DB_PASS"),
          secretPlanEntry("PLAIN_SECRET"),
        ],
      },
    }],
    [],
    [
      {
        key: "DB_PASS",
        value: sealed,
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      },
      {
        key: "PLAIN_SECRET",
        value: "plain-secret",
        isSecret: true,
        isLiteral: true,
        forBuild: true,
        forRuntime: false,
      },
    ],
  ]);
  const result = await buildDeploymentSecretsRehydrate(c, db, {
    deployments: [{ projectId: PROJECT_ID, environmentId: ENV_ID }],
  });
  if (result instanceof Response) {
    throw new TypeError("expected deployments payload");
  }
  assertEquals(result.deployments, []);
});
