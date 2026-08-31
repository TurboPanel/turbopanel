/**
 * Host-free coverage for Git-backed deploy source attach/prepare.
 */

import { assertEquals } from "@std/assert";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  encryptSecret,
  encryptSecretForDaemon,
  isDaemonSealedEnvelope,
} from "../authn/data-encryption.ts";
import {
  deriveEncryptionSecretsConfig,
} from "../authn/secrets.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import type { EnvironmentDeployPrincipalMaterial } from "../../lib/commands/schemas.ts";
import {
  commitSubject,
  createReleaseIdAllocator,
  isSshCloneUrl,
  parseGithubRepositoryPath,
  requestedCommitShaForSource,
  resolveDeploySourceMaterial,
} from "./deploy-sources.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SHA = "a".repeat(40);
const SOURCE_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-0000000000c2";
const SERVICE_ID = "00000000-0000-4000-8000-0000000000a1";
const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000b1";
const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000d1";
const SERVER_ID = "00000000-0000-4000-8000-0000000000e1";
const KEY_ID = "00000000-0000-4000-8000-0000000000f1";

/**
 * Drizzle-shaped double: every builder method returns the same chain, and each
 * `await` consumes the next queued result set (queries run in call order).
 */
function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets];
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const promise = Promise.resolve(queue.shift() ?? []);
          return promise.then.bind(promise);
        }
        if (prop === "catch" || prop === "finally") return undefined;
        return () => chain;
      },
    },
  );
  return chain as Db;
}

function mockContext(
  vars: Record<string, unknown> = {},
): Context<AppEnv> {
  return {
    get: (key: string) => vars[key],
  } as unknown as Context<AppEnv>;
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    provider: "git",
    repositoryUrl: "https://example.com/org/app.git",
    defaultBranch: "main",
    subdirectory: null,
    connectionId: null,
    secretId: null,
    ...overrides,
  };
}

function sourcedService(
  extras: Record<string, unknown> = {},
  name = "web",
): Record<string, unknown> {
  return {
    [name]: {
      image: "nginx:1",
      "x-turbopanel": {
        source: { sourceId: SOURCE_ID, ...extras },
      },
    },
  };
}

function baseParams(
  overrides: Partial<Parameters<typeof resolveDeploySourceMaterial>[2]> = {},
) {
  return {
    mode: "preview" as const,
    organizationId: "org-1",
    environmentId: "env-1",
    serverId: SERVER_ID,
    services: sourcedService(),
    serviceRows: [{ id: SERVICE_ID, composeServiceName: "web" }],
    principalMaterial: [] as EnvironmentDeployPrincipalMaterial[],
    ...overrides,
  };
}

function daemonStateRow(revokedAt: string | null = null) {
  return {
    daemon: {
      key: {
        id: KEY_ID,
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "dGVzdGtleQ" },
        fingerprint: "fp-1",
        createdAt: "2020-01-01T00:00:00.000Z",
        revokedAt,
      },
    },
    metadata: {},
    hostname: "host",
    machineKey: "mk",
    connected: true,
    statusChangedAt: "2020-01-01T00:00:00.000Z",
  };
}

test("a webhook SHA pins only the source that produced it", () => {
  const selection = {
    ref: "refs/heads/main",
    commitSha: SHA,
    sourceId: "src-1",
  };
  assertEquals(requestedCommitShaForSource(selection, "src-1"), SHA);
  // The other repository bound in the same environment resolves from its own
  // declared/default ref — this commit does not exist there.
  assertEquals(requestedCommitShaForSource(selection, "src-2"), undefined);
});

test("a SHA with no source identity pins nothing", () => {
  assertEquals(
    requestedCommitShaForSource(
      { ref: null, commitSha: SHA, sourceId: null },
      "src-1",
    ),
    undefined,
  );
  assertEquals(
    requestedCommitShaForSource({ ref: null, commitSha: SHA }, "src-1"),
    undefined,
  );
});

test("no selection and no SHA pin nothing", () => {
  assertEquals(requestedCommitShaForSource(undefined, "src-1"), undefined);
  assertEquals(
    requestedCommitShaForSource(
      { ref: "main", commitSha: null, sourceId: "src-1" },
      "src-1",
    ),
    undefined,
  );
});

test("isSshCloneUrl separates the SSH transport from https", () => {
  assertEquals(isSshCloneUrl("ssh://git@example.com/owner/repo.git"), true);
  assertEquals(isSshCloneUrl("git@example.com:owner/repo.git"), true);
  assertEquals(isSshCloneUrl("https://example.com/owner/repo.git"), false);
});

test("parseGithubRepositoryPath reads both URL forms", () => {
  assertEquals(parseGithubRepositoryPath("https://github.com/o/r.git"), {
    owner: "o",
    repo: "r",
  });
  assertEquals(parseGithubRepositoryPath("git@github.com:o/r.git"), {
    owner: "o",
    repo: "r",
  });
  assertEquals(parseGithubRepositoryPath("https://github.com/o"), null);
});

test("commitSubject keeps the first line and drops a non-string", () => {
  assertEquals(commitSubject("feat: ship\n\nlonger body"), "feat: ship");
  assertEquals(commitSubject(12), undefined);
});

test("createReleaseIdAllocator mints once per compose service", () => {
  const allocator = createReleaseIdAllocator();
  const first = allocator.allocate("web");
  assertEquals(allocator.allocate("web"), first);
  const worker = allocator.allocate("worker");
  assertEquals(typeof worker, "string");
  if (typeof worker !== "string") {
    throw new TypeError("expected a minted release id");
  }
  assertEquals(worker === first, false);
});

test("resolveDeploySourceMaterial returns [] when nothing is bound", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([]),
    baseParams({ services: { web: { image: "nginx:1" } } }),
  );
  assertEquals(result, []);
});

test("resolveDeploySourceMaterial skips non-object compose services", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([]),
    baseParams({
      services: {
        web: "not-a-mapping",
        api: ["also", "not"],
        worker: null,
      },
    }),
  );
  assertEquals(result, []);
});

test("a rollback of an unbound service is source_ref_unresolved", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([]),
    baseParams({
      services: { web: { image: "nginx:1" } },
      rollback: {
        composeServiceName: "web",
        releaseByService: {
          web: { releaseId: "rel-1", commitSha: SHA },
        },
      },
    }),
  );
  assertEquals(result, {
    kind: "source_ref_unresolved",
    composeServiceName: "web",
    sourceId: "",
    ref: "",
    message: "service has no x-turbopanel.source binding to roll back",
  });
});

test("a missing source row is source_ref_unresolved", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[], []]),
    baseParams(),
  );
  assertEquals(result, {
    kind: "source_ref_unresolved",
    composeServiceName: "web",
    sourceId: SOURCE_ID,
    ref: "",
    message: "repository not found in this organization",
  });
});

test("no compose branch and no source default is source_ref_unresolved", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow({ defaultBranch: null })], []]),
    baseParams(),
  );
  assertEquals(result, {
    kind: "source_ref_unresolved",
    composeServiceName: "web",
    sourceId: SOURCE_ID,
    ref: "",
    message: "no branch on the compose binding and no repository default branch",
  });
});

test("preview resolves a generic-git binding from the source default branch", async () => {
  const releaseIds = createReleaseIdAllocator();
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow({ subdirectory: "apps/web" })], []]),
    baseParams({
      services: sourcedService({
        buildCommand: "pnpm build",
        startCommand: "pnpm start",
        outputDirectory: "dist",
        buildKind: "railpack",
      }),
      releaseIds,
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected preview source material");
  }
  assertEquals(result.length, 1);
  assertEquals(result[0]?.composeServiceName, "web");
  assertEquals(result[0]?.sourceId, SOURCE_ID);
  assertEquals(result[0]?.ref, "main");
  assertEquals(result[0]?.commitSha, "main");
  assertEquals(result[0]?.subdirectory, "apps/web");
  assertEquals(result[0]?.build, {
    kind: "railpack",
    buildCommand: "pnpm build",
    startCommand: "pnpm start",
    outputDirectory: "dist",
  });
  assertEquals(result[0]?.releaseId, releaseIds.allocate("web"));
  assertEquals(result[0]?.rollbackToReleaseId, undefined);
  assertEquals(result[0]?.principal, undefined);
});

test("preview prefers the compose branch and binding subdirectory", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow({ defaultBranch: "develop" })], []]),
    baseParams({
      services: sourcedService({ branch: "release/1.4", subdirectory: "svc" }),
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected preview source material");
  }
  assertEquals(result[0]?.ref, "release/1.4");
  assertEquals(result[0]?.commitSha, "release/1.4");
  assertEquals(result[0]?.subdirectory, "svc");
  assertEquals(result[0]?.build.kind, "native");
});

test("the owning service's packageManager rides onto build.packageManager", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams({
      services: {
        web: {
          "x-turbopanel": {
            serviceKind: "node",
            packageManager: "pnpm",
            source: { sourceId: SOURCE_ID },
          },
        },
      },
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected preview source material");
  }
  assertEquals(result[0]?.build, { kind: "native", packageManager: "pnpm" });
});

test("an undeclared packageManager stays off the build", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams(),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected preview source material");
  }
  assertEquals(result[0]?.build, { kind: "native" });
});

test("preview sorts bindings and pins a webhook SHA to one source only", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([
      [
        sourceRow(),
        sourceRow({
          id: OTHER_SOURCE_ID,
          defaultBranch: "trunk",
        }),
      ],
      [],
    ]),
    baseParams({
      services: {
        ...sourcedService({ branch: "main" }, "zeta"),
        ...sourcedService({ sourceId: OTHER_SOURCE_ID }, "alpha"),
      },
      serviceRows: [
        { id: SERVICE_ID, composeServiceName: "zeta" },
        { id: `${SERVICE_ID}2`, composeServiceName: "alpha" },
      ],
      sourceSelection: {
        ref: "main",
        commitSha: SHA,
        sourceId: SOURCE_ID,
      },
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected two preview entries");
  }
  assertEquals(result.map((entry) => entry.composeServiceName), [
    "alpha",
    "zeta",
  ]);
  assertEquals(result[0]?.commitSha, "trunk");
  assertEquals(result[1]?.commitSha, SHA);
});

test("ambiguous tenancy is source_principal_ambiguous", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([
      [sourceRow()],
      [
        { principalId: PRINCIPAL_ID, serviceId: SERVICE_ID },
        { principalId: `${PRINCIPAL_ID}2`, serviceId: SERVICE_ID },
      ],
    ]),
    baseParams(),
  );
  assertEquals(result, {
    kind: "source_principal_ambiguous",
    composeServiceName: "web",
  });
});

test("a sole tenancy is pinned onto the source entry", async () => {
  const material: EnvironmentDeployPrincipalMaterial = {
    principalId: PRINCIPAL_ID,
    username: "deploy",
    uid: 10001,
    gid: 10001,
  };
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([
      [sourceRow()],
      [{ principalId: PRINCIPAL_ID, serviceId: SERVICE_ID }],
    ]),
    baseParams({ principalMaterial: [material] }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected preview source material");
  }
  assertEquals(result[0]?.principal, {
    principalId: PRINCIPAL_ID,
    username: "deploy",
    uid: 10001,
    gid: 10001,
  });
});

test("rollback reuses the pinned release and skips git", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams({
      mode: "deploy",
      rollback: {
        composeServiceName: "web",
        releaseByService: {
          web: {
            releaseId: "rel-live",
            commitSha: SHA,
            commitMessage: "feat: ship",
            commitAuthor: "Ada",
          },
        },
      },
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected rollback source material");
  }
  assertEquals(result[0]?.releaseId, "rel-live");
  assertEquals(result[0]?.rollbackToReleaseId, "rel-live");
  assertEquals(result[0]?.commitSha, SHA);
  assertEquals(result[0]?.commitMessage, "feat: ship");
  assertEquals(result[0]?.commitAuthor, "Ada");
  assertEquals(result[0]?.credential, undefined);
});

test("a pre-metadata rollback pin falls back to the ref", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams({
      rollback: {
        composeServiceName: "web",
        releaseByService: { web: { releaseId: "rel-old" } },
      },
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected rollback source material");
  }
  assertEquals(result[0]?.commitSha, "main");
  assertEquals(result[0]?.releaseId, "rel-old");
});

test("rollback only prepares services named in releaseByService", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams({
      services: {
        ...sourcedService({}, "web"),
        ...sourcedService({}, "worker"),
      },
      rollback: {
        composeServiceName: "web",
        releaseByService: { web: { releaseId: "rel-web", commitSha: SHA } },
      },
    }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected one rollback entry");
  }
  assertEquals(result.map((entry) => entry.composeServiceName), ["web"]);
});

test("deploy without a daemon key is 422", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], []]),
    baseParams({ mode: "deploy" }),
  );
  if (!(result instanceof Response)) {
    throw new TypeError("expected a 422 Response");
  }
  assertEquals(result.status, 422);
  assertEquals(await result.json(), {
    error: "No encryption-capable daemon key on target server",
  });
});

test("deploy with a revoked daemon key is 422", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow()], [daemonStateRow("2024-01-01T00:00:00.000Z")]]),
    baseParams({ mode: "deploy" }),
  );
  if (!(result instanceof Response)) {
    throw new TypeError("expected a 422 Response");
  }
  assertEquals(result.status, 422);
});

test("github without an installation becomes source_ref_unresolved", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([[sourceRow({ provider: "github" })], [daemonStateRow()], []]),
    baseParams({ mode: "deploy" }),
  );
  assertEquals(result, {
    kind: "source_ref_unresolved",
    composeServiceName: "web",
    sourceId: SOURCE_ID,
    ref: "main",
    message: "github source has no app installation",
  });
});

test("deploy without encryption secrets is 503 when a credential must be sealed", async () => {
  const result = await resolveDeploySourceMaterial(
    mockContext(),
    fakeDb([
      [sourceRow({ secretId: CREDENTIAL_ID })],
      [daemonStateRow()],
      [],
    ]),
    baseParams({ mode: "deploy" }),
  );
  if (!(result instanceof Response)) {
    throw new TypeError("expected a 503 Response");
  }
  assertEquals(result.status, 503);
  assertEquals(await result.json(), {
    error: "Encryption unavailable — no encryption key configured",
  });
});

test("deploy reseals a stored HTTPS credential as a token", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const atRest = await encryptSecret(dataEncryptionSecrets, "clone-token");
  const result = await resolveDeploySourceMaterial(
    mockContext({ secretsConfig, dataEncryptionSecrets }),
    fakeDb([
      [sourceRow({ secretId: CREDENTIAL_ID })],
      [daemonStateRow()],
      [],
      [{ secretEnvelope: atRest }],
    ]),
    baseParams({ mode: "deploy" }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected sealed source material");
  }
  assertEquals(result[0]?.credentialKind, "token");
  assertEquals(typeof result[0]?.credential, "string");
  if (typeof result[0]?.credential !== "string") {
    throw new TypeError("expected a daemon envelope");
  }
  assertEquals(isDaemonSealedEnvelope(result[0].credential), true);
});

test("deploy passes through an already-daemon-sealed SSH credential", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const already = await encryptSecretForDaemon(
    secretsConfig,
    { serverId: SERVER_ID, keyId: KEY_ID },
    "ssh-private-key",
  );
  const result = await resolveDeploySourceMaterial(
    mockContext({ secretsConfig, dataEncryptionSecrets }),
    fakeDb([
      [
        sourceRow({
          secretId: CREDENTIAL_ID,
          repositoryUrl: "git@example.com:org/app.git",
        }),
      ],
      [daemonStateRow()],
      [],
      [{ secretEnvelope: already }],
    ]),
    baseParams({ mode: "deploy" }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected sealed source material");
  }
  assertEquals(result[0]?.credentialKind, "ssh_key");
  assertEquals(result[0]?.credential, already);
});

test("deploy seals a plaintext credential for the target daemon", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const result = await resolveDeploySourceMaterial(
    mockContext({
      secretsConfig,
      dataEncryptionSecrets: await deriveEncryptionSecretsConfig(
        secretsConfig,
        "data-encryption",
      ),
    }),
    fakeDb([
      [sourceRow({ secretId: CREDENTIAL_ID })],
      [daemonStateRow()],
      [],
      [{ secretEnvelope: "plain-deploy-key" }],
    ]),
    baseParams({ mode: "deploy" }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected sealed source material");
  }
  assertEquals(result[0]?.credentialKind, "token");
  if (typeof result[0]?.credential !== "string") {
    throw new TypeError("expected a daemon envelope");
  }
  assertEquals(isDaemonSealedEnvelope(result[0].credential), true);
});

test("a missing credential row still produces a public clone entry", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const result = await resolveDeploySourceMaterial(
    mockContext({
      secretsConfig,
      dataEncryptionSecrets: await deriveEncryptionSecretsConfig(
        secretsConfig,
        "data-encryption",
      ),
    }),
    fakeDb([
      [sourceRow({ secretId: CREDENTIAL_ID })],
      [daemonStateRow()],
      [],
      [],
    ]),
    baseParams({ mode: "deploy" }),
  );
  if (!Array.isArray(result)) {
    throw new TypeError("expected public clone material");
  }
  assertEquals(result[0]?.credential, undefined);
  assertEquals(result[0]?.commitSha, "main");
});
