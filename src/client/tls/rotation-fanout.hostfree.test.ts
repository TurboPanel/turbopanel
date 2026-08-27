/**
 * Host-free coverage for Organization CA rotation target enumeration.
 * Mock queries ignore `where`; in-memory org filters must still drop foreign rows.
 */

import { assertEquals } from "@std/assert";
import { getTableName } from "drizzle-orm";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "../authn/secrets.ts";
import {
  enumerateOrganizationRotationTargets,
  parseCaRotationResults,
  parseNeedsRedeploy,
  parseResumeAfterManagedId,
  runOrganizationCaRotationFanout,
  selectManagedBatchForRotation,
} from "./rotation-fanout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const SERVER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGED_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MANAGED_B = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";

type QueryRows = {
  memberNodes: Record<string, unknown>[];
  ownedManaged: Record<string, unknown>[];
  ownedClusterMembers: Record<string, unknown>[];
  consumers: Record<string, unknown>[];
  principals?: Record<string, unknown>[];
  bindingIds?: Record<string, unknown>[];
  materializeBindings?: Record<string, unknown>[];
};

function tableName(value: unknown): string {
  try {
    return getTableName(value as never);
  } catch {
    return "";
  }
}

function rotationTargetsDb(rows: QueryRows): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        const joinNames: string[] = [];
        const resolveRows = () => {
          const fromName = tableName(table);
          const joinName = joinNames[0] ?? "";
          if (fromName === "node" && joinName === "server") {
            return rows.memberNodes;
          }
          if (fromName === "node" && joinName === "managed") {
            return rows.ownedClusterMembers;
          }
          if (fromName === "managed") return rows.ownedManaged;
          if (fromName === "principal") return rows.principals ?? [];
          if (fromName === "binding") {
            if (joinNames.length === 0) return rows.bindingIds ?? [];
            if (joinNames.includes("task")) return rows.consumers;
            if (joinNames.includes("organization")) {
              return rows.materializeBindings ?? [];
            }
            return rows.consumers;
          }
          return [];
        };
        const self = {
          innerJoin: (joinTable: unknown) => {
            joinNames.push(tableName(joinTable));
            return self;
          },
          leftJoin: (joinTable: unknown) => {
            joinNames.push(tableName(joinTable));
            return self;
          },
          where: () => self,
          limit: () => self,
          orderBy: () => Promise.resolve(resolveRows()),
          then: (
            onFulfilled?: (value: Record<string, unknown>[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(resolveRows()).then(onFulfilled, onRejected),
        };
        return self;
      },
    }),
  } as unknown as Db;
}

test("selectManagedBatchForRotation pages by id and reports completion", () => {
  const ids = ["a", "b", "c", "d"];
  assertEquals(selectManagedBatchForRotation(ids, undefined, 2), {
    batch: ["a", "b"],
    nextCursor: "b",
    complete: false,
  });
  assertEquals(selectManagedBatchForRotation(ids, "b", 2), {
    batch: ["c", "d"],
    nextCursor: null,
    complete: true,
  });
  assertEquals(selectManagedBatchForRotation([], undefined, 10), {
    batch: [],
    nextCursor: null,
    complete: true,
  });
});

test("parseCaRotationResults and parseResumeAfterManagedId ignore malformed entries", () => {
  assertEquals(parseCaRotationResults(null), []);
  assertEquals(
    parseCaRotationResults([
      { serverId: "s1", kind: "ingress", status: "queued", commandId: "c1" },
      {
        serverId: "s2",
        kind: "binding",
        status: "failed",
        error: "binding_ca_unavailable",
      },
      { serverId: "s2", kind: "nope", status: "queued" },
      { status: "queued" },
    ]),
    [
      { serverId: "s1", kind: "ingress", status: "queued", commandId: "c1" },
      {
        serverId: "s2",
        kind: "binding",
        status: "failed",
        error: "binding_ca_unavailable",
      },
    ],
  );
  assertEquals(
    parseResumeAfterManagedId({ resumeAfterManagedId: "mid-1" }),
    "mid-1",
  );
  assertEquals(
    parseResumeAfterManagedId({ resumeAfterManagedId: "" }),
    undefined,
  );
  assertEquals(parseResumeAfterManagedId(null), undefined);
  assertEquals(
    parseNeedsRedeploy({
      needsRedeploy: [
        { serverId: "s1", environmentId: "e1" },
        { serverId: 1 },
      ],
    }),
    [{ serverId: "s1", environmentId: "e1" }],
  );
  assertEquals(parseNeedsRedeploy(null), []);
});

test("enumerateOrganizationRotationTargets drops blank member ids", async () => {
  const db = rotationTargetsDb({
    memberNodes: [
      { serverId: "", managedId: MANAGED_A, serverOrganizationId: ORG_A },
      { serverId: SERVER_A, managedId: "", serverOrganizationId: ORG_A },
    ],
    ownedManaged: [],
    ownedClusterMembers: [],
    consumers: [],
  });
  const targets = await enumerateOrganizationRotationTargets(db, ORG_A);
  assertEquals(targets.members, []);
  assertEquals(targets.managedIds, []);
  assertEquals(targets.ingressServerIds, []);
});

test("enumerateOrganizationRotationTargets never returns another org's node or managed ids", async () => {
  const db = rotationTargetsDb({
    memberNodes: [
      { serverId: SERVER_A, managedId: MANAGED_A, serverOrganizationId: ORG_A },
      { serverId: SERVER_B, managedId: MANAGED_B, serverOrganizationId: ORG_B },
    ],
    ownedManaged: [
      { id: MANAGED_A, workspaceOrganizationId: ORG_A },
      { id: MANAGED_B, workspaceOrganizationId: ORG_B },
    ],
    ownedClusterMembers: [
      {
        serverId: SERVER_A,
        managedId: MANAGED_A,
        workspaceOrganizationId: ORG_A,
      },
      {
        serverId: SERVER_B,
        managedId: MANAGED_B,
        workspaceOrganizationId: ORG_B,
      },
    ],
    consumers: [
      {
        managedId: MANAGED_A,
        environmentServerId: SERVER_A,
        projectOptions: null,
        taskServerId: null,
        workspaceOrganizationId: ORG_A,
      },
      {
        managedId: MANAGED_B,
        environmentServerId: SERVER_B,
        projectOptions: null,
        taskServerId: null,
        workspaceOrganizationId: ORG_B,
      },
    ],
  });

  const targets = await enumerateOrganizationRotationTargets(db, ORG_A);
  assertEquals(targets.managedIds, [MANAGED_A]);
  assertEquals(targets.ingressServerIds, [SERVER_A]);
  assertEquals(targets.members.every((row) => row.serverId !== SERVER_B), true);
  assertEquals(
    targets.members.every((row) => row.managedId !== MANAGED_B),
    true,
  );
  assertEquals(
    targets.members.some((row) =>
      row.serverId === SERVER_A && row.managedId === MANAGED_A
    ),
    true,
  );
});

test("runOrganizationCaRotationFanout completes with empty results when the org has no targets", async () => {
  const db = rotationTargetsDb({
    memberNodes: [],
    ownedManaged: [],
    ownedClusterMembers: [],
    consumers: [],
  });
  const outcome = await runOrganizationCaRotationFanout(
    {} as never,
    db,
    { enqueue: () => Promise.resolve() } as CommandQueue,
    {
      organizationId: ORG_A,
      secretsConfig: {} as SecretsConfig,
      dataEncryptionSecrets: {} as DerivedSecretsConfig,
      actorType: "user",
      actorId: "user-1",
    },
  );
  assertEquals(outcome.complete, true);
  assertEquals(outcome.results, []);
  assertEquals(outcome.needsRedeploy, []);
  assertEquals(outcome.cursor, null);
});

test("runOrganizationCaRotationFanout records binding rematerialize failure and skips needsRedeploy", async () => {
  const db = rotationTargetsDb({
    memberNodes: [],
    ownedManaged: [{
      id: MANAGED_A,
      workspaceOrganizationId: ORG_A,
      environmentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      serverId: SERVER_A,
      engine: null,
    }],
    ownedClusterMembers: [],
    consumers: [],
    principals: [{ id: "p1" }],
    bindingIds: [{ id: "b1" }],
    materializeBindings: [{ id: "b1" }],
  });
  const outcome = await runOrganizationCaRotationFanout(
    {} as never,
    db,
    { enqueue: () => Promise.resolve() } as CommandQueue,
    {
      organizationId: ORG_A,
      secretsConfig: {} as SecretsConfig,
      dataEncryptionSecrets: {} as DerivedSecretsConfig,
      actorType: "user",
      actorId: "user-1",
    },
  );
  assertEquals(outcome.complete, false);
  assertEquals(outcome.needsRedeploy, []);
  assertEquals(
    outcome.results.some((row) =>
      row.kind === "binding" &&
      row.managedId === MANAGED_A &&
      row.status === "failed" &&
      row.error === "binding_principal_invalid"
    ),
    true,
  );
});
